import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const command = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const hub = 'https://relay.example.com';
const policy = { rooms: 5, sessions: 10, controls: 20, packets: 100, packetBytes: 1000000, setups: 10, setupBytes: 1000000 };
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
function start(mode) {
  const child = spawn(process.execPath, [command, mode], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.stdout.on('data', value => { stdout += value; if (stdout.length > 65536) child.kill('SIGKILL'); });
  child.stderr.on('data', value => { stderr += value; if (stderr.length > 65536) child.kill('SIGKILL'); });
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve, reject) => {
    child.once('error', () => { clearTimeout(timer); reject(new Error('CLI fixture startup failed')); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, exited };
}
async function run(mode, lines) {
  const { child, exited } = start(mode); child.stdin.end(lines.map(value => JSON.stringify(value) + '\n').join(''));
  return exited;
}
const replies = result => result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'oaf-room-command-'));
  const pair = generateKeyPairSync('ed25519');
  const signingPrivateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex');
  const signingPublicKey = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const init = { directory, hub, signingPrivateKey, policy };
  const open = { op: 'open', directory, hub, signingPublicKey, policy };
  try { await fn({ directory, init, open }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('init waits for EOF, refuses multiple commands and never replaces existing state', async () => {
  await fixture(async ({ directory, init }) => {
    const extra = await run('init', [init, {}]);
    assert.equal(extra.code, 1); assert.match(extra.stderr, /one_initialization_required/);
    assert.deepEqual(await readdir(directory), []);
    const first = await run('init', [init]); assert.equal(first.code, 0);
    assert.equal(replies(first)[0].ok, true);
    const before = await readdir(directory);
    const second = await run('init', [init]); assert.equal(second.code, 1);
    assert.equal(replies(second)[0].error.code, 'local_state_unavailable');
    assert.deepEqual(await readdir(directory), before);
    for (const result of [extra, first, second]) {
      assert.equal((result.stdout + result.stderr).includes(init.signingPrivateKey), false, 'Private import appeared in output');
      assert.equal((result.stdout + result.stderr).includes(directory), false, 'Local path appeared in output');
    }
  });
});

test('run reports individual failures, checks pinned scope and releases local custody on EOF', async () => {
  await fixture(async ({ init, open }) => {
    assert.equal((await run('init', [init])).code, 0);
    const first = await run('run', [{ ...open, signingPublicKey: '0'.repeat(64) }, open, { op: 'info' }]);
    assert.equal(first.code, 0); assert.equal(first.signal, null);
    const output = replies(first);
    assert.deepEqual(output.map(value => value.ok), [false, true, true]);
    assert.equal(output[0].error.code, 'local_state_unavailable');
    assert.equal(output[0].error.permitsReplacementMutation, false);
    assert.equal(output[2].state.phase, 'open');
    const again = await run('run', [open]);
    assert.equal(again.code, 0); assert.equal(replies(again)[0].ok, true);
  });
});

test('SIGTERM stops an idle command, returns fixed diagnostics and releases local custody', async () => {
  await fixture(async ({ init, open }) => {
    assert.equal((await run('init', [init])).code, 0);
    const { child, exited } = start('run');
    // Kill only after a complete successful response, never during initialization.
    let received = '';
    child.stdout.on('data', value => {
      received += value;
      if (received.includes('\n')) child.kill('SIGTERM');
    });
    child.stdin.write(JSON.stringify(open) + '\n');
    const stopped = await exited;
    assert.equal(replies(stopped)[0].ok, true); assert.equal(stopped.code, 1); assert.equal(stopped.signal, null);
    assert.match(stopped.stderr, /oaf-room: interrupted/);
    assert.equal(stopped.stderr.includes(open.directory), false);
    const again = await run('run', [open]);
    assert.equal(again.code, 0); assert.equal(replies(again)[0].ok, true);
  });
});
