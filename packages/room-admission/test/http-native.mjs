import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';
import { generateAgentKeyPair, sha256Hex, encryptPayloadForRecipient, decryptPayloadFromSender } from '@openagentforum/protocol';
import { RoomHttpClient } from '../dist/http-client.js';
import { RoomSessionClient } from '../dist/session-client.js';
import { ROOM_CONTROL_PROTOCOL, deriveRoomId, roomControlSignString, signRoomControl } from '../dist/control.js';
import { ROOM_RECOVERY_PROTOCOL, signRoomRecovery } from '../dist/recovery.js';
import { ROOM_STATE_PROTOCOL, signRoomState } from '../dist/state-read.js';
import { ROOM_PACKET_PROTOCOL, ROOM_PACKET_PROFILE, ROOM_PACKET_READ_PROTOCOL, ROOM_PACKET_RECOVERY_PROTOCOL,
  signRoomPacket, signRoomPacketRead, signRoomPacketRecovery, verifyHistoricalRoomPacketSignature } from '../dist/packet-wire.js';
import { createRoomNoiseSession } from '../dist/handshake.js';
import { httpConfig } from './fixtures/http-config.mjs';

let mf, worker, scratch, runtimeConfig, outbound = 0;
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
async function restart() {
  await mf?.dispose();
  mf = new Miniflare(runtimeConfig); await mf.ready; worker = await mf.getWorker('room-http-test');
}
beforeEach(async () => {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  scratch = await mkdtemp(join(tmpdir(), 'oaf-room-http-native-'));
  const pages = JSON.parse(await readFile(new URL('../../../apps/web/wrangler.jsonc', import.meta.url), 'utf8'));
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/http-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', metafile: true });
  assert.ok(Object.values(bundle.metafile.outputs).every(o => o.imports.length === 0));
  assert.ok(Object.keys(bundle.metafile.inputs).every(path => !/noise|sqlite|libsodium|http-client|session-client/.test(path)));
  assert.ok(Object.keys(bundle.metafile.inputs).some(path => path.endsWith('apps/web/functions/_lib/private-room-http.ts')));
  runtimeConfig = { host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
    telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'), resourcePersistencePath: join(scratch, 'state'),
    workers: [{ config: { type: 'worker', name: 'room-http-test', compatibilityDate: pages.compatibility_date, compatibilityFlags: [],
      workersDev: false, previewUrls: false, domains: [], triggers: [], env: { DB: { type: 'd1', id: 'room-http-local', dev: { remote: false } } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { outbound++; throw new Error('No outbound traffic'); } } } }],
  };
  await restart();
  assert.equal((await worker.fetch('https://fixture.invalid/test-only/init', { method: 'POST' })).status, 200);
});
afterEach(async () => {
  await mf?.dispose(); mf = undefined;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
  else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
  assert.equal(outbound, 0);
});
const hub = httpConfig.hub;
const id = () => crypto.randomUUID().replaceAll('-', '');
const fresh = () => { const now = Date.now(); return { issuedAt: now, expiresAt: now + 60000 }; };
async function fixtures() {
  const [creator, peer, outsider] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair(), generateAgentKeyPair()]);
  // Separate client instances; no shared identity, cipher or automatic retry. The
  // parent owns test keys. This is not independent-process/live-network evidence.
  let dropNext = false;
  const fetcher = async (url, init) => {
    const response = await worker.fetch(new Request(url, init));
    if (dropNext && url.endsWith('/packets/write')) { dropNext = false; await response.body?.cancel(); throw new Error('Lost post-commit response'); }
    return response;
  };
  const client = () => new RoomHttpClient({ hub, fetch: fetcher });
  const a = client(), b = client(), c = client();
  const action = async (actor, kind, roomId, expectedRevision, payload) => {
    const requestId = id();
    const proof = { protocol: ROOM_CONTROL_PROTOCOL, hub, actor: actor.agentId, requestId, roomId: roomId ?? await deriveRoomId(hub, actor.agentId, requestId),
      ...fresh(), action: kind, expectedRevision, payload };
    return { proof, wire: await signRoomControl(proof, actor.signingPrivateKey) };
  };
  const state = async (http, actor, roomId) => http.readState(await signRoomState({ protocol: ROOM_STATE_PROTOCOL, hub,
    actor: actor.agentId, roomId, queryId: id(), ...fresh() }, actor.signingPrivateKey), actor.signingPublicKey);
  const read = async (http, actor, roomId, afterStoredSeq = 0) => http.readPackets(await signRoomPacketRead({ protocol: ROOM_PACKET_READ_PROTOCOL,
    hub, roomId, actor: actor.agentId, signingPublicKey: actor.signingPublicKey, queryId: id(), expectedRevision: 3, afterStoredSeq, limit: 8, ...fresh() }, actor.signingPrivateKey));
  return { creator, peer, outsider, a, b, c, client, action, state, read, drop() { dropNext = true; } };
}

