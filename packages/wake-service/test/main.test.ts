import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HUB } from './fixtures.js';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const pullEntry = fileURLToPath(new URL('../dist/pull-main.js', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function config() {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-wake-startup-'));
  dirs.push(dir);
  const token = randomBytes(32).toString('hex');
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
  const env = { ...process.env, OAF_WAKE_HUB: HUB, OAF_WAKE_STATE_DIR: dir, OAF_WAKE_TOKEN_FILE: tokenFile, OAF_WAKE_PORT: '8791',
    OAF_WAKE_CONTROL_ENDPOINT: 'https://control.example.net/internal/wake-control' };
  return { dir, token, tokenFile, env };
}

describe('built service entrypoint', () => {
  it('refuses missing settings, weak tokens, insecure permissions and symlinked secrets', () => {
    const { dir, token, tokenFile, env } = config();
    const run = (patch: Record<string, string> = {}) => {
      for (const executable of [entry, pullEntry]) {
        const result = spawnSync(process.execPath, [executable], { env: { ...env, ...patch }, encoding: 'utf8', timeout: 2000 });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(executable === entry ? 'startup refused' : 'startup/runtime refused');
        expect(result.stderr).not.toContain(token);
        expect(result.stderr).not.toContain(tokenFile);
      }
    };
    run({ OAF_WAKE_HUB: '' });
    chmodSync(tokenFile, 0o644);
    run();
    chmodSync(tokenFile, 0o600);
    const link = join(dir, 'token-link');
    symlinkSync(tokenFile, link);
    run({ OAF_WAKE_TOKEN_FILE: link });
    writeFileSync(tokenFile, 'weak');
    run();
    writeFileSync(tokenFile, token);
    chmodSync(dir, 0o755);
    run();
    chmodSync(dir, 0o700);
  });

  it('starts loopback-only with an owner-only database and shuts down cleanly', async () => {
    const { dir, env } = config();
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const child = spawn(process.execPath, [entry], { env: { ...env, OAF_WAKE_PORT: String(address.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    try {
      const output = await Promise.race([
        once(child.stdout, 'data').then(([data]) => String(data)),
        exit.then(() => { throw new Error('service exited before listening'); }),
      ]);
      expect(JSON.parse(output)).toMatchObject({ event: 'listening', publicHooks: false, port: address.port });
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      expect(await response.json()).toMatchObject({ role: 'wake-egress', publicHooks: false });
      expect(statSync(join(dir, 'attempts.sqlite')).mode & 0o077).toBe(0);
      child.kill('SIGTERM');
      expect((await exit)[0]).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exit;
    }
  });

  it('runs the built pull entrypoint without listening or contacting any real control host', async () => {
    const { dir, token, env } = config();
    // Test-only preload traps *any* TCP listener and replaces HTTPS egress with an
    // offline failure. Production has no such CLI/config transport switch.
    const preload = 'data:text/javascript,' + encodeURIComponent(`
      import net from 'node:net';
      import https from 'node:https';
      import { EventEmitter } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      net.Server.prototype.listen = () => { process.exit(91); };
      https.request = () => {
        const req = new EventEmitter();
        req.destroy = () => req;
        req.end = () => queueMicrotask(() => req.emit('error', new Error('offline fixture')));
        return req;
      };
      syncBuiltinESMExports();
    `);
    const child = spawn(process.execPath, ['--import', preload, pullEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', data => { stderr += String(data); });
    try {
      const output = await Promise.race([
        once(child.stdout, 'data').then(([data]) => String(data)),
        exit.then(() => { throw new Error('pull entrypoint failed before startup'); }),
      ]);
      expect(JSON.parse(output.trim().split('\n')[0])).toEqual({ event: 'started', role: 'wake-pull', publicHooks: false });
      for (const name of ['attempts.sqlite', 'pull.sqlite']) expect(statSync(join(dir, name)).mode & 0o077).toBe(0);
      child.kill('SIGTERM');
      expect((await exit)[0]).toBe(0);
      expect(stderr).not.toContain(token);
      expect(stderr).not.toContain('offline fixture');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exit;
    }
  });

  it('refuses missing pull configuration and symlinked pull journals before network I/O', () => {
    const { dir, tokenFile, env } = config();
    const run = (patch: Record<string, string> = {}) => {
      const result = spawnSync(process.execPath, [pullEntry], { env: { ...env, ...patch }, encoding: 'utf8', timeout: 2000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('startup/runtime refused');
    };
    run({ OAF_WAKE_CONTROL_ENDPOINT: '' });
    run({ OAF_WAKE_CONTROL_ENDPOINT: 'http://localhost/internal/wake-control' });
    symlinkSync(tokenFile, join(dir, 'pull.sqlite'));
    run();
  });
});
