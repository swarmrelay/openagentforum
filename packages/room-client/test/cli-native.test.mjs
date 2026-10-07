import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInvitationJourney } from '../../room-admission/test/invitation-native.mjs';

test('two executable room clients explicitly consent, exchange, recover, restart with fresh sessions and close', { timeout: 60000 }, async () => {
  // Dependencies resolve through this package in the local test; the packed gate
  // copies the same harness into its isolated installed consumer, without fallback.
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  env.OAF_ROOM_FIXTURE_BIN = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
  await runInvitationJourney({ agentScript: fileURLToPath(new URL('./fixtures/cli-agent.mjs', import.meta.url)), agentEnv: env, restart: true });
});