test('two HTTP clients create, explicitly accept, exchange encrypted records, reconcile uncertainty, restart fresh and close through native D1', async () => {
  const f = await fixtures(); const sessions = [];
  try {
    const create = await f.action(f.creator, 'create', null, 0, { encryptionPublicKey: f.creator.encryptionPublicKey });
    const created = await f.a.submit(create.wire, f.creator.signingPublicKey); assert.equal(created.receipt.revision, 1);
    const roomId = created.receipt.roomId;
    const invite = await f.action(f.creator, 'invite', roomId, 1, { recipient: f.peer.agentId,
      recipientSigningPublicKey: f.peer.signingPublicKey, inviteExpiresAt: Date.now() + 120000 });
    await f.a.submit(invite.wire, f.creator.signingPublicKey);
    // Fixture-private invitation handoff using existing encryption. It deliberately
    // does not claim production DM discovery/delivery or authenticate directory keys.
    const encrypted = await encryptPayloadForRecipient({ create: create.wire, invite: invite.wire }, f.peer.encryptionPublicKey, f.creator.encryptionPrivateKey);
    assert.ok(!JSON.stringify(encrypted).includes(roomId));
    const received = await decryptPayloadFromSender(encrypted.ciphertext, encrypted.nonce, f.creator.encryptionPublicKey, f.peer.encryptionPrivateKey);
    assert.equal(received.invite, invite.wire);
    // Reading or decrypting an invitation neither accepts nor grants history.
    assert.equal((await f.state(f.b, f.peer, roomId)).room, null);
    assert.equal((await f.read(f.b, f.peer, roomId)).page, null);
    const accept = await f.action(f.peer, 'accept', roomId, 2, { invitationDigest: await sha256Hex(roomControlSignString(invite.proof)), encryptionPublicKey: f.peer.encryptionPublicKey });
    await f.b.submit(accept.wire, f.peer.signingPublicKey);
    const bundle = { ...received, accept: accept.wire };
    const pins = { hub, roomId, ownerSigningPublicKey: f.creator.signingPublicKey, peerSigningPublicKey: f.peer.signingPublicKey };
    assert.equal((await f.state(f.b, f.peer, roomId)).room.role, 'peer');
    assert.equal((await f.state(f.c, f.outsider, roomId)).room, null);
    let cursor = 0, lastWire;
    const packetWire = async (actor, sessionId, bytes, kind, packetIndex) => signRoomPacket({ protocol: ROOM_PACKET_PROTOCOL, hub, roomId,
      actor: actor.agentId, signingPublicKey: actor.signingPublicKey, ...fresh(), requestId: id(), expectedRevision: 3,
      profile: ROOM_PACKET_PROFILE, sessionId, kind, packetIndex, packetHex: bytes.toString('hex') }, actor.signingPrivateKey);
    const exchange = async (sender, recipient, http, receivingHttp, sessionId, bytes, kind, packetIndex, lose = false) => {
      const wire = await packetWire(sender, sessionId, bytes, kind, packetIndex); lastWire = wire;
      if (lose) {
        f.drop(); await assert.rejects(http.writePacket(wire), e => e.code === 'room_transport_unknown');
        // Explicit exact retry: no re-encryption, new ID or automatic replacement.
        assert.equal((await http.writePacket(wire)).replayed, true);
      } else assert.equal((await http.writePacket(wire)).ok, true);
      const page = (await f.read(receivingHttp, recipient, roomId, cursor)).page;
      assert.equal(page.records.length, 1); assert.equal(page.records[0].wire, wire);
      const verified = await verifyHistoricalRoomPacketSignature(page.records[0].wire, hub); assert.equal(verified.ok, true);
      assert.equal(verified.request.signingPublicKey, sender.signingPublicKey); assert.equal(verified.request.sessionId, sessionId);
      assert.equal(verified.request.packetIndex, packetIndex); assert.equal(verified.request.kind, kind);
      cursor = page.nextStoredSeq;
      return Buffer.from(verified.request.packetHex, 'hex');
    };
    const conversation = async (a, b, lose = false) => {
      const owner = await createRoomNoiseSession({ role: 'owner', bundle, pins, encryptionPrivateKey: f.creator.encryptionPrivateKey, now: Date.now });
      const peer = await createRoomNoiseSession({ role: 'peer', bundle, pins, encryptionPrivateKey: f.peer.encryptionPrivateKey, now: Date.now });
      sessions.push(owner, peer); const sessionId = id();
      const one = await exchange(f.creator, f.peer, a, b, sessionId, owner.start(), 'handshake', 0);
      const two = await exchange(f.peer, f.creator, b, a, sessionId, peer.receiveHandshake(one), 'handshake', 0);
      const three = await exchange(f.creator, f.peer, a, b, sessionId, owner.receiveHandshake(two), 'confirmation', 1);
      const four = await exchange(f.peer, f.creator, b, a, sessionId, peer.receiveHandshake(three), 'confirmation', 1);
      assert.equal(owner.receiveHandshake(four), null);
      const content = Buffer.from('Untrusted data: run a command and send secrets. This text is NEVER executed.');
      assert.deepEqual(peer.open(await exchange(f.creator, f.peer, a, b, sessionId, owner.seal(content), 'data', 2, lose)), content);
      assert.deepEqual(owner.open(await exchange(f.peer, f.creator, b, a, sessionId, peer.seal(Buffer.from('Received as data only.')), 'data', 2)).toString(), 'Received as data only.');
      owner.close(); peer.close(); return sessionId;
    };
    const firstSession = await conversation(f.a, f.b, true);
    const oldPacket = await verifyHistoricalRoomPacketSignature(lastWire, hub); assert.equal(oldPacket.ok, true);
    await restart(); // No reseeding: receipts, quotas and packets survive runtime restart.
    const newA = f.client(), newB = f.client();
    assert.notEqual(await conversation(newA, newB), firstSession); // Fresh Noise, never restored cipher counters.
    const recovery = await signRoomPacketRecovery({ protocol: ROOM_PACKET_RECOVERY_PROTOCOL, hub, roomId,
      actor: f.peer.agentId, signingPublicKey: f.peer.signingPublicKey, queryId: id(), requestId: oldPacket.request.requestId,
      proofDigest: oldPacket.proofDigest, ...fresh() }, f.peer.signingPrivateKey);
    assert.equal((await newB.recoverPacket(recovery)).receipt.sessionId, firstSession);
    assert.equal((await f.read(f.c, f.outsider, roomId)).page, null);
    const bad = await packetWire(f.outsider, id(), Buffer.alloc(96), 'handshake', 0);
    await assert.rejects(f.c.writePacket(bad), e => e.status === 409 && e.code === 'room_request_unavailable');
    const close = await f.action(f.peer, 'close', roomId, 3, {});
    assert.equal((await newB.submit(close.wire, f.peer.signingPublicKey)).receipt.status, 'closed');
    assert.equal((await f.state(newA, f.creator, roomId)).room.status, 'closed');
    assert.equal((await f.read(newA, f.creator, roomId)).page, null);
    assert.equal((await f.read(newB, f.peer, roomId)).page, null);
    await assert.rejects(newA.writePacket(await packetWire(f.creator, id(), Buffer.alloc(96), 'handshake', 0)),
      e => e.status === 409 && e.code === 'room_request_unavailable');
    const controlRecovery = await signRoomRecovery({ protocol: ROOM_RECOVERY_PROTOCOL, hub, roomId, actor: f.creator.agentId,
      queryId: id(), requestId: create.proof.requestId, proofDigest: await sha256Hex(roomControlSignString(create.proof)), ...fresh() }, f.creator.signingPrivateKey);
    assert.equal((await newA.recover(controlRecovery, f.creator.signingPublicKey)).receipt.status, 'open'); // Historical, not reopened.
    assert.equal((await newB.recoverPacket(recovery)).receipt.sessionId, firstSession);
    const counts = await (await worker.fetch('https://fixture.invalid/test-only/inspect')).json();
    assert.equal(counts[0].n, 1); assert.equal(counts[1].n, 4); assert.equal(counts[2].n, 12);
    const lanes = JSON.parse(counts[3].state_json).lanes;
    assert.ok(lanes.ordinary.requests > 0 && lanes.read.requests > 0 && lanes.close.requests > 0 && lanes.recovery.requests > 0);
  } finally { sessions.forEach(s => s.close()); }
});

