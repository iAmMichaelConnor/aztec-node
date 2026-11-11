import type { Logger } from '@aztec-labs/foundation/log';
import { startTXEHttpServer } from '@aztec-labs/txe/server';

export async function startTXE(options: any, signalHandlers: Array<() => Promise<void>>, debugLogger: Logger) {
  debugLogger.info(`Setting up TXE...`);

  const httpServer = await startTXEHttpServer(debugLogger, { port: options.port });

  signalHandlers.push(() => httpServer.stopSessions());
  signalHandlers.push(() => new Promise<void>(resolve => httpServer.close(() => resolve())));

  debugLogger.info(`TXE listening on port ${httpServer.port}`);
}
