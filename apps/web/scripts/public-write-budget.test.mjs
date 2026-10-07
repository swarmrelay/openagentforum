import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';
import { canonicalizeJson, generateAgentKeyPair, signTaskAction } from '@openagentforum/protocol';

let mf, worker, scratch, runtimeConfig, configured;
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
const origin = 'https://relay.test';
const options = (requests = 3) => ({ origin, generation: 'a'.repeat(64), policy: {
  windowMs: 86400000, ordinary: { requests, inputBytes: 1048576 }, completion: { requests: 2, inputBytes: 524288 },
  operations: { registration: requests, channel: requests, message: requests, 'task-create': requests, 'task-claim': requests, 'task-submit': 2 },
} });
const send = (path, body, headers = {}) => worker.fetch(origin + path, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
const sql = async statements => {
  const response = await send('/fixture/sql', statements); assert.equal(response.status, 200);
  const rows = await response.json(); assert.ok(rows.every(row => row.success)); return rows;
};
const state = async () => {
  const [row] = await sql([{ sql: 'SELECT state_json FROM public_write_request_budget' }]); return JSON.parse(row.results[0].state_json);
};
const start = async () => { mf = new Miniflare(runtimeConfig); await mf.ready; worker = await mf.getWorker('public-budget-test'); };
const configure = async (initialize = true, config = options()) => {
  configured = config;
  assert.equal((await send('/fixture/configure', { options: config, initialize })).status, 200);
};
beforeEach(async () => {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  scratch = await mkdtemp(join(tmpdir(), 'oaf-public-budget-'));
  const pages = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/public-write-budget-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', metafile: true });
  assert.ok(Object.values(bundle.metafile.outputs).every(out => out.imports.length === 0));
  assert.ok(Object.keys(bundle.metafile.inputs).every(path => !/public-write-budget-sqlite|node:sqlite/.test(path)));
  runtimeConfig = { host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false, telemetry: { enabled: false }, logRequests: false,
    resourceTmpPath: join(scratch, 'runtime'), resourcePersistencePath: join(scratch, 'state'),
    workers: [{ config: { name: 'public-budget-test', compatibilityDate: pages.compatibility_date, compatibilityFlags: [],
      workersDev: false, previewUrls: false, domains: [], triggers: [], env: { DB: { type: 'd1', id: 'public-budget-local', dev: { remote: false } } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { throw new Error('Outbound requests prohibited'); } } } }],
  };
  await start();
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    const schema = (await readFile(new URL(name, migrations), 'utf8')).replace(/^\s*--.*$/gm, '');
    const trigger = schema.indexOf('CREATE TRIGGER ');
    await sql((trigger < 0 ? schema : schema.slice(0, trigger)).split(';').filter(s => s.trim()).map(statement => ({ sql: statement })));
    if (trigger >= 0) await sql([{ sql: schema.slice(trigger) }]);
  }
});
afterEach(async () => {
  await mf?.dispose(); if (scratch) await rm(scratch, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
});

test('native primary D1 shares limits across racing identities/channels/instances and refuses bodies before protected work', async () => {
  await configure();
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => send('/v1/channels',
    { name: `budget-${i}`, title: 'Fixture', creatorId: `agent_${i.toString(16).padStart(16, '0')}` }, { 'x-fixture-new-instance': 'true' })));
  const success = responses.filter(response => response.status === 200).length;
  assert.ok(success > 0 && success <= 3);
  for (const response of responses) if (response.status !== 200) {
    assert.ok([429, 503].includes(response.status)); assert.equal(response.headers.get('x-fixture-protected-calls'), '0');
  }
  // Any contention refusals are not promises of a full budget; finish the finite remaining allowance.
  for (let i = success; i < 3; i++) assert.equal((await send('/v1/channels', { name: `remaining-${i}`, title: 'Fixture' })).status, 200);
  const exhausted = await send('/v1/channels', {}, { 'x-fixture-stalled-body': 'true' });
  assert.equal(exhausted.status, 429); assert.equal(exhausted.headers.get('x-fixture-protected-calls'), '0');
  assert.equal(exhausted.headers.get('x-fixture-body-pulls'), '0'); assert.equal(exhausted.headers.get('x-fixture-body-cancelled'), 'true');
  assert.equal(exhausted.headers.get('cache-control'), 'no-store');
  assert.ok(Number(exhausted.headers.get('retry-after')) >= 1 && Number(exhausted.headers.get('retry-after')) <= 86400);
  assert.deepEqual((await state()).ordinary, { requests: 3, inputBytes: 3 * 16384 });
  const [rows] = await sql([{ sql: "SELECT count(*) AS n FROM channels WHERE title = 'Fixture'" }]); assert.equal(rows.results[0].n, 3);
  const before = await state(); assert.equal((await worker.fetch(origin + '/v1/channels')).status, 200); assert.deepEqual(await state(), before);
});

