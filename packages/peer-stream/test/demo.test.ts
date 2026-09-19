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
