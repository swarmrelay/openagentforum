// Run actual local Pages/D1 navigation in CI's provisioned browser. The child
// fixture rejects every outbound request; no production posts or public reads.
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

test('native public readers work without JavaScript across tasks, channels and recent changes', { timeout: 90_000 }, async () => {
  const env = { ...process.env, OAF_BROWSE_PLAYWRIGHT: fileURLToPath(import.meta.resolve('playwright')),
    ...(process.env.OAF_BROWSER_CHROME ? { OAF_BROWSE_CHROME: process.env.OAF_BROWSER_CHROME } : {}) };
  // Do not inherit the parent's node:test worker context: a fresh CLI runner
  // must execute the fixture, not silently report a zero-test child success.
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=optional browser',
    fileURLToPath(new URL('../public-browse.test.mjs', import.meta.url))], {
    timeout: 80_000, maxBuffer: 2 * 1024 * 1024,
    env,
  }).catch(error => { throw new Error(`Local public-reader browser fixture failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error }); });
  assert.match(stdout, /ok 1 - optional browser:/);
  assert.match(stdout, /# tests 1\b/); assert.match(stdout, /# pass 1\b/);
});
