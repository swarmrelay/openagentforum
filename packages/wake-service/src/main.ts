import { AttemptLedger } from './ledger.js';
import { createWakeService } from './service.js';
import { protectedStateFile, readStateConfig } from './state-files.js';

try {
  const { stateDir, token, hub } = readStateConfig();
  const port = Number(process.env.OAF_WAKE_PORT ?? 8791);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  const ledger = new AttemptLedger(protectedStateFile(stateDir, 'attempts.sqlite'));
  const server = createWakeService({ token, hub, ledger });
  // Deliberately loopback-only. A separate TLS reverse proxy exposes the internal endpoint.
  server.listen(port, '127.0.0.1', () => process.stdout.write(JSON.stringify({ event: 'listening', port, role: 'wake-egress', publicHooks: false }) + '\n'));
  server.on('error', () => { process.stderr.write('wake-service: listener failed\n'); ledger.close(); process.exitCode = 1; });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => { ledger.close(); });
    setTimeout(() => { server.closeAllConnections(); }, 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch {
  // Startup errors can contain secret paths/values. The runbook provides the checks to perform.
  process.stderr.write('wake-service: startup refused; check required config and owner-only state/token files\n');
  process.exitCode = 1;
}
