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
import { ROOM_STATE_PROTOCOL, signRoomState } from '../dist/state-read.js';
import { createRoomNoiseSession } from '../dist/handshake.js';
import { ROOM_PACKET_PROTOCOL, ROOM_PACKET_PROFILE, ROOM_PACKET_READ_PROTOCOL, ROOM_PACKET_RECOVERY_PROTOCOL,
  signRoomPacket, signRoomPacketRead, signRoomPacketRecovery, prepareRoomPacket } from '../dist/packet-wire.js';

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
async function setup(patch = {}, packets) {
  const policy = { ...defaultPolicy, ...patch };
  const call = async (path, body = {}) => {
    const text = JSON.stringify({ hub, policy, packets, now: Date.now(), ...body });
    assert.ok(Buffer.byteLength(text) < (packets ? 50000 : 16000));
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
  const readState = async (roomId, actor = owner, extra = {}) => {
    const now = Date.now();
    const query = { protocol: ROOM_STATE_PROTOCOL, hub, actor: actor.agentId, queryId: 'b'.repeat(32), roomId,
      issuedAt: now, expiresAt: now + 60000 };
    return call('state', { wire: await signRoomState(query, actor.signingPrivateKey), key: actor.signingPublicKey, ...extra });
  };
  return { call, action, owner, peer, outsider, submit, inspect, state, recover, readState };
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

test('native D1 member-only state reads follow real admission and never return keys or invitations', async () => {
  const f = await setup(); const create = await f.action(f.owner); assert.equal((await f.submit(create)).ok, true);
  const before = await f.inspect();
  const owner = await f.readState(create.roomId);
  assert.deepEqual(owner.result.room, { roomId: create.roomId, revision: 1, status: 'open', role: 'owner' });
  assert.equal(owner.queries, 2);
  assert.equal((await f.readState(create.roomId, f.peer)).result.room, null);
  assert.equal((await f.readState(`room_${'f'.repeat(32)}`)).result.room, null);
  assert.deepEqual(await f.inspect(), before);
  const invite = await f.action(f.owner, 'invite', await f.state(create.roomId), {
    recipient: f.peer.agentId, recipientSigningPublicKey: f.peer.signingPublicKey, inviteExpiresAt: Date.now() + 120000 });
  assert.equal((await f.submit(invite)).ok, true);
  assert.equal((await f.readState(create.roomId, f.peer)).result.room, null);
  const invited = await f.state(create.roomId);
  assert.equal((await f.submit(await f.action(f.peer, 'accept', invited, {
    invitationDigest: invited.invitation.digest, encryptionPublicKey: f.peer.encryptionPublicKey }), f.peer)).ok, true);
  assert.deepEqual((await f.readState(create.roomId, f.peer)).result.room,
    { roomId: create.roomId, revision: 3, status: 'open', role: 'peer' });
  assert.equal((await f.readState(create.roomId, f.outsider)).result.room, null);
  assert.equal((await f.submit(await f.action(f.peer, 'close', await f.state(create.roomId), {}), f.peer)).ok, true);
  assert.deepEqual((await f.readState(create.roomId, f.peer)).result.room,
    { roomId: create.roomId, revision: 4, status: 'closed', role: 'peer' });
  const closed = await f.inspect(); await mf.dispose(); await startRuntime();
  assert.equal((await f.readState(create.roomId)).result.room.status, 'closed');
  assert.equal((await f.readState(create.roomId, f.outsider)).result.room, null);
  assert.deepEqual(await f.inspect(), closed);
});

test('native D1 state reads remain read-only at reserved close capacity', async () => {
  const f = await setup({ maxReceipts: 2 }); const create = await f.action(f.owner);
  assert.equal((await f.submit(create)).ok, true);
  const before = await f.inspect();
  assert.equal((await f.readState(create.roomId)).result.room.status, 'open');
  assert.deepEqual(await f.inspect(), before);
  assert.equal((await f.submit(await f.action(f.owner, 'close', await f.state(create.roomId), {}))).ok, true);
  const closed = await f.inspect();
  assert.equal((await f.readState(create.roomId)).result.room.status, 'closed');
  assert.deepEqual(await f.inspect(), closed);
});

test('native D1 invalid state signatures stop before querying rooms', async () => {
  const f = await setup(); const create = await f.action(f.owner); assert.equal((await f.submit(create)).ok, true);
  const now = Date.now();
  const query = { protocol: ROOM_STATE_PROTOCOL, hub, actor: f.owner.agentId, queryId: 'b'.repeat(32), roomId: create.roomId,
    issuedAt: now, expiresAt: now + 60000 };
  const result = await f.call('state', { wire: await signRoomState(query, f.outsider.signingPrivateKey), key: f.owner.signingPublicKey });
  assert.deepEqual(result.result, { ok: false, reason: 'invalid_signature' }); assert.equal(result.queries, 1);
});

test('native D1 rejects expired asynchronous state responses and poisons uncertain reads', async () => {
  const f = await setup(); const create = await f.action(f.owner); assert.equal((await f.submit(create)).ok, true);
  const before = await f.inspect();
  assert.deepEqual((await f.readState(create.roomId, f.owner, { fault: 'state-expiry' })).result, { ok: false, reason: 'expired_proof' });
  const failed = await f.readState(create.roomId, f.owner, { fault: 'state-failure' });
  assert.deepEqual(failed.result, { ok: false, reason: 'storage_error' });
  assert.deepEqual(failed.poisoned, Array(3).fill({ ok: false, reason: 'storage_error' }));
  assert.equal(failed.queries, 2);
  assert.deepEqual(await f.inspect(), before);
});

test('native D1 overlapping close does not turn a status snapshot into a reusable permission', async () => {
  const f = await setup(); const create = await f.action(f.owner); assert.equal((await f.submit(create)).ok, true);
  const state = await f.state(create.roomId);
  const close = await f.action(f.owner, 'close', state, {});
  const read = await f.readState(create.roomId, f.owner, { closeWire: await signRoomControl(close, f.owner.signingPrivateKey) });
  assert.equal(read.result.room.status, 'open'); // Read snapshot predates the overlapping close.
  assert.equal((await f.readState(create.roomId)).result.room.status, 'closed');
  const invite = await f.action(f.owner, 'invite', state, {
    recipient: f.peer.agentId, recipientSigningPublicKey: f.peer.signingPublicKey, inviteExpiresAt: Date.now() + 120000 });
  assert.equal((await f.submit(invite)).ok, false); // Old status cannot authorize a new mutation.
});

const packetLimits = () => ({ packets: 1000, bytes: 10000000, sessions: 100, packetsPerWindow: 1000, bytesPerWindow: 10000000, sessionsPerWindow: 100 });
async function packetSetup(patch = {}) {
  const packets = { hub: { ...packetLimits(), ...patch }, room: packetLimits(), agent: packetLimits(), windowMs: 86400000 };
  const f = await setup({}, packets);
  const create = await f.action(f.owner); assert.equal((await f.submit(create)).ok, true);
  const invite = await f.action(f.owner, 'invite', await f.state(create.roomId), {
    recipient: f.peer.agentId, recipientSigningPublicKey: f.peer.signingPublicKey, inviteExpiresAt: Date.now() + 120000 });
  assert.equal((await f.submit(invite)).ok, true);
  const invited = await f.state(create.roomId);
  const accept = await f.action(f.peer, 'accept', invited, { invitationDigest: invited.invitation.digest, encryptionPublicKey: f.peer.encryptionPublicKey });
  assert.equal((await f.submit(accept, f.peer)).ok, true);
  const id = () => (++sequence).toString(16).padStart(32, '0'), sessionId = id(), roomId = create.roomId;
  const packetWire = async (actor = f.owner, patch = {}) => {
    const now = Date.now();
    return signRoomPacket({ protocol: ROOM_PACKET_PROTOCOL, hub, roomId, actor: actor.agentId, signingPublicKey: actor.signingPublicKey,
      issuedAt: now, expiresAt: now + 60000, requestId: id(), expectedRevision: 3, profile: ROOM_PACKET_PROFILE,
      sessionId, packetIndex: 0, kind: 'handshake', packetHex: 'ab'.repeat(96), ...patch }, actor.signingPrivateKey);
  };
  const read = async (actor = f.peer, afterStoredSeq = 0, extra = {}) => {
    const now = Date.now();
    const wire = await signRoomPacketRead({ protocol: ROOM_PACKET_READ_PROTOCOL, hub, roomId, actor: actor.agentId,
      signingPublicKey: actor.signingPublicKey, queryId: id(), issuedAt: now, expiresAt: now + 60000,
      expectedRevision: 3, afterStoredSeq, limit: 8 }, actor.signingPrivateKey);
    return f.call('packet-read', { wire, ...extra });
  };
  const recovery = async (wire, extra = {}) => {
    const proof = await prepareRoomPacket(wire, { hub, now: JSON.parse(wire).issuedAt }); assert.equal(proof.ok, true);
    const now = Date.now();
    const query = await signRoomPacketRecovery({ protocol: ROOM_PACKET_RECOVERY_PROTOCOL, hub, roomId, actor: f.owner.agentId,
      signingPublicKey: f.owner.signingPublicKey, requestId: proof.request.requestId, proofDigest: proof.proofDigest,
      queryId: id(), issuedAt: now, expiresAt: now + 60000 }, f.owner.signingPrivateKey);
    return f.call('packet-recover', { wire: query, ...extra });
  };
  const closeWire = async () => signRoomControl(await f.action(f.peer, 'close', await f.state(roomId), {}), f.peer.signingPrivateKey);
  const bundle = { create: await signRoomControl(create, f.owner.signingPrivateKey), invite: await signRoomControl(invite, f.owner.signingPrivateKey),
    accept: await signRoomControl(accept, f.peer.signingPrivateKey) };
  return { ...f, packetWire, read, recovery, closeWire, bundle, roomId, id };
}

test('native D1 carries actual Noise handshakes and encrypted data in both directions; closes and excludes outsiders', async () => {
  const f = await packetSetup(), sessions = [];
  try {
    const pins = { hub, roomId: f.roomId, ownerSigningPublicKey: f.owner.signingPublicKey, peerSigningPublicKey: f.peer.signingPublicKey };
    for (const role of ['owner', 'peer']) sessions.push(await createRoomNoiseSession({ role, bundle: f.bundle, pins,
      encryptionPrivateKey: f[role].encryptionPrivateKey, now: Date.now }));
    const [owner, peer] = sessions;
    const transfer = async (bytes, actor, recipient, kind, packetIndex) => {
      const wire = await f.packetWire(actor, { kind, packetIndex, packetHex: bytes.toString('hex') });
      const stored = await f.call('packet-write', { wire }); assert.equal(stored.ok, true);
      const page = await f.read(recipient, stored.receipt.storedSeq - 1); assert.equal(page.ok, true);
      assert.equal(page.page.records.length, 1); assert.equal(page.page.records[0].wire, wire);
      const received = await prepareRoomPacket(page.page.records[0].wire, { hub, now: Date.now() });
      assert.equal(received.ok, true); assert.equal(received.request.signingPublicKey, actor.signingPublicKey);
      return Buffer.from(received.request.packetHex, 'hex');
    };
    const one = await transfer(owner.start(), f.owner, f.peer, 'handshake', 0);
    const two = await transfer(peer.receiveHandshake(one), f.peer, f.owner, 'handshake', 0);
    const three = await transfer(owner.receiveHandshake(two), f.owner, f.peer, 'confirmation', 1);
    const four = await transfer(peer.receiveHandshake(three), f.peer, f.owner, 'confirmation', 1);
    assert.equal(owner.receiveHandshake(four), null);
    const body = Buffer.from('Private conversation; untrusted content, not a remote command.');
    assert.deepEqual(peer.open(await transfer(owner.seal(body), f.owner, f.peer, 'data', 2)), body);
    assert.deepEqual(owner.open(await transfer(peer.seal(body), f.peer, f.owner, 'data', 2)), body);
    assert.equal((await f.read(f.outsider)).page, null);
    assert.deepEqual(await f.call('packet-write', { wire: await f.packetWire(f.outsider) }), { ok: false, reason: 'unavailable' });
    assert.equal((await f.call('submit', { wire: await f.closeWire(), key: f.peer.signingPublicKey })).ok, true);
    assert.equal((await f.read()).page, null);
    assert.deepEqual(await f.call('packet-write', { wire: await f.packetWire(f.owner, { sessionId: f.id() }) }), { ok: false, reason: 'unavailable' });
  } finally { sessions.forEach(s => s.close()); }
});

test('native D1 packet journal survives lost responses and full runtime restart without double charging', async () => {
  const f = await packetSetup(), wire = await f.packetWire();
  assert.deepEqual(await f.call('packet-write', { wire, fault: 'lost-response' }), { ok: false, reason: 'storage_error' });
  const before = await f.inspect(); assert.equal(before.room_lab_packets.length, 1);
  await mf.dispose(); await startRuntime();
  assert.deepEqual(await f.inspect(), before);
  assert.equal((await f.call('packet-write', { wire })).replayed, true);
  assert.equal((await f.recovery(wire)).receipt.requestId, JSON.parse(wire).requestId);
  const recovered = await f.inspect();
  assert.deepEqual(recovered.room_lab_packet_usage, before.room_lab_packet_usage);
  assert.equal(recovered.room_lab_packets.length, 1);
  assert.equal((await f.call('submit', { wire: await f.closeWire(), key: f.peer.signingPublicKey })).ok, true);
  await mf.dispose(); await startRuntime();
  assert.equal((await f.read()).page, null);
  assert.equal((await f.recovery(wire)).receipt.storedSeq, 1);
});

test('native D1 serializes packet retries/positions/hub budgets across independent requests and keeps closure possible', async () => {
  const f = await packetSetup({ sessions: 2 }), wire = await f.packetWire();
  const exact = await Promise.all(Array.from({ length: 6 }, () => f.call('packet-write', { wire })));
  assert.ok(exact.every(r => r.ok)); assert.equal(exact.filter(r => !r.replayed).length, 1);
  const positions = await Promise.all(Array.from({ length: 4 }, async () => f.call('packet-write', {
    wire: await f.packetWire(f.peer, { packetHex: 'ab'.repeat(48) }) })));
  assert.equal(positions.filter(r => r.ok).length, 1);
  const budgets = await Promise.all(Array.from({ length: 4 }, async () => f.call('packet-write', {
    wire: await f.packetWire(f.owner, { sessionId: f.id() }) })));
  assert.equal(budgets.filter(r => r.ok).length, 1);
  assert.deepEqual((await f.inspect()).room_lab_d1_packet_gate, []);
  assert.equal((await f.call('submit', { wire: await f.closeWire(), key: f.peer.signingPublicKey })).ok, true);
});

for (const fault of ['packet-statement', 'packet-missing-guard', 'packet-ignore-budget', 'final-expiry']) {
  test(`native D1 ${fault} leaves no partial packet, phase, receipt or budget`, async () => {
    const f = await packetSetup(), wire = await f.packetWire();
    if (fault !== 'final-expiry') await f.call('fault', { fault });
    const before = await f.inspect();
    assert.deepEqual(await f.call('packet-write', { wire, ...(fault === 'final-expiry' ? { fault } : {}) }), { ok: false, reason: 'storage_error' });
    assert.deepEqual(await f.inspect(), before);
  });
}

test('native D1 observes signed closure between packet preflight and batch, but permits a prior read snapshot', async () => {
  const f = await packetSetup(), wire = await f.packetWire();
  assert.equal((await f.call('packet-write', { wire })).ok, true);
  const closeWire = await f.closeWire();
  assert.equal((await f.read(f.peer, 0, { closeWire, closeKey: f.peer.signingPublicKey })).page.records.length, 1);
  assert.equal((await f.read()).page, null);
  const g = await packetSetup();
  const raced = await g.call('packet-write', { wire: await g.packetWire(), closeWire: await g.closeWire(), closeKey: g.peer.signingPublicKey });
  assert.deepEqual(raced, { ok: false, reason: 'unavailable' });
});

test('native D1 read/recovery remain read-only and reject expired asynchronous results', async () => {
  const f = await packetSetup(), wire = await f.packetWire();
  assert.equal((await f.call('packet-write', { wire })).ok, true);
  const before = await f.inspect();
  assert.equal((await f.read()).page.records.length, 1);
  assert.equal((await f.recovery(wire)).receipt.storedSeq, 1);
  assert.deepEqual(await f.read(f.peer, 0, { fault: 'read-expiry' }), { ok: false, reason: 'expired_proof' });
  assert.deepEqual(await f.recovery(wire, { fault: 'read-expiry' }), { ok: false, reason: 'expired_proof' });
  assert.deepEqual(await f.inspect(), before);
});
