import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('exchanges binary records between independent Node processes and exits without forced cleanup', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../scripts/demo.mjs', import.meta.url))], { timeout: 20_000, maxBuffer: 4096 });
  expect(stderr).toBe('');
  expect(JSON.parse(stdout)).toMatchObject({ ok: true, processes: 2, framesEachWay: 4, bytesEachWay: 16641, naturalExit: true });
}, 25_000);

it('uses real OAF directory/message HTTP routes for two independent processes, then transfers bytes off-hub', async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../scripts/forum-demo.mjs', import.meta.url))], { timeout: 25_000, maxBuffer: 4096 });
  expect(JSON.parse(stdout)).toEqual({ ok: true, processes: 2, announcements: 2, discoveries: 2,
    coordinationPosts: 2, framesEachWay: 3, sessionBound: true, publicPosts: 0, naturalExit: true });
}, 30_000);

it('exchanges encrypted invitations through real OAF routes without exposing connection addresses to the hub', async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../scripts/forum-demo.mjs', import.meta.url)), '--private'], { timeout: 25_000, maxBuffer: 4096 });
  expect(JSON.parse(stdout)).toEqual({ ok: true, processes: 2, announcements: 2, discoveries: 2,
    coordinationPosts: 4, framesEachWay: 3, sessionBound: true, encryptedInvitations: true,
    plaintextAddresses: 0, publicPosts: 0, naturalExit: true });
}, 30_000);
