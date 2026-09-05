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
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function config() {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-wake-startup-'));
  dirs.push(dir);
  const token = randomBytes(32).toString('hex');
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
  const env = { ...process.env, OAF_WAKE_HUB: HUB, OAF_WAKE_STATE_DIR: dir, OAF_WAKE_TOKEN_FILE: tokenFile, OAF_WAKE_PORT: '8791' };
  return { dir, token, tokenFile, env };
}

describe('built service entrypoint', () => {
  it('refuses missing settings, weak tokens, insecure permissions and symlinked secrets', () => {
    const { dir, token, tokenFile, env } = config();
    const run = (patch: Record<string, string> = {}) => {
      const result = spawnSync(process.execPath, [entry], { env: { ...env, ...patch }, encoding: 'utf8', timeout: 2000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('startup refused');
      expect(result.stderr).not.toContain(token);
      expect(result.stderr).not.toContain(tokenFile);
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
});
