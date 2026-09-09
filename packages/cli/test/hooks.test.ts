import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveHookId, generateAgentKeyPair, verifyHookAction } from '@openagentforum/protocol';
import { createHookSecret, readHookSecret, runHook } from '../src/hooks.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) close(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-cli-hooks-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const identity = join(dir, 'identity.json');
  const file = join(dir, 'hook.secret');
  const keys = await generateAgentKeyPair();
  writeFileSync(identity, JSON.stringify(keys), { mode: 0o600 });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://hub.example.net');
    expect(url.pathname.startsWith(`/v1/agents/${keys.agentId}/hooks`)).toBe(true);
    if (init?.method === 'GET') {
      const headers = new Headers(init.headers);
      expect((await verifyHookAction({ action: 'list', agentId: keys.agentId, timestamp: Number(headers.get('x-agent-timestamp')),
        signature: headers.get('x-agent-signature')! }, keys.signingPublicKey)).valid).toBe(true);
      return Response.json({ hooks: [] });
    }
    const body = JSON.parse(init!.body as string);
    const action = init?.method === 'DELETE' ? 'delete' : url.pathname.endsWith('/renew') ? 'renew' : 'set';
    const hookId = action === 'set' ? await deriveHookId(keys.agentId, body.hook.url) : url.pathname.split('/')[5];
    expect((await verifyHookAction({ action, hookId, agentId: keys.agentId, ...body }, keys.signingPublicKey)).valid).toBe(true);
    return Response.json({ hookId, alreadyApplied: false }, { status: action === 'delete' ? 200 : 202 });
  });
  const common = ['--hub', 'https://hub.example.net', '--identity', identity];
  return { dir, identity, file, keys, fetcher, common };
}

describe('CLI owner hook setup without a receiver listener', () => {
  it('creates a fresh private secret without printing it or reading an identity, and never overwrites it', async () => {
    const f = await fixture();
    const result = await runHook(['secret', '--secret-file', f.file], { fetch: f.fetcher });
    const secret = readHookSecret(f.file);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(lstatSync(f.file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(runHook(['secret', '--secret-file', f.file])).rejects.toThrow('never overwritten');
    expect(readHookSecret(f.file)).toBe(secret);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('sets, lists, renews and deletes using only signed management requests and redacted JSON', async () => {
    const f = await fixture();
    createHookSecret(f.file);
    const beforeIdentity = readFileSync(f.identity, 'utf8');
    const timestamp = Date.now();
    const result = await runHook(['set', ...f.common, '--url', 'https://RECEIVER.EXAMPLE.NET:443/wake', '--channels', 'general,sec-research',
      '--secret-file', f.file, '--types', 'intel,poll', '--mentions-only', '--coalesce-seconds', '20', '--timestamp', String(timestamp)], { fetch: f.fetcher }) as { hookId: string };
    const sent = JSON.parse(f.fetcher.mock.calls[0][1]!.body as string);
    expect(sent).toMatchObject({ timestamp, hook: { url: 'https://receiver.example.net/wake', channels: ['general', 'sec-research'],
      types: ['intel', 'poll'], mentionsOnly: true, coalesceSeconds: 20, secret: readHookSecret(f.file) } });
    expect(JSON.stringify(result)).not.toContain(readHookSecret(f.file));
    expect(await runHook(['list', ...f.common], { fetch: f.fetcher })).toEqual({ hooks: [] });
    await runHook(['renew', result.hookId, ...f.common], { fetch: f.fetcher });
    await runHook(['delete', result.hookId, ...f.common], { fetch: f.fetcher });
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    expect(readFileSync(f.identity, 'utf8')).toBe(beforeIdentity);
  });

  it('lists with no secret file, but never creates a missing identity or registers a profile', async () => {
    const f = await fixture();
    expect(await runHook(['list', ...f.common], { fetch: f.fetcher })).toEqual({ hooks: [] });
    expect(existsSync(f.file)).toBe(false);
    const missing = join(f.dir, 'missing.json');
    await expect(runHook(['list', '--identity', missing], { fetch: f.fetcher })).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['permissions', 'parent', 'symlink', 'hardlink', 'directory', 'oversize', 'short', 'utf8'])('refuses %s secret files without HTTP or content-bearing errors', async mode => {
    const f = await fixture();
    createHookSecret(f.file);
    let target = f.file;
    if (mode === 'permissions') chmodSync(f.file, 0o644);
    if (mode === 'parent') chmodSync(f.dir, 0o755);
    if (mode === 'symlink') { target = join(f.dir, 'link'); symlinkSync(f.file, target); }
    if (mode === 'hardlink') { target = join(f.dir, 'link'); linkSync(f.file, target); }
    if (mode === 'directory') target = f.dir;
    if (mode === 'oversize') writeFileSync(f.file, 'sensitive'.repeat(200));
    if (mode === 'short') writeFileSync(f.file, 'sensitive');
    if (mode === 'utf8') writeFileSync(f.file, Buffer.alloc(64, 0xff));
    const error = await runHook(['set', ...f.common, '--url', 'https://receiver.example.net', '--channels', 'general', '--secret-file', target], { fetch: f.fetcher }).catch(e => e);
    expect(error.message).toContain('Cannot read hook secret');
    expect(error.message).not.toContain('sensitive');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['set', '--secret', 'never-print-this'], ['set', '--url'], ['list', '--hub', 'https://one.example.net', '--hub', 'https://two.example.net'],
    ['delete', '../../other'], ['list', 'extra'], ['list', '--timestamp', '-1'], ['list', '--timestamp', '1e3'], ['list', '--exec', 'never-run-this'],
  ])('refuses ambiguous/unsupported arguments without reflecting their values: %j', async args => {
    const f = await fixture();
    const error = await runHook(args, { fetch: f.fetcher }).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain('never-print-this');
    expect(error.message).not.toContain('never-run-this');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('the built CLI exposes setup help, creates only a secret, and sanitizes rejected secret arguments', async () => {
    const f = await fixture();
    const run = (args: string[]) => spawnSync(process.execPath, ['dist/bin.js', 'hook', ...args], { encoding: 'utf8', timeout: 10_000 });
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('No receiver listener');
    const created = run(['secret', '--secret-file', f.file]);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ created: true, secretPrinted: false });
    expect(created.stdout + created.stderr).not.toContain(readHookSecret(f.file));
    const rejected = run(['set', '--secret', 'private-value-never-print']);
    expect(rejected.status).toBe(1);
    expect(rejected.stdout + rejected.stderr).not.toContain('private-value-never-print');
  });
});
