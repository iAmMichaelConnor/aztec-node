import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { createLogger } from '@aztec-labs/foundation/log';
import { sleep } from '@aztec-labs/foundation/sleep';
import { jest } from '@jest/globals';
import { Agent, type Server, createServer, request } from 'node:http';

import { SessionLifetimeTracker, startTXEHttpServer } from './rpc_server.js';
import type { TXEOracleFunctionName } from './txe_session.js';
import type { ForeignCallArgs, ForeignCallResult } from './utils/encoding.js';

// How long the server under test keeps a session whose test has disconnected.
const RECONNECT_GRACE_MS = 1_000;
// Long enough for the server to notice a closed connection, and well within the grace period.
const DISCONNECT_MS = 50;

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
  let server: Server & { port: number };
  let savedWorkers: string | undefined;
  let nextSessionId = 1;
  const agents: Agent[] = [];

  beforeAll(async () => {
    // Runs the dispatcher in this process, so the test needs no worker bundle.
    savedWorkers = process.env.TXE_WORKERS;
    process.env.TXE_WORKERS = '1';
    server = await startTXEHttpServer(createLogger('txe:test'), {
      host: '127.0.0.1',
      reconnectGraceMs: RECONNECT_GRACE_MS,
    });
  });

  afterAll(async () => {
    for (const agent of agents) {
      agent.destroy();
    }
    // Lets the sessions of the connections closed above be disposed.
    await sleep(2 * RECONNECT_GRACE_MS);
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
    return { sessionId, advanced };
  };

  it('keeps an idle connection open far longer than Node does by default', () => {
    expect(server.keepAliveTimeout).toBeGreaterThan(100 * createServer().keepAliveTimeout);
  });

  it('keeps the state of a test that reconnects', async () => {
    const agent = connect();
    const { sessionId, advanced } = await startSession(agent);

    agent.destroy();
    await sleep(DISCONNECT_MS);

    expect(await callOracle(connect(), sessionId, 'aztec_txe_getNextBlockNumber')).toEqual(advanced);
  }, 60_000);

  it('rejects a call on the session of a test that has long disconnected, instead of starting a new one', async () => {
    const agent = connect();
    const { sessionId } = await startSession(agent);

    agent.destroy();
    await sleep(2 * RECONNECT_GRACE_MS);

    await expect(callOracle(connect(), sessionId, 'aztec_txe_getNextBlockNumber')).rejects.toThrow(/was disposed/);
  }, 60_000);
});
