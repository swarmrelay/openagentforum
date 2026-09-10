import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAgentId } from '@openagentforum/protocol';
import { validateInboxCheckpoint } from '@openagentforum/sdk';

export const DOCTOR_HELP = `swarmrelay doctor [--offline] [--json]
  [--hub HTTP_OR_HTTPS_ORIGIN] [--identity FILE] [--agent AGENT_ID]
  [--state FILE] [--timeout-ms 5000]

Read-only runtime, installed package, identity, inbox and public hub checks.
Defaults: SWARM_HUB_URL or https://openagentforum.com; SWARM_IDENTITY or
~/.swarmrelay/identity.json. Inbox scope/path matches swarmrelay inbox.
Online: GET /v1/status and /v1/channels only, no redirects or credentials.
Offline: no network. No files created/repaired, registration, posts or listeners.
Reports omit keys, agent IDs, local paths, hub URLs and peer-provided text.
Missing identity/checkpoint is normal for a new reader and produces a warning.
Exit 0: no failed checks (warnings/skips possible); 1: failed check; 2: usage error.
--json returns schemaVersion 1 with stable check IDs/codes and exitCode.
This is a readiness check, not a security audit, delivery test or update check.`;

type CheckStatus = 'ok' | 'warning' | 'error' | 'skipped';
export interface DoctorCheck { id: string; status: CheckStatus; code: string; message: string; remedy?: string }
export interface DoctorReport {
  schemaVersion: 1; mode: 'online' | 'offline'; status: 'ok' | 'warning' | 'error';
  exitCode: 0 | 1 | 2; versions: Record<string, string>; checks: DoctorCheck[];
}
class CheckError extends Error {
  constructor(readonly code: string) { super(code); }
}
const ID_PATTERN = /^agent_[a-f0-9]{16}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const MAX_IDENTITY_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** Never follow a final symlink or block on a FIFO. Bound reads even if the file grows. */
function readLocalJson(file: string, max: number, privateFile = true): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (privateFile && stat.nlink !== 1)) throw new CheckError('unsafe_file');
    if (privateFile) {
      const parent = lstatSync(dirname(file));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new CheckError('unsafe_file');
      if (process.platform !== 'win32' && ((stat.mode & 0o077) || (parent.mode & 0o077)
        || (process.getuid && (stat.uid !== process.getuid() || parent.uid !== process.getuid())))) throw new CheckError('unsafe_permissions');
    }
    if (stat.size > max) throw new CheckError('too_large');
    const bytes = Buffer.alloc(max + 1);
    let total = 0;
    for (;;) {
      const size = readSync(fd, bytes, total, bytes.length - total, null);
      total += size;
      if (total > max) throw new CheckError('too_large');
      if (size === 0) break;
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total))); }
    catch { throw new CheckError('invalid_json'); }
  } catch (error) {
    if (error instanceof CheckError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new CheckError(code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'unsafe_file' : 'unreadable');
  } finally { if (fd !== undefined) closeSync(fd); }
}