test('native fixture maps all six write classes into the same ordinary and completion allowances', async () => {
  await configure(true, options(5));
  for (const path of ['/v1/agents/register', '/v1/channels', '/v1/channels/general/messages', '/v1/tasks', '/v1/tasks/missing/claim']) {
    const response = await send(path, {}, { 'x-fixture-new-instance': 'true' });
    assert.ok([400, 401].includes(response.status), `${path}: ${response.status}`);
  }
  const before = await state();
  assert.deepEqual(before.ordinary, { requests: 5, inputBytes: 16384 + 16384 + 262144 + 49152 + 4096 });
  for (const op of ['registration', 'channel', 'message', 'task-create', 'task-claim']) assert.equal(before.operations[op], 1);
  assert.equal((await send('/v1/channels', {})).status, 429);
  assert.ok([400, 401].includes((await send('/v1/tasks/missing/submit', {})).status));
  assert.deepEqual((await state()).completion, { requests: 1, inputBytes: 262144 });
});

test('native malformed input consumes allowance while signed completion remains possible after ordinary exhaustion', async () => {
  await configure(true, options(1));
  assert.equal((await send('/v1/channels', {})).status, 400);
  assert.equal((await send('/v1/agents/register', {})).status, 429);
  const key = await generateAgentKeyPair(); const timestamp = Date.now(); const taskId = 'task_budget_fixture';
  await sql([{ sql: 'INSERT INTO agents (agent_id, public_key, name, capabilities_json, metadata_json, registered_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [key.agentId, key.signingPublicKey, 'Budget fixture', '[]', '{}', timestamp, timestamp] },
  { sql: "INSERT INTO tasks (id, creator_id, title, description, required_capabilities_json, status, claimed_by, timeout_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?)",
    args: [taskId, key.agentId, 'Budget fixture', 'Local only', '[]', key.agentId, 60000, timestamp, timestamp] }]);
  const resultPayload = { complete: true };
  const signature = await signTaskAction({ action: 'submit', taskId, agentId: key.agentId, timestamp, payload: { resultPayload } }, key.signingPrivateKey);
  assert.equal((await send(`/v1/tasks/${taskId}/submit`, { agentId: key.agentId, timestamp, signature, resultPayload })).status, 200);
  const [rows] = await sql([{ sql: 'SELECT status FROM tasks WHERE id = ?', args: [taskId] }]); assert.equal(rows.results[0].status, 'completed');
  assert.deepEqual((await state()).completion, { requests: 1, inputBytes: 262144 });
});

test('native committed lost acknowledgments and full runtime restart never refill allowances or start unconfirmed work', async () => {
  await configure(true, options(2));
  const lost = await send('/v1/channels', { name: 'uncertain', title: 'Fixture' }, { 'x-fixture-failure': 'lost' });
  assert.equal(lost.status, 503); assert.equal(lost.headers.get('x-fixture-budget-batches'), '1');
  assert.equal(lost.headers.get('x-fixture-protected-calls'), '0'); assert.equal((await state()).ordinary.requests, 1);
  const before = await state(); await mf.dispose(); await start(); await configure(false, configured);
  assert.deepEqual(await state(), before);
  assert.equal((await send('/v1/channels', { name: 'remaining', title: 'Fixture' })).status, 200);
  assert.equal((await send('/v1/channels', { name: 'overflow', title: 'Fixture' })).status, 429);
  const [rows] = await sql([{ sql: "SELECT name FROM channels WHERE title = 'Fixture'" }]); assert.deepEqual(rows.results, [{ name: 'remaining' }]);
});

test('native missing authority and backward database time fail closed without reseeding', async () => {
  await configure();
  const future = await state(); future.clock = Date.now() + 86400000; future.bucket = Math.floor(future.clock / configured.policy.windowMs);
  await sql([{ sql: 'UPDATE public_write_request_budget SET state_json = ?', args: [canonicalizeJson(future)] }]);
  const blocked = await send('/v1/channels', { name: 'future', title: 'Fixture' });
  assert.equal(blocked.status, 503); assert.equal(blocked.headers.get('x-fixture-protected-calls'), '0');
  await sql([{ sql: 'DELETE FROM public_write_request_budget' }]);
  await configure(false, configured);
  assert.equal((await send('/v1/channels', { name: 'missing', title: 'Fixture' })).status, 503);
  const [rows] = await sql([{ sql: 'SELECT count(*) AS n FROM public_write_request_budget' }]); assert.equal(rows.results[0].n, 0);
});
