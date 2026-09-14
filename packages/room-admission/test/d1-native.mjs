import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';
import { generateAgentKeyPair, sha256Hex } from '@openagentforum/protocol';
import { ROOM_LAB_SCHEMA, RoomAdmissionStore } from '../dist/sqlite.js';
import { deriveRoomId, ROOM_CONTROL_PROTOCOL, roomControlSignString, signRoomControl } from '../dist/control.js';
import { ROOM_RECOVERY_PROTOCOL, signRoomRecovery } from '../dist/recovery.js';

let mf, worker, scratch, action, receipt, owner, outsider, query;
let outbound = 0;
const hub = 'https://relay.example.com';
const now = 1_800_000_000_000;
const policy = { maxRetainedRooms: 1, maxActiveRooms: 1, maxActiveRoomsPerAgent: 1,
  maxPendingInvitesPerRecipient: 1, maxReceipts: 2, windowMs: 60_000,
  createsPerAgent: 1, createsPerHub: 1, invitesPerAgent: 1, invitesPerHub: 1, maxInFlightPerConnection: 8 };
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
async function call(path, body) {
  const text = JSON.stringify(body);
  assert.ok(Buffer.byteLength(text) < 30_000);
  const response = await worker.fetch(`https://local.invalid/test-only/${path}`,
    { method: 'POST', body: text, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.equal(outbound, 0);
  return response.json();
}
before(async () => {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  scratch = await mkdtemp(join(tmpdir(), 'oaf-room-d1-'));
  const pages = JSON.parse(await readFile(new URL('../../../apps/web/wrangler.jsonc', import.meta.url), 'utf8'));
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/d1-recovery-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', metafile: true });
  assert.ok(Object.values(bundle.metafile.outputs).every(o => o.imports.length === 0));
  assert.ok(Object.keys(bundle.metafile.inputs).every(path => !/noise|sqlite|libsodium/.test(path)), 'No Node/Noise runtime in D1 reader');
  mf = new Miniflare({ host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
    telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'),
    workers: [{ config: {
      type: 'worker', name: 'room-recovery-test', compatibilityDate: pages.compatibility_date, compatibilityFlags: [],
      workersDev: false, previewUrls: false, domains: [], triggers: [],
      env: { DB: { type: 'd1', id: 'local-room-recovery-test', dev: { remote: false } } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { outbound++; throw new Error('No outbound requests'); } } } }],
  });
  await mf.ready;
  worker = await mf.getWorker('room-recovery-test');
  [owner, outsider] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
  const requestId = '1'.repeat(32);
  action = { protocol: ROOM_CONTROL_PROTOCOL, hub, actor: owner.agentId, requestId,
    roomId: await deriveRoomId(hub, owner.agentId, requestId), issuedAt: now, expiresAt: now + 60_000,
    expectedRevision: 0, action: 'create', payload: { encryptionPublicKey: owner.encryptionPublicKey } };
  // Import actual committed SQLite acknowledgments, including a terminal close.
  // This fixture transfer proves wire compatibility, NOT D1 mutation atomicity.
  const db = new DatabaseSync(':memory:');
  try {
    const store = new RoomAdmissionStore(db, { hub, policy, now: () => now });
    const created = await store.submit(await signRoomControl(action, owner.signingPrivateKey), owner.signingPublicKey);
    assert.equal(created.ok, true); receipt = created.receipt;
    const closed = await store.submit(await signRoomControl({ ...action, requestId: '2'.repeat(32), expectedRevision: 1,
      action: 'close', payload: {} }, owner.signingPrivateKey), owner.signingPublicKey);
    assert.equal(closed.ok, true);
    const meta = db.prepare('SELECT schema_version, hub, protocol, policy, clock FROM room_lab_meta').get();
    const receipts = db.prepare('SELECT actor, request_id, signing_key, digest, receipt_json FROM room_lab_receipts').all();
    await call('seed', { schema: ROOM_LAB_SCHEMA, meta: Object.values(meta), receipts: receipts.map(row => Object.values(row)) });
  } finally { db.close(); }
  query = { protocol: ROOM_RECOVERY_PROTOCOL, hub, actor: owner.agentId, queryId: '3'.repeat(32),
    roomId: action.roomId, requestId, proofDigest: await sha256Hex(roomControlSignString(action)),
    issuedAt: now + 120_000, expiresAt: now + 180_000 };
});
after(async () => {
  await mf?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
  else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
});
test('real D1 recovers SQLite history after action expiry at retained capacity, without Node compatibility or writes', async () => {
  const wire = await signRoomRecovery(query, owner.signingPrivateKey);
  const result = await call('read', { hub, policy, now: query.issuedAt, queries: [{ wire, key: owner.signingPublicKey }] });
  assert.deepEqual(result, { results: [{ ok: true, queryId: query.queryId, observedAt: query.issuedAt, receipt }], unchanged: true, budget: 1 });
});
test('real D1 isolates actor, room, digest and signature; an unavailable read remains repeatable', async () => {
  const queries = [];
  for (const [patch, key] of [[{ actor: outsider.agentId }, outsider], [{ roomId: `room_${'f'.repeat(32)}` }, owner],
    [{ proofDigest: 'f'.repeat(64) }, owner]]) {
    queries.push({ wire: await signRoomRecovery({ ...query, ...patch }, key.signingPrivateKey), key: key.signingPublicKey });
  }
  queries.push(queries[0]);
  queries.push({ wire: await signRoomRecovery(query, outsider.signingPrivateKey), key: owner.signingPublicKey });
  const result = await call('read', { hub, policy, now: query.issuedAt, queries });
  assert.deepEqual(result.results.slice(0, 4), Array(4).fill({ ok: true, queryId: query.queryId, observedAt: query.issuedAt, receipt: null }));
  assert.deepEqual(result.results[4], { ok: false, reason: 'invalid_signature' });
  assert.equal(result.unchanged, true);
});
test('real D1 error is redacted and poisons the reader, never reported as unavailable', async () => {
  const result = await call('storage-failure', { hub, policy, now: query.issuedAt,
    wire: await signRoomRecovery(query, owner.signingPrivateKey), key: owner.signingPublicKey });
  assert.deepEqual(result, [{ ok: false, reason: 'storage_error' }, { ok: false, reason: 'storage_error' }]);
});