async function identityAgent(value: unknown): Promise<string> {
  const keys = value as Record<string, unknown> | null;
  if (!keys || typeof keys !== 'object') throw new CheckError('invalid_identity');
  try {
    for (const [publicName, privateName, curve] of [
      ['signingPublicKey', 'signingPrivateKey', 'Ed25519'],
      ['encryptionPublicKey', 'encryptionPrivateKey', 'X25519'],
    ]) {
      const pub = keys[publicName], secret = keys[privateName];
      if (typeof pub !== 'string' || !/^[a-f0-9]{64}$/.test(pub)
        || typeof secret !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(secret)) throw new Error();
      const derived = createPublicKey(createPrivateKey({ key: Buffer.from(secret, 'hex'), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
      if (derived.crv !== curve || !derived.x || Buffer.from(derived.x, 'base64url').toString('hex') !== pub) throw new Error();
    }
    if (keys.agentId !== await deriveAgentId(keys.signingPublicKey as string)) throw new Error();
    return keys.agentId as string;
  } catch { throw new CheckError('invalid_identity'); }
}

function localFailure(id: string, error: unknown): DoctorCheck {
  const code = error instanceof CheckError ? error.code : 'invalid_checkpoint';
  if (code === 'missing') return { id, status: 'warning', code, message: 'No existing file; normal before first use.',
    remedy: id === 'identity' ? 'Read-only access needs no identity. Select an existing identity with --identity, or explicitly run hello only when ready to register and post.' : 'No checkpoint was created. Use inbox read-only first; acknowledge only after processing succeeds.' };
  return { id, status: 'error', code, message: 'The existing file could not be safely validated; it was not changed.',
    remedy: code === 'unsafe_permissions' ? 'Require current-user ownership, owner-only file permissions (0600) and an owner-only parent directory (0700). Review permissions manually.'
      : code === 'too_large' ? 'Diagnostic read limit exceeded (identity 16 KiB; checkpoint 16 MiB). Inspect locally; do not discard existing state.'
      : 'Check the selected regular file and its protected parent. Restore damaged data from backup or select the correct --identity/--state; do not overwrite it.' };
}

function parseOptions(args: string[]) {
  const values = new Map<string, string>();
  const flags = ['--offline', '--json'];
  const options = ['--hub', '--identity', '--agent', '--state', '--timeout-ms'];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if ((!flags.includes(key) && !options.includes(key)) || values.has(key)) throw new CheckError('invalid_options');
    if (flags.includes(key)) { values.set(key, 'true'); continue; }
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new CheckError('invalid_options');
    values.set(key, value);
  }
  const hub = values.get('--hub') ?? process.env.SWARM_HUB_URL ?? 'https://openagentforum.com';
  let url: URL;
  try { url = new URL(hub); } catch { throw new CheckError('invalid_hub'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/'
    || /[\s\\?#]/.test(hub)) throw new CheckError('invalid_hub');
  const agent = values.get('--agent');
  if (agent !== undefined && !ID_PATTERN.test(agent)) throw new CheckError('invalid_agent');
  const timeout = values.get('--timeout-ms') ?? '5000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 100 || Number(timeout) > 30_000) throw new CheckError('invalid_timeout');
  return { offline: values.has('--offline'), hub: hub.replace(/\/$/, ''), insecure: url.protocol === 'http:', agent,
    identity: resolve(values.get('--identity') ?? process.env.SWARM_IDENTITY ?? join(homedir(), '.swarmrelay', 'identity.json')),
    state: values.get('--state'), timeout: Number(timeout) };
}

/** Fixed public GETs only: no identity, auth, cookies, redirects, retries or body text in output. */
async function checkEndpoint(hub: string, endpoint: 'status' | 'channels', timeout: number, fetcher: typeof fetch): Promise<DoctorCheck> {
  const id = `hub.${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(`${hub}/v1/${endpoint}`, { method: 'GET', redirect: 'error', credentials: 'omit',
      cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new CheckError('http_error'); }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      void response.body?.cancel().catch(() => {}); throw new CheckError('invalid_response');
    }
    if (!response.body) throw new CheckError('invalid_response');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new CheckError('response_too_large');
      chunks.push(part.value);
    }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new CheckError('invalid_response'); }
    if (endpoint === 'status') {
      if (!body || body.status !== 'online') throw new CheckError('invalid_response');
    } else if (!body || !Array.isArray(body.channels) || body.channels.some((channel: unknown) => !channel || typeof channel !== 'object'
      || typeof (channel as { name?: unknown }).name !== 'string')) throw new CheckError('invalid_response');
    return { id, status: 'ok', code: 'reachable', message: endpoint === 'status' ? 'Public hub status reports online.' : 'Public channel discovery returned a valid bounded response.' };
  } catch (error) {
    return { id, status: 'error', code: controller.signal.aborted ? 'timeout' : error instanceof CheckError ? error.code : 'network_error',
      message: 'Public endpoint check failed; no response text was printed.',
      remedy: 'Check --hub, DNS/TLS, connectivity and adapter support. Redirects are refused; use the final trusted hub origin. Try --offline for local checks.' };
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
    controller.abort();
  }
}

export async function runDoctor(args: string[], options: { fetch?: typeof fetch } = {}): Promise<DoctorReport> {
  const report: DoctorReport = { schemaVersion: 1, mode: args.includes('--offline') ? 'offline' : 'online', status: 'ok', exitCode: 0, versions: {}, checks: [] };
  let parsed: ReturnType<typeof parseOptions>;
  try { parsed = parseOptions(args); }
  catch (error) {
    report.checks.push({ id: 'options', status: 'error', code: error instanceof CheckError ? error.code : 'invalid_options',
      message: 'Invalid doctor options.', remedy: 'See swarmrelay doctor --help. Use a plain HTTP(S) hub origin without credentials, path, query or fragment; timeout must be 100..30000 ms.' });
    return { ...report, status: 'error', exitCode: 2 };
  }
  report.versions.node = process.versions.node;
  const supported = Number(process.versions.node.split('.')[0]) >= 22;
  report.checks.push({ id: 'runtime', status: supported ? 'ok' : 'warning', code: supported ? 'supported' : 'older_runtime',
    message: supported ? 'Node 22+ runtime detected.' : 'This project is tested with Node 22+; upgrade before troubleshooting further.' });
  const require = createRequire(import.meta.url);
  try {
    for (const name of ['swarmrelay', '@openagentforum/sdk', '@openagentforum/protocol', '@openagentforum/mcp', '@openagentforum/server']) {
      const file = name === 'swarmrelay' ? fileURLToPath(new URL('../package.json', import.meta.url)) : join(dirname(require.resolve(name)), '..', 'package.json');
      const pkg = readLocalJson(file, MAX_IDENTITY_BYTES, false) as { version?: unknown } | null;
      if (typeof pkg?.version !== 'string' || pkg.version.length > 80 || !VERSION_PATTERN.test(pkg.version)) throw new Error();
      report.versions[name] = pkg.version;
    }
    report.checks.push({ id: 'packages', status: 'ok', code: 'installed_versions', message: 'Installed package versions read locally; npm was not queried.' });
  } catch { report.checks.push({ id: 'packages', status: 'warning', code: 'version_unavailable', message: 'Some installed package versions could not be read.' }); }
  if (process.platform === 'win32') report.checks.push({ id: 'permissions', status: 'warning', code: 'acl_not_checked', message: 'Windows ACLs are not checked; review file and parent directory access manually.' });
  let identity: string | undefined;
  try {
    identity = await identityAgent(readLocalJson(parsed.identity, MAX_IDENTITY_BYTES));
    report.checks.push({ id: 'identity', status: 'ok', code: 'valid_identity', message: 'Existing signing/encryption keys and agent fingerprint match. Registration was not checked.' });
  } catch (error) { report.checks.push(localFailure('identity', error)); }
  // --agent selects a public inbox, just as inbox does; it need not match local keys.
  const agent = parsed.agent ?? identity;
  if (agent) {
    const scope = createHash('sha256').update(`${parsed.hub}|${agent}`).digest('hex').slice(0, 16);
    const file = parsed.state ? resolve(parsed.state) : join(dirname(parsed.identity), `inbox-${scope}.json`);
    try {
      validateInboxCheckpoint(readLocalJson(file, MAX_STATE_BYTES), parsed.hub, agent);
      report.checks.push({ id: 'inbox', status: 'ok', code: 'valid_checkpoint', message: 'Existing checkpoint has valid structure and matches this hub/agent. History completeness was not checked.' });
    } catch (error) { report.checks.push(localFailure('inbox', error)); }
    try {
      lstatSync(`${file}.lock`);
      report.checks.push({ id: 'inbox.lock', status: 'warning', code: 'lock_present', message: 'An acknowledgment lock exists; it was not changed.', remedy: 'Let the other reader finish. Remove a stale lock manually only after confirming no acknowledgment is running.' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.checks.push({ id: 'inbox.lock', status: 'warning', code: 'lock_unreadable', message: 'Could not inspect the acknowledgment lock.' });
    }
  } else report.checks.push({ id: 'inbox', status: 'skipped', code: 'agent_required', message: 'Checkpoint check needs a valid identity or --agent; no file was created.', remedy: 'Select the inbox owner with --agent to check public inbox state without an identity.' });
  if (parsed.offline) {
    for (const endpoint of ['status', 'channels']) report.checks.push({ id: `hub.${endpoint}`, status: 'skipped', code: 'offline', message: 'Offline mode: no network request.' });
  } else {
    if (parsed.insecure) report.checks.push({ id: 'hub.transport', status: 'warning', code: 'unencrypted_http', message: 'Selected hub uses unencrypted HTTP; prefer HTTPS outside local development.' });
    report.checks.push(...await Promise.all((['status', 'channels'] as const).map(endpoint => checkEndpoint(parsed.hub, endpoint, parsed.timeout, options.fetch ?? fetch))));
  }
  report.exitCode = report.checks.some(c => c.status === 'error') ? 1 : 0;
  report.status = report.exitCode ? 'error' : report.checks.some(c => c.status === 'warning' || c.status === 'skipped') ? 'warning' : 'ok';
  return report;
}

export function formatDoctorReport(report: DoctorReport): string {
  return [`SwarmRelay doctor: ${report.status} (${report.mode}, read-only)`,
    ...Object.entries(report.versions).map(([name, version]) => `${name}: ${version}`),
    ...report.checks.map(c => `[${c.status}] ${c.id} (${c.code}): ${c.message}${c.remedy ? `\n  ${c.remedy}` : ''}`),
    'No identity/checkpoint writes, registration, posts, listeners or commands. This does not certify hub trust or wake delivery.'].join('\n');
}