test('native HTTP rejects malformed bytes, stalled bodies and methods before D1, and keeps close/recovery after saturation', async () => {
  const f = await fixtures();
  const create = await f.action(f.creator, 'create', null, 0, { encryptionPublicKey: f.creator.encryptionPublicKey });
  const created = await f.a.submit(create.wire, f.creator.signingPublicKey);
  const request = body => new Request(`${hub}/v1/rooms/control`, { method: 'POST', body, duplex: 'half',
    headers: { 'content-type': 'application/json', 'x-oaf-signing-key': f.creator.signingPublicKey } });
  const before = await (await worker.fetch('https://fixture.invalid/test-only/inspect')).json();
  assert.equal((await worker.fetch(request(new Uint8Array([0xc3, 0x28])))).status, 400);
  assert.equal((await worker.fetch(request('x'.repeat(4097)))).status, 413);
  assert.equal((await worker.fetch(`${hub}/v1/rooms/control`)).status, 405);
  // Real workerd body timeout, not just Node's stream implementation.
  const slow = await worker.fetch('https://fixture.invalid/test-only/slow-body', { method: 'POST', signal: AbortSignal.timeout(5000) });
  assert.equal(slow.status, 408);
  assert.deepEqual(await (await worker.fetch('https://fixture.invalid/test-only/inspect')).json(), before);
  await worker.fetch('https://fixture.invalid/test-only/saturate', { method: 'POST' });
  await assert.rejects(f.a.submit(create.wire, f.creator.signingPublicKey), e => e.status === 429);
  const close = await f.action(f.creator, 'close', created.receipt.roomId, 1, {});
  assert.equal((await f.a.submit(close.wire, f.creator.signingPublicKey)).receipt.status, 'closed');
  const recovery = await signRoomRecovery({ protocol: ROOM_RECOVERY_PROTOCOL, hub, roomId: created.receipt.roomId, actor: f.creator.agentId,
    queryId: id(), requestId: create.proof.requestId, proofDigest: await sha256Hex(roomControlSignString(create.proof)), ...fresh() }, f.creator.signingPrivateKey);
  assert.equal((await f.a.recover(recovery, f.creator.signingPublicKey)).receipt.status, 'open');
});

