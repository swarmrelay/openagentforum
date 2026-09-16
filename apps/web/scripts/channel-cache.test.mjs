import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';
import { generateAgentKeyPair, signEnvelope, verifyEnvelope } from '@openagentforum/protocol';

let mf, worker, scratch, keys;
let outbound = 0;
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
const workerName = 'channel-cache-test';
const post = async (channel, envelopes) => {
  const response = await worker.fetch(`https://fixture.invalid/broadcast?channel=${channel}`, {
    method: 'POST', body: JSON.stringify(envelopes), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, await response.text());
};
const recent = async (channel, limit = 500) => {
  const response = await worker.fetch(`https://fixture.invalid/recent?channel=${channel}&limit=${limit}`);
  assert.equal(response.status, 200);
  return response.json();
};
const storage = channel => mf.unsafeGetDurableObjectStorage(workerName, 'SwarmChannelDO', { name: channel });
const envelope = (i, sequence = 1, payload = { message: `Message ${i}` }) => signEnvelope({
  id: `cache-${i}`, channel: 'cache-test', sender: keys[i % keys.length].agentId, type: 'intel', sequence, payload,
}, keys[i % keys.length].signingPrivateKey);

before(async () => {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  scratch = await mkdtemp(join(tmpdir(), 'oaf-channel-cache-'));
  const config = JSON.parse((await readFile(new URL('../../../packages/server/wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/channel-cache-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
  mf = new Miniflare({ host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false, telemetry: { enabled: false }, logRequests: false,
    resourceTmpPath: join(scratch, 'runtime'), unsafeInspectDurableObjects: true, workers: [{ config: { type: 'worker', name: workerName,
      compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
      workersDev: false, previewUrls: false, domains: [], triggers: [],
      exports: { SwarmChannelDO: { type: 'durable-object', storage: 'sqlite' } },
      env: { SWARM_CHANNEL: { type: 'durable-object', worker: workerName, exportName: 'SwarmChannelDO' } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { outbound++; throw new Error('No outbound requests allowed'); } } } }],
  });
  await mf.ready;
  worker = await mf.getWorker(workerName);
  keys = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair(), generateAgentKeyPair()]);
});
after(async () => {
  await mf?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
  else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
  assert.equal(outbound, 0);
});

test('native DO keeps exactly the latest 500 unique arrivals despite equal author sequences', async () => {
  const messages = await Promise.all(Array.from({ length: 503 }, (_, i) => envelope(i)));
  await post('ties', messages);
  const rows = await (await storage('ties')).exec('SELECT id, sequence FROM recent_messages ORDER BY rowid');
  assert.equal(rows.length, 500);
  assert.deepEqual(rows.map(r => r.id), messages.slice(-500).map(m => m.id));
  assert.ok(rows.every(r => r.sequence === 1));
});

test('author-selected counters never pin an old message or sort the cache; duplicates keep first arrival order', async () => {
  const messages = await Promise.all([envelope(0, Number.MAX_SAFE_INTEGER), envelope(1, -100), envelope(2, 0)]);
  await post('order', messages);
  await post('order', [messages[0]]);
  const rows = await recent('order');
  assert.deepEqual(rows.map(r => [r.id, r.sequence]), messages.map(m => [m.id, m.sequence]));
  // This cache does not define or manufacture a durable storedSeq cursor.
  assert.ok(rows.every(r => !Object.hasOwn(r, 'storedSeq')));
  for (const row of rows) assert.equal((await verifyEnvelope(row, keys.find(k => k.agentId === row.sender).signingPublicKey)).valid, true);
  await mf.unsafeEvictDurableObject(workerName, 'SwarmChannelDO', { name: 'order' });
  assert.deepEqual(await recent('order'), rows);
});

test('cache reads reject unbounded or invalid limits', async () => {
  for (const limit of [-1, 0, 501, 1.5, 'NaN']) {
    const response = await worker.fetch(`https://fixture.invalid/recent?channel=limits&limit=${limit}`);
    assert.equal(response.status, 400);
  }
});

test('native DO byte boundary is exact, includes non-payload text, and retains bounded concurrent arrivals', async () => {
  const base = await envelope(9, 1, '');
  const storedBytes = value => 32 + [value.id, value.sender, value.type, JSON.stringify(value.payload),
    value.signature, value.checksum, value.replyToId || ''].reduce((n, text) => n + Buffer.byteLength(text), 0);
  const fitting = await envelope(9, 1, 'a'.repeat(65536 - storedBytes(base)));
  assert.equal(storedBytes(fitting), 65536);
  await post('boundary', [fitting]);
  assert.equal((await recent('boundary')).length, 1);
  const oversized = await envelope(9, 1, fitting.payload + 'a');
  await post('boundary-too-large', [oversized]);
  assert.deepEqual(await recent('boundary-too-large'), []);
  await post('large-metadata', [{ ...base, replyToId: 'x'.repeat(65536) }]);
  assert.deepEqual(await recent('large-metadata'), []);

  const messages = await Promise.all(Array.from({ length: 520 }, (_, i) => envelope(i, i === 0 ? Number.MAX_SAFE_INTEGER : 1)));
  await Promise.all(Array.from({ length: 8 }, (_, i) => post('concurrent', messages.slice(i * 65, (i + 1) * 65))));
  const rows = await (await storage('concurrent')).exec('SELECT rowid, id, sequence FROM recent_messages ORDER BY rowid');
  assert.equal(rows.length, 500);
  assert.equal(new Set(rows.map(r => r.id)).size, 500);
  const fromApi = await recent('concurrent');
  assert.deepEqual(fromApi.map(r => r.id), rows.map(r => r.id));
  assert.ok(fromApi.reduce((total, row) => total + storedBytes(row), 0) <= 500 * 65536);
});

test('UTF-8 oversized rows are not cached, but live fan-out still carries the unchanged envelope', async () => {
  const response = await worker.fetch('https://fixture.invalid/ws', { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const ws = response.webSocket;
  ws.accept();
  try {
    const large = await envelope(0, 1, { message: '🙂'.repeat(17_000) });
    const delivered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fan-out timeout')), 5000);
      ws.addEventListener('message', event => {
        const data = JSON.parse(event.data);
        if (data.event === 'message') { clearTimeout(timer); resolve(data.data); }
      });
    });
    await post('cache-test', [large]);
    assert.deepEqual(await delivered, JSON.parse(JSON.stringify(large)));
    assert.equal((await verifyEnvelope(large, keys[0].signingPublicKey)).valid, true);
    assert.deepEqual(await recent('cache-test'), []);
  } finally { ws.close(); }
});

test('restart repairs overfull legacy caches, bounds UTF-8 bytes and preserves metadata and signed fields', async () => {
  await post('legacy', [await envelope(0)]);
  const db = await storage('legacy');
  await db.exec("INSERT INTO meta(key,value) VALUES ('current_sequence','42')");
  await db.exec(`WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM counter WHERE n<502)
    INSERT INTO recent_messages (id,sender,type,sequence,timestamp,payload_json,signature,checksum,encrypted)
    SELECT 'legacy-'||n, 'agent', 'intel', 1, 1, '{}', 'signature', 'checksum', 0 FROM counter`);
  await db.exec("UPDATE recent_messages SET payload_json = ? WHERE id='legacy-502'", '🙂'.repeat(17_000));
  await mf.unsafeEvictDurableObject(workerName, 'SwarmChannelDO', { name: 'legacy' });
  const rows = await (await storage('legacy')).exec('SELECT id, sequence FROM recent_messages ORDER BY rowid');
  assert.ok(rows.length <= 500);
  assert.equal(rows.some(r => r.id === 'legacy-502'), false);
  assert.ok(rows.every(r => r.sequence === 1));
  assert.equal((await (await storage('legacy')).exec("SELECT value FROM meta WHERE key='current_sequence'"))[0].value, '42');
});
