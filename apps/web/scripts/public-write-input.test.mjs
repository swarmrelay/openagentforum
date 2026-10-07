import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';
import { generateAgentKeyPair, signEnvelope, verifyEnvelope, signTaskAction } from '@openagentforum/protocol';

let mf, worker, scratch;
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
const origin = 'https://fixture.invalid';
const paths = ['/v1/channels', '/v1/channels/input/messages', '/v1/tasks', '/v1/tasks/task_fixture/claim', '/v1/tasks/task_fixture/submit'];
const send = (path, body, headers = {}) => worker.fetch(origin + path, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(12000) });
const json = (path, body) => send(path, JSON.stringify(body));
const sql = async statements => {
  const response = await json('/fixture/sql', statements);
  assert.equal(response.status, 200);
  const rows = await response.json(); assert.ok(rows.every(r => r.success)); return rows;
};

before(async () => {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  scratch = await mkdtemp(join(tmpdir(), 'oaf-write-input-'));
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/public-write-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  mf = new Miniflare({ host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
    telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'),
    workers: [{ config: { name: 'write-input-test', compatibilityDate: config.compatibility_date, compatibilityFlags: [],
      workersDev: false, previewUrls: false, domains: [], triggers: [],
      env: { DB: { type: 'd1', id: 'write-input-local', dev: { remote: false } } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { throw new Error('Outbound network denied'); } } } }],
  });
  await mf.ready; worker = await mf.getWorker('write-input-test');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    const schema = (await readFile(new URL(file, migrations), 'utf8')).replace(/^\s*--.*$/gm, '');
    const trigger = schema.indexOf('CREATE TRIGGER ');
    const ordinary = trigger < 0 ? schema : schema.slice(0, trigger);
    await sql(ordinary.split(';').filter(s => s.trim()).map(statement => ({ sql: statement })));
    if (trigger >= 0) await sql([{ sql: schema.slice(trigger) }]);
  }
});
after(async () => {
  await mf?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
  else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
});

test('native Pages rejects all public write inputs before D1, including streamed overflow and unsupported encodings', async () => {
  for (const path of paths) {
    for (const [raw, headers, status] of [
      ['{"private":', {}, 400], ['{}', { 'content-type': 'text/plain' }, 415],
      ['{}', { 'content-encoding': 'gzip' }, 415],
      ['{}', { 'x-fixture-input': 'oversize' }, 413],
      ['{}', { 'x-fixture-input': 'empty' }, 400], ['{}', { 'x-fixture-input': 'utf8' }, 400],
    ]) {
      const response = await send(path, raw, headers);
      assert.equal(response.status, status, path);
      assert.equal(response.headers.get('x-fixture-storage-calls'), '0');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (headers['x-fixture-input']) {
        assert.equal(response.headers.get('x-fixture-cancelled'), 'true');
        assert.equal(response.headers.get('x-fixture-locked'), 'false');
      }
      const error = await response.json();
      assert.match(error.code, /^(invalid_public_input|public_input_too_large|unsupported_public_input)$/);
      assert.equal(error.error, error.code);
    }
  }
});

test('native stalled producer is cancelled at the fixed body deadline without D1 or waiting for cancellation', { timeout: 15000 }, async () => {
  const response = await send('/v1/channels/input/messages', '{}', { 'x-fixture-input': 'stalled' });
  assert.equal(response.status, 408);
  assert.equal(response.headers.get('x-fixture-storage-calls'), '0');
  assert.equal(response.headers.get('x-fixture-cancelled'), 'true');
  assert.equal(response.headers.get('x-fixture-locked'), 'false');
  assert.equal((await response.json()).code, 'public_input_timeout');
});

test('native admission preserves signed bytes, duplicate messages, task proofs, state and anonymous reads', async () => {
  const key = await generateAgentKeyPair();
  assert.equal((await json('/v1/agents/register', { publicKey: key.signingPublicKey })).status, 200);
  assert.equal((await json('/v1/channels', { name: 'input', title: 'Native input test' })).status, 200);
  const envelope = await signEnvelope({ channel: 'input', sender: key.agentId, type: 'intel', sequence: 81,
    payload: { text: ' é 😀 ', lone: '\ud800', numbers: [0, 1.5] } }, key.signingPrivateKey);
  for (let n = 0; n < 2; n++) assert.equal((await json('/v1/channels/input/messages', envelope)).status, 200);
  const read = await worker.fetch(origin + '/v1/channels/input/messages');
  const { messages } = await read.json(); assert.equal(messages.length, 1);
  assert.equal(messages[0].signature, envelope.signature);
  assert.deepEqual(messages[0].payload, envelope.payload);
  assert.equal((await verifyEnvelope(messages[0], key.signingPublicKey)).valid, true);
  const malformed = await json('/v1/channels/input/messages', { ...envelope, channel: 'other' });
  assert.equal(malformed.status, 400); assert.equal(malformed.headers.get('x-fixture-storage-calls'), '0');
  const deep = '{"padding":' + '['.repeat(17) + '0' + ']'.repeat(17) + '}';
  assert.equal((await send('/v1/channels/input/messages', deep)).status, 413);
  const payload = { title: 'Native bounded task', description: 'Local only', requiredCapabilities: [], timeoutMs: 60000, reward: null };
  const timestamp = Date.now();
  const signature = await signTaskAction({ action: 'create', taskId: '-', agentId: key.agentId, timestamp, payload }, key.signingPrivateKey);
  const created = await json('/v1/tasks', { creatorId: key.agentId, ...payload, signature, timestamp });
  assert.equal(created.status, 200); const { task: { id: taskId } } = await created.json();
  for (const action of ['claim', 'submit']) {
    const result = action === 'submit' ? { resultPayload: { complete: true } } : {};
    const proof = await signTaskAction({ action, taskId, agentId: key.agentId, timestamp, payload: result }, key.signingPrivateKey);
    assert.equal((await json(`/v1/tasks/${taskId}/${action}`, { agentId: key.agentId, timestamp, signature: proof, ...result })).status, 200);
  }
  const [stored] = await sql([{ sql: 'SELECT status, result_payload_json FROM tasks WHERE id = ?', args: [taskId] }]);
  assert.equal(stored.results[0].status, 'completed');
  assert.deepEqual(JSON.parse(stored.results[0].result_payload_json), { complete: true });
});
