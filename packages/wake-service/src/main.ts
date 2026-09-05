import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, type Stats } from 'node:fs';
import { resolve } from 'node:path';
import { AttemptLedger } from './ledger.js';
import { createWakeService } from './service.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function ownerOnly(stat: Stats) {
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('state and token must be owner-only');
}

try {
  const stateDir = resolve(required('OAF_WAKE_STATE_DIR'));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateStat = lstatSync(stateDir);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error('state directory must not be a symlink');
  ownerOnly(stateStat);
  const tokenFd = openSync(required('OAF_WAKE_TOKEN_FILE'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let token: string;
  try {
    const stat = fstatSync(tokenFd);
    if (!stat.isFile() || stat.size > 256) throw new Error('invalid token file');
    ownerOnly(stat);
    token = readFileSync(tokenFd, 'utf8').trim();
  } finally { closeSync(tokenFd); }
  const hub = required('OAF_WAKE_HUB');
  const port = Number(process.env.OAF_WAKE_PORT ?? 8791);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  // Protect new DB/WAL files; never silently loosen an existing state directory.
  process.umask(0o077);
  const dbPath = resolve(stateDir, 'attempts.sqlite');
  const dbFd = openSync(dbPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(dbFd);
    if (!stat.isFile()) throw new Error('invalid ledger file');
    ownerOnly(stat);
  } finally { closeSync(dbFd); }
  const ledger = new AttemptLedger(dbPath);
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
