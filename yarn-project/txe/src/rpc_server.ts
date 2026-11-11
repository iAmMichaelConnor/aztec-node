import { LruSet } from '@aztec-labs/foundation/collection';
import { getEnv } from '@aztec-labs/foundation/config/env';
import { createSafeJsonRpcServer, startHttpRpcServer } from '@aztec-labs/foundation/json-rpc/server';
import type { Logger } from '@aztec-labs/foundation/log';
import type { Socket } from 'node:net';

import { TXEDispatcherPool, buildSharedContractStore } from './dispatcher_pool.js';
import { TXEDispatcher, TXEDispatcherApiSchema } from './index.js';

/**
 * Symbol used to tag an incoming TCP socket with the `session_id` it has been associated with.
 * Hidden under a Symbol so we don't risk colliding with anything koa or http core adds.
 */
const SESSION_SYMBOL = Symbol('txeSessionId');

type TaggedSocket = Socket & { [SESSION_SYMBOL]?: number };

/** How long a single oracle call may take. */
const ORACLE_CALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long a test may go without an oracle call, e.g. while it computes, before its connection is closed. A client
 * that vanishes without closing its connection keeps its session for this long.
 */
const IDLE_CONNECTION_TIMEOUT_MS = 60 * 60 * 1000;

/** How long a session outlives its test's last connection, so that a test that reconnects finds its session. */
const SESSION_RECONNECT_GRACE_MS = 1000;

/** How many disposed sessions are remembered, to reject a call that would silently start one of them afresh. */
const DISPOSED_SESSIONS_REMEMBERED = 100_000;

/**
 * Disposes a session once the test that owns it has disconnected.
 *
 * nargo holds one connection per test, but replaces it after it has been idle for long enough, closing the old
 * connection just before the next oracle call arrives on a new one. A session is therefore kept for a grace period
 * after its last connection has closed and its last oracle call has finished, and is disposed only if it has not been
 * used again by then.
 *
 * A connection is expected to serve a single session, as nargo's do: a session that shares a connection tagged for
 * another one is disposed a grace period after each of its oracle calls.
 */
export class SessionLifetimeTracker {
  /** Number of open connections and oracle calls in flight, by session. */
  private readonly uses = new Map<number, number>();
  /** Pending disposals of the sessions that are not in use, by session. */
  private readonly disposals = new Map<number, NodeJS.Timeout>();
  private readonly disposed = new LruSet<number>(DISPOSED_SESSIONS_REMEMBERED);

  constructor(
    private readonly disposeSession: (sessionId: number) => void,
    private readonly reconnectGraceMs: number,
  ) {}

  /**
   * Marks the session as in use by a connection or an oracle call, until the matching {@link release}. Throws if the
   * session was disposed: its test would otherwise carry on against a new, empty session.
   */
  public acquire(sessionId: number) {
    if (this.disposed.has(sessionId)) {
      throw new Error('The test environment of this test was disposed after the test disconnected.');
    }
    clearTimeout(this.disposals.get(sessionId));
    this.disposals.delete(sessionId);
    this.uses.set(sessionId, (this.uses.get(sessionId) ?? 0) + 1);
  }

  /** Ends a use of the session. The session is disposed if nothing uses it again within the grace period. */
  public release(sessionId: number) {
    const remaining = (this.uses.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      this.uses.set(sessionId, remaining);
      return;
    }
    this.uses.delete(sessionId);
    const disposal = setTimeout(() => {
      this.disposals.delete(sessionId);
      this.disposed.add(sessionId);
      this.disposeSession(sessionId);
    }, this.reconnectGraceMs);
    this.disposals.set(sessionId, disposal.unref());
  }
}

/**
 * Creates the TXE RPC server. With `TXE_WORKERS=1` oracle calls run on the main thread (no
 * worker_threads, no IPC overhead). With any other value oracle calls are
 * routed to a pool of worker threads sized to that value, sticky by `session_id`.
 *
 * Each incoming TCP socket is tagged with the `session_id` of the first oracle call it carries. Once the test has
 * disconnected (see {@link SessionLifetimeTracker}), the dispatcher disposes the session and frees its world state +
 * LMDB.
 *
 * Lives in its own module so the worker bundle does not pull in the HTTP server stack.
 */
