import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { createLogger } from '@aztec-labs/foundation/log';
import { retryFastUntil } from '@aztec-labs/foundation/retry';
import { sleep } from '@aztec-labs/foundation/sleep';
import { jest } from '@jest/globals';
import { Agent, request } from 'node:http';

import { SessionLifetimeTracker, startTXEHttpServer } from './rpc_server.js';
import type { TXEOracleFunctionName } from './txe_session.js';
import type { ForeignCallArgs, ForeignCallResult } from './utils/encoding.js';

// How long the server under test keeps a session whose test has disconnected.
const RECONNECT_GRACE_MS = 2_000;
// Longer than Node keeps an idle connection open by default, which cannot be shortened for the test.
const NODE_DEFAULT_IDLE_MS = 7_000;

describe('SessionLifetimeTracker', () => {
  let disposed: number[];
  let tracker: SessionLifetimeTracker;

  beforeEach(() => {
    jest.useFakeTimers();
    disposed = [];
    tracker = new SessionLifetimeTracker(sessionId => disposed.push(sessionId), RECONNECT_GRACE_MS);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('disposes a session once nothing has used it for the grace period', () => {
    tracker.acquire(1);
    tracker.release(1);

    jest.advanceTimersByTime(RECONNECT_GRACE_MS - 1);
    expect(disposed).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(disposed).toEqual([1]);
  });

  it('keeps a session that is used again within the grace period', () => {
    tracker.acquire(1);
    tracker.release(1);
    jest.advanceTimersByTime(RECONNECT_GRACE_MS - 1);

    tracker.acquire(1);
    jest.advanceTimersByTime(10 * RECONNECT_GRACE_MS);

    expect(disposed).toEqual([]);
  });

  it('keeps a session while a call is in flight after its connection has closed', () => {
    tracker.acquire(1); // the connection
    tracker.acquire(1); // a call
    tracker.release(1); // the connection closes
    jest.advanceTimersByTime(10 * RECONNECT_GRACE_MS);
    expect(disposed).toEqual([]);

    tracker.release(1); // the call returns
    jest.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(disposed).toEqual([1]);
  });

  it('refuses to use a session it has disposed', () => {
    tracker.acquire(1);
    tracker.release(1);
    jest.advanceTimersByTime(RECONNECT_GRACE_MS);

    expect(() => tracker.acquire(1)).toThrow(/was disposed/);
    expect(() => tracker.acquire(2)).not.toThrow();
  });
});

describe('TXE HTTP server', () => {
  let server: Awaited<ReturnType<typeof startTXEHttpServer>>;
  let savedWorkers: string | undefined;
  let nextSessionId = 1;
  let agents: Agent[] = [];
  let connectionsAccepted = 0;

  beforeAll(async () => {
    // Runs the dispatcher in this process: the worker pool needs the worker bundle, which only a build produces.
    savedWorkers = process.env.TXE_WORKERS;
    process.env.TXE_WORKERS = '1';
    server = await startTXEHttpServer(createLogger('txe:test'), {
      host: '127.0.0.1',
      reconnectGraceMs: RECONNECT_GRACE_MS,
    });
    server.on('connection', () => connectionsAccepted++);
  });

  afterEach(async () => {
    await disconnectAll();
  });

  afterAll(async () => {
    await server.stopSessions();
    await new Promise(resolve => server.close(resolve));
    if (savedWorkers === undefined) {
      delete process.env.TXE_WORKERS;
    } else {
      process.env.TXE_WORKERS = savedWorkers;
    }
  });

  /** Opens a kept-alive connection, like the one nargo holds for a test. */
  const connect = () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);
    return agent;
  };

  /** Closes every connection and waits for the server to have noticed. */
  const disconnectAll = async () => {
    for (const agent of agents) {
      agent.destroy();
    }
    agents = [];
    const openConnections = () => new Promise<number>(resolve => server.getConnections((_, count) => resolve(count)));
    await retryFastUntil(async () => (await openConnections()) === 0, 'connections closed');
  };

  const callOracle = (agent: Agent, sessionId: number, oracle: TXEOracleFunctionName, inputs: ForeignCallArgs = []) =>
    new Promise<ForeignCallResult>((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resolve_foreign_call',
        // eslint-disable-next-line camelcase
        params: [{ session_id: sessionId, function: oracle, root_path: '', package_name: '', inputs }],
      });
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          method: 'POST',
          agent,
          headers: { 'content-type': 'application/json' },
        },
        res => {
          let data = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            const { result, error } = JSON.parse(data);
            return error ? reject(new Error(error.message)) : resolve(result);
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  /** Starts a session whose next block number differs from that of a new session. */
  const startSession = async (agent: Agent) => {
    const sessionId = nextSessionId++;
    const initial = await callOracle(agent, sessionId, 'aztec_txe_getNextBlockNumber');
    await callOracle(agent, sessionId, 'aztec_txe_advanceBlocksBy', [new Fr(3).toString()]);
    const advanced = await callOracle(agent, sessionId, 'aztec_txe_getNextBlockNumber');
    expect(advanced).not.toEqual(initial);
    return { sessionId, initial, advanced };
  };

  it('keeps the state of a test that makes no oracle call for a while', async () => {
    const agent = connect();
    const { sessionId, advanced } = await startSession(agent);
    const connectionsBefore = connectionsAccepted;

    await sleep(NODE_DEFAULT_IDLE_MS);

    expect(await callOracle(agent, sessionId, 'aztec_txe_getNextBlockNumber')).toEqual(advanced);
    // The call went over the connection the test already had: the server did not close it for being idle.
    expect(connectionsAccepted).toEqual(connectionsBefore);
  }, 60_000);

  it('keeps the state of a test that reconnects', async () => {
    const { sessionId, advanced } = await startSession(connect());

    await disconnectAll();

    expect(await callOracle(connect(), sessionId, 'aztec_txe_getNextBlockNumber')).toEqual(advanced);
  }, 60_000);

  it('keeps the sessions of two tests that share a connection', async () => {
    const agent = connect();
    const first = await startSession(agent);
    const second = await startSession(agent);

    // A session that only its calls kept alive would be disposed by now; the open connection has to keep both.
    await sleep(2 * RECONNECT_GRACE_MS);
    await disconnectAll();

    const reconnected = connect();
    expect(await callOracle(reconnected, first.sessionId, 'aztec_txe_getNextBlockNumber')).toEqual(first.advanced);
    expect(await callOracle(reconnected, second.sessionId, 'aztec_txe_getNextBlockNumber')).toEqual(second.advanced);
  }, 60_000);

  it('rejects a call on the session of a test that has long disconnected, instead of starting a new one', async () => {
    const { sessionId } = await startSession(connect());

    await disconnectAll();

    // Polling with calls would keep the session alive, so this waits out the grace period.
    await sleep(2 * RECONNECT_GRACE_MS);

    await expect(callOracle(connect(), sessionId, 'aztec_txe_getNextBlockNumber')).rejects.toThrow(/was disposed/);
  }, 60_000);

  it('disposes the sessions of connected tests when it is stopped', async () => {
    const agent = connect();
    const { sessionId, initial } = await startSession(agent);

    await server.stopSessions();

    // The state is gone: the next call starts the session afresh.
    expect(await callOracle(agent, sessionId, 'aztec_txe_getNextBlockNumber')).toEqual(initial);
  }, 60_000);
});
