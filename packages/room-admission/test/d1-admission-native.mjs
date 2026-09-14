import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';
import { generateAgentKeyPair, sha256Hex } from '@openagentforum/protocol';
import { ROOM_CONTROL_PROTOCOL, deriveRoomId, roomControlSignString, signRoomControl } from '../dist/control.js';
import { ROOM_RECOVERY_PROTOCOL, signRoomRecovery } from '../dist/recovery.js';

let mf, worker, scratch, runtimeConfig;
let outbound = 0;
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
async function startRuntime() {
  mf = new Miniflare(runtimeConfig);
  await mf.ready;
  worker = await mf.getWorker('room-admission-test');
}
beforeEach(async () => {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  scratch = await mkdtemp(join(tmpdir(), 'oaf-admission-d1-'));
  const pages = JSON.parse(await readFile(new URL('../../../apps/web/wrangler.jsonc', import.meta.url), 'utf8'));
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/d1-admission-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', metafile: true });
  assert.ok(Object.values(bundle.metafile.outputs).every(o => o.imports.length === 0));
  assert.ok(Object.keys(bundle.metafile.inputs).every(path => !/noise|sqlite|libsodium/.test(path)));
  const source = bundle.outputFiles[0].text;
  runtimeConfig = { host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
    telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'),
    resourcePersistencePath: join(scratch, 'state'),
    workers: [{ config: {
      type: 'worker', name: 'room-admission-test', compatibilityDate: pages.compatibility_date, compatibilityFlags: [],
      workersDev: false, previewUrls: false, domains: [], triggers: [],
      env: { DB: { type: 'd1', id: 'local-room-admission-test', dev: { remote: false } } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: source } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { outbound++; throw new Error('No outbound requests'); } } } }],
  };
  await startRuntime();
});
afterEach(async () => {
  await mf?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
  else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
});
test('native D1 database time advances between statements across bounded SQL work', async t => {
  const start = performance.now();
  const response = await worker.fetch('https://local.invalid/test-only/clock', { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.equal(outbound, 0);
  const result = await response.json();
  t.diagnostic(JSON.stringify({ ...result, elapsedMs: performance.now() - start }));
  assert.equal(typeof result.first, 'number');
  assert.equal(typeof result.last, 'number');
  assert.ok(result.last > result.first);
});

const hub = 'https://relay.example.com';
const defaultPolicy = { maxRetainedRooms: 100, maxActiveRooms: 50, maxActiveRoomsPerAgent: 20,
  maxPendingInvitesPerRecipient: 10, maxReceipts: 1000, windowMs: 86_400_000,
  createsPerAgent: 20, createsPerHub: 50, invitesPerAgent: 20, invitesPerHub: 50, maxInFlightPerConnection: 8 };
let sequence = 0;
async function setup(patch = {}) {
  const policy = { ...defaultPolicy, ...patch };
  const call = async (path, body = {}) => {
    const text = JSON.stringify({ hub, policy, now: Date.now(), ...body });
    assert.ok(Buffer.byteLength(text) < 16000);
    const response = await worker.fetch(`https://local.invalid/test-only/${path}`, { method: 'POST', body: text, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); assert.equal(outbound, 0); return response.json();
  };
  await call('init');
  const [owner, peer, outsider] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair(), generateAgentKeyPair()]);
  const action = async (actor, kind = 'create', state = null, payload = { encryptionPublicKey: actor.encryptionPublicKey }) => {
    const requestId = (++sequence).toString(16).padStart(32, '0');
    const now = Date.now();
    return { protocol: ROOM_CONTROL_PROTOCOL, hub, actor: actor.agentId, requestId,
      roomId: state?.roomId ?? await deriveRoomId(hub, actor.agentId, requestId), issuedAt: now, expiresAt: now + 60000,
      expectedRevision: state?.revision ?? 0, action: kind, payload };
  };
  const submit = async (a, actor = owner, extra = {}) => call('submit', { wire: await signRoomControl(a, actor.signingPrivateKey), key: actor.signingPublicKey, ...extra });
  const inspect = () => call('inspect');
  const state = async room => JSON.parse((await inspect()).rooms.find(r => r.room_id === room).state_json);
  const recover = async a => {
    const now = Date.now();
    const query = { protocol: ROOM_RECOVERY_PROTOCOL, hub, actor: owner.agentId, queryId: 'a'.repeat(32),
      roomId: a.roomId, requestId: a.requestId, proofDigest: await sha256Hex(roomControlSignString(a)), issuedAt: now, expiresAt: now + 60000 };
    return call('recover', { wire: await signRoomRecovery(query, owner.signingPrivateKey), key: owner.signingPublicKey });
  };
  return { call, action, owner, peer, outsider, submit, inspect, state, recover };
}

test('native D1 full create/invite/accept/close and recovery uses authoritative state, not fixture-seeded receipts', async () => {
  const f = await setup();
  const create = await f.action(f.owner);
  const created = await f.submit(create); assert.equal(created.ok, true);
  const invite = await f.action(f.owner, 'invite', await f.state(create.roomId), {
    recipient: f.peer.agentId, recipientSigningPublicKey: f.peer.signingPublicKey, inviteExpiresAt: Date.now() + 120000 });
  assert.equal((await f.submit(invite)).ok, true);
  const invited = await f.state(create.roomId);
  assert.equal((await f.submit(await f.action(f.outsider, 'close', invited, {}), f.outsider)).ok, false);
  assert.equal((await f.submit(await f.action(f.peer, 'accept', invited, {
    invitationDigest: invited.invitation.digest, encryptionPublicKey: f.peer.encryptionPublicKey }), f.peer)).ok, true);
  assert.equal((await f.submit(await f.action(f.peer, 'close', await f.state(create.roomId), {}), f.peer)).ok, true);
  assert.equal((await f.state(create.roomId)).status, 'closed');
  assert.deepEqual(await f.submit(create), { ok: true, replayed: true, receipt: created.receipt });
  assert.deepEqual((await f.recover(create)).receipt, created.receipt);
  assert.equal((await f.inspect()).receipts.length, 4);
  assert.deepEqual((await f.inspect()).gate, []);
});

test('native D1 serializes concurrent exact retries and hub quota races across separate requests', async () => {
  const f = await setup({ createsPerHub: 2 });
  const create = await f.action(f.owner);
  const identical = await Promise.all(Array.from({ length: 6 }, () => f.submit(create)));
  assert.equal(identical.filter(r => r.ok && !r.replayed).length, 1);
  assert.ok(identical.every(r => r.ok));
  const actions = await Promise.all([f.action(f.owner), f.action(f.peer), f.action(f.outsider)]);
  const results = await Promise.all(actions.map((a, i) => f.submit(a, [f.owner, f.peer, f.outsider][i])));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.ok(results.filter(r => !r.ok).every(r => r.reason === 'create_rate_limited'));
  assert.equal((await f.inspect()).receipts.length, 2);
});

test('native D1 retains a reserved close at capacity and rejects fresh reuse after closure', async () => {
  const f = await setup({ maxReceipts: 2 });
  const create = await f.action(f.owner); assert.equal((await f.submit(create)).ok, true);
  assert.deepEqual(await f.submit(await f.action(f.owner)), { ok: false, reason: 'receipt_capacity' });
  assert.equal((await f.submit(await f.action(f.owner, 'close', await f.state(create.roomId), {}))).ok, true);
  assert.deepEqual(await f.submit({ ...create, expiresAt: create.expiresAt + 1 }), { ok: false, reason: 'request_conflict' });
  assert.equal((await f.inspect()).receipts.length, 2);
});

test('native D1 lost acknowledgment remains uncertain and exact retry recovers without double charge', async () => {
  const f = await setup(); const create = await f.action(f.owner);
  assert.deepEqual(await f.submit(create, f.owner, { fault: 'lost-response' }), { ok: false, reason: 'storage_error' });
  assert.equal((await f.inspect()).receipts.length, 1);
  assert.equal((await f.submit(create)).replayed, true);
  assert.equal((await f.recover(create)).receipt.requestId, create.requestId);
  assert.equal((await f.inspect()).receipts.length, 1);
});

test('native D1 receipts, quotas and closed tombstones survive full local runtime restarts', async () => {
  const f = await setup({ maxReceipts: 2 });
  const create = await f.action(f.owner);
  assert.deepEqual(await f.submit(create, f.owner, { fault: 'lost-response' }), { ok: false, reason: 'storage_error' });
  const committed = await f.inspect();
  await mf.dispose();
  await startRuntime(); // Reopen the same disposable storage, without reseeding or initialization.
  assert.deepEqual(await f.inspect(), committed);
  assert.equal((await f.submit(create)).replayed, true);
  assert.equal((await f.recover(create)).receipt.requestId, create.requestId);
  assert.deepEqual(await f.submit(await f.action(f.peer), f.peer), { ok: false, reason: 'receipt_capacity' });
  assert.equal((await f.submit(await f.action(f.owner, 'close', await f.state(create.roomId), {}))).ok, true);
  const closed = await f.inspect();
  await mf.dispose();
  await startRuntime();
  assert.deepEqual(await f.inspect(), closed);
  assert.equal((await f.state(create.roomId)).status, 'closed');
  assert.deepEqual(await f.submit({ ...create, expiresAt: create.expiresAt + 1 }), { ok: false, reason: 'request_conflict' });
  assert.equal((await f.recover(create)).receipt.status, 'open'); // Historical, not current membership.
  assert.deepEqual((await f.inspect()).gate, []);
});

for (const fault of ['statement', 'missing-guard', 'final-expiry']) {
  test(`native D1 ${fault} fails closed without partial room or receipt writes`, async () => {
    const f = await setup(); const create = await f.action(f.owner);
    if (fault !== 'final-expiry') await f.call('fault', { fault });
    const before = await f.inspect();
    assert.deepEqual(await f.submit(create, f.owner, fault === 'final-expiry' ? { fault } : {}), { ok: false, reason: 'storage_error' });
    assert.deepEqual(await f.inspect(), before);
  });
}

test('native D1 rejects a proof that expires while queued even with a stale worker clock', async () => {
  const f = await setup(); const create = await f.action(f.owner);
  create.expiresAt = create.issuedAt + 25;
  assert.deepEqual(await f.submit(create, f.owner, { fault: 'queued-expiry', now: create.issuedAt }), { ok: false, reason: 'expired_proof' });
  assert.equal((await f.inspect()).rooms.length, 0);
});