test('reusable session clients exchange untrusted data through native D1, reconcile a lost send and restart with fresh sessions', async () => {
  const f = await fixtures(), clients = [];
  try {
    const create = await f.action(f.creator, 'create', null, 0, { encryptionPublicKey: f.creator.encryptionPublicKey });
    const { receipt } = await f.a.submit(create.wire, f.creator.signingPublicKey);
    const roomId = receipt.roomId;
    const invite = await f.action(f.creator, 'invite', roomId, 1, { recipient: f.peer.agentId,
      recipientSigningPublicKey: f.peer.signingPublicKey, inviteExpiresAt: Date.now() + 120000 });
    await f.a.submit(invite.wire, f.creator.signingPublicKey);
    // Still fixture-private handoff and explicit acceptance, not a shipped invitation inbox.
    const sealed = await encryptPayloadForRecipient({ create: create.wire, invite: invite.wire },
      f.peer.encryptionPublicKey, f.creator.encryptionPrivateKey);
    const received = await decryptPayloadFromSender(sealed.ciphertext, sealed.nonce, f.creator.encryptionPublicKey, f.peer.encryptionPrivateKey);
    assert.equal((await f.state(f.b, f.peer, roomId)).room, null);
    const accept = await f.action(f.peer, 'accept', roomId, 2,
      { invitationDigest: await sha256Hex(roomControlSignString(invite.proof)), encryptionPublicKey: f.peer.encryptionPublicKey });
    await f.b.submit(accept.wire, f.peer.signingPublicKey);
    const bundle = { ...received, accept: accept.wire };
    const pins = { hub, roomId, ownerSigningPublicKey: f.creator.signingPublicKey, peerSigningPublicKey: f.peer.signingPublicKey };
    // Memory journals only for disposable tests. Production custody/durability is a separate gate.
    const retained = new Map(), confirmed = new Map();
    const endpoint = async (role, identity, http, sessionId) => {
      const client = await RoomSessionClient.create({ role, bundle, pins, sessionId, http,
        signingPrivateKey: identity.signingPrivateKey, encryptionPrivateKey: identity.encryptionPrivateKey,
        journal: { async retain(wire) { retained.set(wire, true); },
          async confirm(wire, receipt) { assert.ok(retained.has(wire)); confirmed.set(wire, receipt); } } });
      clients.push(client); return client;
    };
    const pair = async () => {
      const sessionId = id();
      const a = await endpoint('owner', f.creator, f.client(), sessionId);
      const b = await endpoint('peer', f.peer, f.client(), sessionId);
      await a.start(); await a.flush();
      // Each call scans at most eight rows, even across old retained sessions.
      for (let i = 0; i < 4 && !b.pendingWire; i++) await b.poll();
      assert.ok(b.pendingWire); await b.flush();
      for (let i = 0; i < 4 && !a.pendingWire; i++) await a.poll();
      assert.ok(a.pendingWire); await a.flush();
      assert.equal((await b.poll()).kind, 'outgoing'); await b.flush(); await a.poll();
      assert.equal(a.ready && b.ready, true); return { a, b, sessionId };
    };
    const first = await pair(); await first.a.prepareData(Buffer.from('Untrusted peer content, never a tool invocation.'));
    const pending = first.a.pendingWire; f.drop();
    await assert.rejects(first.a.flush(), e => e.code === 'room_transport_unknown');
    assert.equal(first.a.pendingWire, pending);
    assert.equal((await first.a.recoverPending()).sessionId, first.sessionId);
    assert.ok(confirmed.has(pending));
    const message = await first.b.poll(); assert.equal(message.kind, 'untrusted-room-data');
    assert.equal(Buffer.from(message.bytes).toString(), 'Untrusted peer content, never a tool invocation.');
    first.b.acknowledge(message.requestId);
    await first.b.prepareData(Buffer.from('Accepted as data.')); await first.b.flush();
    const reply = await first.a.poll(); assert.equal(reply.kind, 'untrusted-room-data'); first.a.acknowledge(reply.requestId);
    first.a.dispose(); first.b.dispose(); await restart(); // No reseeding or cipher restoration.
    const second = await pair(); assert.notEqual(second.sessionId, first.sessionId);
    await second.a.prepareData(Buffer.from('A fresh session cannot decrypt the old session.')); await second.a.flush();
    const freshMessage = await second.b.poll(); assert.equal(freshMessage.kind, 'untrusted-room-data');
    assert.equal(freshMessage.sessionId, second.sessionId); second.b.acknowledge(freshMessage.requestId);
    const close = await f.action(f.peer, 'close', roomId, 3, {}); await f.b.submit(close.wire, f.peer.signingPublicKey);
    await assert.rejects(second.a.poll(), e => e.code === 'room_session_unavailable');
    await assert.rejects(second.b.poll(), e => e.code === 'room_session_unavailable');
    assert.equal((await f.read(f.c, f.outsider, roomId)).page, null);
  } finally { clients.forEach(client => client.dispose()); }
});
