import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/nostr-pool.mjs', import.meta.url));

describe('Nostr pool: real loopback sockets in isolated processes (#248)', () => {
  for (const scenario of ['rejected', 'refused', 'dropped', 'timeout', 'default-timeout', 'roundtrip', 'recover', 'oversized', 'redirect', 'shutdown']) {
    it(scenario, async () => {
      // A recursion crash, unhandled socket error, leaked timer/socket or hung
      // child is a failure. Never force a successful exit inside the fixture.
      const { stdout, stderr } = await run(process.execPath, [fixture, scenario], {
        timeout: 12_000, maxBuffer: 64 * 1024,
      });
      expect(stderr).toBe('');
      expect(stdout.trim()).toBe(`ok ${scenario}`);
    }, 15_000);
  }
});