export async function createTXERpcServer(
  logger: Logger,
  { reconnectGraceMs = SESSION_RECONNECT_GRACE_MS }: { reconnectGraceMs?: number } = {},
) {
  const workerCount = Number(getEnv().TXE_WORKERS);
  let dispatcher: TXEDispatcher | TXEDispatcherPool;
  if (workerCount === 1) {
    const { dataDir, schnorrClassId } = await buildSharedContractStore();
    dispatcher = new TXEDispatcher(logger, { contractStoreSourceDir: dataDir, schnorrClassId });
  } else {
    dispatcher = new TXEDispatcherPool(logger, {
      workers: Number.isFinite(workerCount) && workerCount > 1 ? workerCount : undefined,
    });
  }
  const disposeSession = async (sessionId: number) => {
    logger.debug(`Disposing session of a disconnected test`, { sessionId });
    try {
      await dispatcher.disposeSession(sessionId);
    } catch (err) {
      // Expected for a session that was never created, e.g. when its only request was invalid.
      logger.debug(`Failed to dispose session`, { sessionId, err });
    }
  };
  const tracker = new SessionLifetimeTracker(sessionId => void disposeSession(sessionId), reconnectGraceMs);
  const trackedDispatcher: Pick<TXEDispatcher, keyof typeof TXEDispatcherApiSchema> = {
    // eslint-disable-next-line camelcase
    resolve_foreign_call: async callData => {
      tracker.acquire(callData.session_id);
      try {
        return await dispatcher.resolve_foreign_call(callData);
      } finally {
        tracker.release(callData.session_id);
      }
    },
    disposeSession,
  };
  const server = createSafeJsonRpcServer(trackedDispatcher, TXEDispatcherApiSchema, {
    http200OnError: true,
    middlewares: [
      async (ctx, next) => {
        // The body parser runs further down the chain, so `ctx.request.body` is populated only
        // after `next()` resolves.
        await next();
        const socket = ctx.req.socket as TaggedSocket;
        if (socket[SESSION_SYMBOL] !== undefined) {
          return;
        }
        const body = (ctx.request as { body?: unknown }).body;
        const sessionId =
          body && typeof body === 'object' && 'params' in body
            ? extractSessionId((body as { params: unknown }).params)
            : undefined;
        if (sessionId === undefined) {
          return;
        }
        socket[SESSION_SYMBOL] = sessionId;
        logger.debug(`Tagged socket with session`, {
          sessionId,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
        });
        try {
          tracker.acquire(sessionId);
        } catch {
          // The call on this connection was already rejected for using a disposed session.
          return;
        }
        if (socket.destroyed) {
          tracker.release(sessionId);
        } else {
          socket.once('close', () => tracker.release(sessionId));
        }
      },
    ],
  });
  return server;
}

/**
 * Creates the TXE RPC server and serves it over HTTP.
 *
 * A session lives only while its test is connected, so a connection is kept open while its test is busy between
 * oracle calls instead of being closed after Node's default keep-alive timeout of about five seconds.
 *
 * @param options.reconnectGraceMs - Overrides how long a session outlives its last connection. For tests.
 */
export async function startTXEHttpServer(
  logger: Logger,
  options: { host?: string; port?: number | string; reconnectGraceMs?: number } = {},
) {
  const { reconnectGraceMs, ...httpOptions } = options;
  const txeServer = await createTXERpcServer(logger, { reconnectGraceMs });
  return startHttpRpcServer(txeServer, {
    ...httpOptions,
    timeoutMs: ORACLE_CALL_TIMEOUT_MS,
    keepAliveTimeoutMs: IDLE_CONNECTION_TIMEOUT_MS,
  });
}

// Extracts `session_id` from a JSON-RPC `params` array. Always a `number` because session_id
// comes off `JSON.parse`, which never produces BigInt; values above MAX_SAFE_INTEGER lose
// precision but still work as a Map key.
function extractSessionId(params: unknown): number | undefined {
  if (!Array.isArray(params) || params.length === 0) {
    return undefined;
  }
  const first = params[0];
  if (first && typeof first === 'object' && 'session_id' in first) {
    const sid = (first as { session_id: unknown }).session_id;
    return typeof sid === 'number' ? sid : undefined;
  }
  return undefined;
}
