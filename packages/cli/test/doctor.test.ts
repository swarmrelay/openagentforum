import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import { formatDoctorReport, runDoctor } from '../src/doctor.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-cli-doctor-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const identity = join(dir, 'identity.json');
  const keys = await generateAgentKeyPair();
  writeFileSync(identity, JSON.stringify(keys), { mode: 0o600 });
  const hub = 'https://hub.example.net';
  const scope = createHash('sha256').update(`${hub}|${keys.agentId}`).digest('hex').slice(0, 16);
  const state = join(dir, `inbox-${scope}.json`);
  const checkpoint = { version: 1, hubUrl: hub, agentId: keys.agentId, channels: { general: { after: 3, authoredIds: ['message-1'], historyStartsAt: 1 } }, pendingChannels: ['general'] };
  writeFileSync(state, JSON.stringify(checkpoint), { mode: 0o600 });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
    expect(init?.body).toBeUndefined();
    expect(String(input)).not.toContain(keys.agentId);
    return String(input).endsWith('/v1/status') ? Response.json({ status: 'online', hub: 'peer text must not print' }) : Response.json({ channels: [{ name: 'untrusted-channel-name' }] });
  });
  const args = ['--hub', hub, '--identity', identity];
  return { dir, identity, keys, hub, state, checkpoint, fetcher, args };
}
const check = (report: Awaited<ReturnType<typeof runDoctor>>, id: string) => report.checks.find(c => c.id === id);
const snapshot = (file: string) => ({ text: readFileSync(file, 'utf8'), mode: lstatSync(file).mode, mtimeMs: lstatSync(file).mtimeMs });

