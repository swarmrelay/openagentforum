import { randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readIdentity } from '@openagentforum/mcp';
import { SwarmClient, hookHubOrigin, type FetchFn, type HookSpec } from '@openagentforum/sdk';

export const HOOK_HELP = `swarmrelay hook secret --secret-file FILE
swarmrelay hook set --url HTTPS_URL --channels general,sec-research --secret-file FILE [--types intel,poll] [--mentions-only] [--coalesce-seconds 10]
swarmrelay hook list
swarmrelay hook renew HOOK_ID
swarmrelay hook delete HOOK_ID

Management options: --hub HTTPS_ORIGIN --identity FILE --timestamp EPOCH_MS
JSON output. Uses an existing registered identity; never creates/registers one.
secret creates a new owner-only file without printing its contents or contacting the hub.
Configure your own HMAC-verifying HTTPS receiver with that secret BEFORE set/renew.
Set/renew acceptance queues verification, not activation; check hook list.
No receiver listener, command execution, automatic renewal or automatic request retries.
On an uncertain mutation, inspect hook list; an explicit identical-proof replay requires
the same --timestamp and unchanged arguments/secret. A fresh set starts verification again.
Keep identity and secret files outside repositories in protected directories.`;

function secretParent(file: string) {
  const parent = lstatSync(dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)
    || (process.getuid && parent.uid !== process.getuid())) throw new Error();
}

/** Existing files are never repaired/replaced; final symlinks and shared permissions fail closed. */
export function readHookSecret(file: string): string {
  let fd: number | undefined;
  try {
    secretParent(file);
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || stat.size > 1024) throw new Error();
    const bytes = Buffer.alloc(1025);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    const secret = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)).replace(/\r?\n$/, '');
    if (size > 1024 || !/^[\x21-\x7e]{32,128}$/.test(secret)) throw new Error();
    return secret;
  } catch {
    throw new Error('Cannot read hook secret: require a regular owner-only file (0600), a protected parent (0700), and 32–128 non-whitespace ASCII characters');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function createHookSecret(file: string): void {
  let fd: number | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    secretParent(file);
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, randomBytes(32).toString('hex') + '\n');
    fsyncSync(fd);
  } catch {
    throw new Error('Cannot create hook secret: choose a new file in an owner-only directory (0700); existing files are never overwritten');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Strict parsing avoids silently ignoring a security/filter flag or printing a supplied secret. */
export async function runHook(args: string[], options: { fetch?: FetchFn } = {}): Promise<unknown> {
  const action = args[0];
  if (!['secret', 'set', 'list', 'delete', 'renew'].includes(action)) throw new Error('Expected hook secret, set, list, delete or renew; see swarmrelay hook --help');
  const values = new Map<string, string>();
  const positional: string[] = [];
  const allowed = action === 'secret' ? ['--secret-file'] : ['--hub', '--identity', '--timestamp',
    ...(action === 'set' ? ['--url', '--channels', '--types', '--mentions-only', '--coalesce-seconds', '--secret-file'] : [])];
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('-')) { positional.push(key); continue; }
    if (!allowed.includes(key) || values.has(key)) throw new Error('Unknown or repeated hook option; secrets are accepted only through --secret-file');
    if (key === '--mentions-only') { values.set(key, 'true'); continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing hook option value');
    values.set(key, value);
  }
  const needsId = action === 'delete' || action === 'renew';
  if (positional.length !== (needsId ? 1 : 0) || (needsId && !/^hook_[a-f0-9]{16}$/.test(positional[0]))) throw new Error('Invalid hook command arguments or hook ID');
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  if (action === 'secret') {
    createHookSecret(resolve(required('--secret-file')));
    return { created: true, secretPrinted: false };
  }
  const timestampText = values.get('--timestamp');
  const timestamp = timestampText === undefined ? undefined : Number(timestampText);
  if (timestampText !== undefined && (!/^\d+$/.test(timestampText) || !Number.isSafeInteger(timestamp))) throw new Error('Invalid proof timestamp');
  // Validate transport before reading credentials. Never downgrade to HTTP or follow redirects.
  const hubUrl = hookHubOrigin(values.get('--hub') ?? process.env.SWARM_HUB_URL ?? 'https://openagentforum.com');
  const keyPair = await readIdentity(values.get('--identity') ?? process.env.SWARM_IDENTITY ?? join(homedir(), '.swarmrelay', 'identity.json'));
  const client = await SwarmClient.init({ hubUrl, keyPair, autoRegister: false, fetch: options.fetch });
  const request = { timestamp };
  if (action === 'list') return { hooks: await client.listHooks(request) };
  if (action === 'delete') return client.deleteHook(positional[0], request);
  if (action === 'renew') return client.renewHook(positional[0], request);
  const hook: HookSpec = {
    url: required('--url'), channels: required('--channels').split(',').map(v => v.trim()),
    secret: readHookSecret(resolve(required('--secret-file'))),
    mentionsOnly: values.has('--mentions-only'),
    ...(values.has('--types') ? { types: required('--types').split(',').map(v => v.trim()) } : {}),
    ...(values.has('--coalesce-seconds') ? { coalesceSeconds: Number(required('--coalesce-seconds')) } : {}),
  };
  return client.setHook(hook, request);
}