describe('read-only doctor', () => {
  it('checks local state and exactly two public endpoints without leaking data or mutating files', async () => {
    const f = await fixture();
    const before = [snapshot(f.identity), snapshot(f.state), readdirSync(f.dir)];
    const report = await runDoctor(f.args, { fetch: f.fetcher });
    expect(report).toMatchObject({ schemaVersion: 1, status: 'ok', exitCode: 0, mode: 'online' });
    expect(Object.keys(report.versions)).toHaveLength(6);
    expect(check(report, 'identity')?.code).toBe('valid_identity');
    expect(check(report, 'inbox')?.code).toBe('valid_checkpoint');
    expect(f.fetcher.mock.calls.map(c => c[0]).sort()).toEqual([`${f.hub}/v1/channels`, `${f.hub}/v1/status`]);
    for (const secret of [f.keys.signingPrivateKey, f.keys.encryptionPrivateKey, f.keys.agentId, f.identity, f.state, f.hub, 'peer text must not print', 'untrusted-channel-name']) {
      expect(JSON.stringify(report) + formatDoctorReport(report)).not.toContain(secret);
    }
    expect([snapshot(f.identity), snapshot(f.state), readdirSync(f.dir)]).toEqual(before);
  });

  it('offline makes no requests and does not create a missing identity directory or state', async () => {
    const f = await fixture();
    const missing = join(f.dir, 'missing', 'identity.json');
    const report = await runDoctor(['--offline', '--identity', missing, '--agent', f.keys.agentId], { fetch: f.fetcher });
    expect(report.exitCode).toBe(0);
    expect(report.status).toBe('warning');
    expect(check(report, 'identity')?.code).toBe('missing');
    expect(check(report, 'inbox')?.code).toBe('missing');
    expect(check(report, 'hub.status')?.code).toBe('offline');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(existsSync(join(f.dir, 'missing'))).toBe(false);
  });

  it('uses environment defaults and the same exact inbox scope as inbox', async () => {
    const f = await fixture();
    vi.stubEnv('SWARM_IDENTITY', f.identity);
    vi.stubEnv('SWARM_HUB_URL', `${f.hub}/`);
    expect(check(await runDoctor(['--offline']), 'inbox')?.code).toBe('valid_checkpoint');
  });

  it('supports an explicit public agent and checkpoint without local keys', async () => {
    const f = await fixture();
    const report = await runDoctor(['--offline', '--identity', join(f.dir, 'absent'), '--hub', f.hub, '--agent', f.keys.agentId, '--state', f.state]);
    expect(report.exitCode).toBe(0);
    expect(check(report, 'inbox')?.code).toBe('valid_checkpoint');
  });

  it('skips checkpoint validation if no agent can be selected', async () => {
    const f = await fixture();
    const report = await runDoctor(['--offline', '--identity', join(f.dir, 'absent')]);
    expect(check(report, 'inbox')?.code).toBe('agent_required');
    expect(report.exitCode).toBe(0);
  });

  it.each(['json', 'utf8', 'agent', 'signing', 'encryption', 'public-key', 'oversize', 'directory', 'symlink', 'hardlink', 'permissions', 'parent', 'parent-symlink', 'fifo'])('rejects %s identities without changing or printing them', async mode => {
    const f = await fixture();
    let identity = f.identity;
    if (mode === 'json') writeFileSync(identity, '{secret: do not print}');
    if (mode === 'utf8') writeFileSync(identity, Buffer.alloc(8, 0xff));
    if (mode === 'agent') writeFileSync(identity, JSON.stringify({ ...f.keys, agentId: 'agent_0000000000000000' }));
    if (mode === 'signing') writeFileSync(identity, JSON.stringify({ ...f.keys, signingPrivateKey: 'aabb' }));
    if (mode === 'encryption') writeFileSync(identity, JSON.stringify({ ...f.keys, encryptionPrivateKey: f.keys.signingPrivateKey }));
    if (mode === 'public-key') writeFileSync(identity, JSON.stringify({ ...f.keys, encryptionPublicKey: '00'.repeat(32) }));
    if (mode === 'oversize') writeFileSync(identity, 'sensitive'.repeat(3000));
    if (mode === 'directory') identity = f.dir;
    if (mode === 'symlink') { identity = join(f.dir, 'link'); symlinkSync(f.identity, identity); }
    if (mode === 'hardlink') { identity = join(f.dir, 'link'); linkSync(f.identity, identity); }
    if (mode === 'permissions') chmodSync(identity, 0o644);
    if (mode === 'parent') chmodSync(f.dir, 0o755);
    if (mode === 'parent-symlink') {
      const protectedDir = join(f.dir, 'protected'); mkdirSync(protectedDir, { mode: 0o700 });
      writeFileSync(join(protectedDir, 'identity.json'), JSON.stringify(f.keys), { mode: 0o600 });
      symlinkSync(protectedDir, join(f.dir, 'linked-parent'));
      identity = join(f.dir, 'linked-parent', 'identity.json');
    }
    if (mode === 'fifo') {
      identity = join(f.dir, 'fifo');
      expect(spawnSync('mkfifo', [identity]).status).toBe(0);
    }
    const before = readdirSync(f.dir);
    const report = await runDoctor(['--offline', '--identity', identity]);
    expect(report.exitCode).toBe(1);
    expect(check(report, 'identity')?.status).toBe('error');
    expect(JSON.stringify(report)).not.toContain(f.keys.signingPrivateKey);
    expect(JSON.stringify(report)).not.toContain(f.dir);
    expect(JSON.stringify(report)).not.toContain('sensitive');
    expect(readdirSync(f.dir)).toEqual(before);
  });

  it.each(['hub', 'agent', 'version', 'cursor', 'ids', 'pending', 'json', 'permissions', 'oversize'])('rejects %s checkpoints without replacing them', async mode => {
    const f = await fixture();
    const bad: any = structuredClone(f.checkpoint);
    if (mode === 'hub') bad.hubUrl = 'https://another.example.net';
    if (mode === 'agent') bad.agentId = 'agent_0000000000000000';
    if (mode === 'version') bad.version = 2;
    if (mode === 'cursor') bad.channels.general.after = -1;
    if (mode === 'ids') bad.channels.general.authoredIds = [null];
    if (mode === 'pending') bad.pendingChannels = [false];
    writeFileSync(f.state, mode === 'json' ? 'private bad JSON' : mode === 'oversize' ? Buffer.alloc(16 * 1024 * 1024 + 1) : JSON.stringify(bad));
    if (mode === 'permissions') chmodSync(f.state, 0o644);
    const before = snapshot(f.state);
    const report = await runDoctor([...f.args, '--offline']);
    expect(report.exitCode).toBe(1);
    expect(check(report, 'inbox')?.status).toBe('error');
    expect(snapshot(f.state)).toEqual(before);
    expect(JSON.stringify(report)).not.toContain('private bad JSON');
  });

  it('reports but never removes an acknowledgment lock', async () => {
    const f = await fixture();
    const lock = `${f.state}.lock`;
    writeFileSync(lock, '', { mode: 0o600 });
    expect(check(await runDoctor([...f.args, '--offline']), 'inbox.lock')?.code).toBe('lock_present');
    expect(existsSync(lock)).toBe(true);
  });

  it.each([
    ['--exec', 'sensitive'], ['--json', '--json'], ['--hub'], ['--timeout-ms', '0'], ['--timeout-ms', '30001'], ['--timeout-ms', '1e3'],
    ['--hub', 'file:///sensitive'], ['--hub', 'https://user:sensitive@hub.example.net'], ['--hub', 'https://hub.example.net/?token=sensitive'],
    ['--hub', 'https://hub.example.net/#sensitive'], ['--hub', 'https://hub.example.net/path'], ['--hub', ' https://hub.example.net'],
    ['--agent', 'sensitive'], ['--state', '--offline'], ['--state', 'first', '--state', 'second'], ['sensitive'],
  ].map(args => [args]))('strictly rejects invalid options with a redacted usage report: %j', async args => {
    const f = await fixture();
    const report = await runDoctor(args, { fetch: f.fetcher });
    expect(report.exitCode).toBe(2);
    expect(report.checks).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('sensitive');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(['http', 'html', 'json', 'schema', 'oversize', 'network'])('handles %s endpoint failures without echoing peer text', async mode => {
    const f = await fixture();
    const fetcher = vi.fn(async () => {
      if (mode === 'network') throw new Error('sensitive DNS error');
      if (mode === 'http') return new Response('sensitive error', { status: 503 });
      if (mode === 'html') return new Response('<script>sensitive</script>');
      if (mode === 'json') return new Response('sensitive bad JSON', { headers: { 'content-type': 'application/json' } });
      if (mode === 'oversize') return Response.json({ extra: 'sensitive'.repeat(40_000) });
      return Response.json({ channels: [null], status: 'sensitive' });
    });
    const report = await runDoctor(f.args, { fetch: fetcher });
    expect(report.exitCode).toBe(1);
    expect(report.checks.filter(c => c.id.startsWith('hub.')).every(c => c.status === 'error')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('sensitive');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  async function listen(server: Server) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  it('does not follow real HTTP redirects to another endpoint', async () => {
    const f = await fixture();
    const seen: string[] = [];
    const hub = await listen(createServer((req, res) => { seen.push(req.url!); res.writeHead(302, { Location: '/must-not-visit' }); res.end(); }));
    const report = await runDoctor(['--hub', hub, '--identity', join(f.dir, 'absent')]);
    expect(report.exitCode).toBe(1);
    expect(check(report, 'hub.transport')?.code).toBe('unencrypted_http');
    expect(seen.sort()).toEqual(['/v1/channels', '/v1/status']);
  });

  it.each(['headers', 'body'])('bounds a real network timeout during %s', async phase => {
    const f = await fixture();
    const hub = await listen(createServer((_req, res) => {
      if (phase === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
    }));
    const started = Date.now();
    const report = await runDoctor(['--hub', hub, '--identity', join(f.dir, 'absent'), '--timeout-ms', '100']);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(check(report, 'hub.status')?.code).toBe('timeout');
    expect(check(report, 'hub.channels')?.code).toBe('timeout');
  });

  it('built CLI returns documented JSON, text, help and exit codes without SQLite startup', async () => {
    const f = await fixture();
    const run = (args: string[]) => spawnSync(process.execPath, ['dist/bin.js', 'doctor', ...args], { encoding: 'utf8', timeout: 10_000 });
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('no network');
    const good = run([...f.args, '--offline', '--json']);
    expect(good.status).toBe(0);
    expect(JSON.parse(good.stdout)).toMatchObject({ schemaVersion: 1, exitCode: 0 });
    expect(good.stderr).toBe('');
    expect(run([...f.args, '--offline']).stdout).toContain('read-only');
    writeFileSync(f.identity, 'sensitive bad JSON');
    const bad = run([...f.args, '--offline', '--json']);
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).exitCode).toBe(1);
    const invalid = run(['--json', '--secret', 'sensitive']);
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout).exitCode).toBe(2);
    expect(bad.stdout + bad.stderr + invalid.stdout + invalid.stderr).not.toContain('sensitive');
  });
});
