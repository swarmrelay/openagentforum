import { execFileSync, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson, type AgentKeyPair } from '@openagentforum/protocol';
import { RoomAdmissionStore } from '../src/sqlite.js';
import { signRoomRecovery, ROOM_RECOVERY_PROTOCOL } from '../src/recovery.js';
import { createRoomNoiseSession, ROOM_NOISE_LIMITS, type RoomNoiseSession } from '../src/handshake.js';
import {
  ROOM_PACKET_PROTOCOL, ROOM_PACKET_PROFILE, ROOM_PACKET_READ_PROTOCOL, ROOM_PACKET_RECOVERY_PROTOCOL, ROOM_PACKET_LIMITS,
  signRoomPacket, signRoomPacketRead, signRoomPacketRecovery, prepareRoomPacket,
  type RoomPacketWrite, type RoomPacketRead,
} from '../src/packet-wire.js';
import { packetPolicySnapshot, ROOM_PACKET_STORAGE_LIMITS, type RoomPacketPolicy, type RoomPacketScopeLimits,
  type RoomPacketWriteResult, type RoomPacketReceipt } from '../src/packet-storage-contract.js';
import { actionFor, admitted, DatabaseSync, fixture, HUB, START } from './fixtures.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!(); });
const limits = (): RoomPacketScopeLimits => ({ packets: 10_000, bytes: 50_000_000, sessions: 100,
  packetsPerWindow: 10_000, bytesPerWindow: 50_000_000, sessionsPerWindow: 100 });
const policy = (): RoomPacketPolicy => ({ hub: limits(), room: limits(), agent: limits(), windowMs: 60_000 });
let serial = 0;
const id = () => (++serial).toString(16).padStart(32, '0');
function accepted(result: RoomPacketWriteResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Packet fixture: ${result.reason}`);
  return result;
}
async function setup(p = policy(), joined = true, admission = {}) {
  const f = await fixture(admission, p);
  cleanup.push(() => f.close());
  const created = await f.create(); const invited = await f.invite(created.state);
  const accept = await actionFor(f.peer, 'accept', START, invited.state);
  if (joined) admitted(await f.submit(accept, f.peer));
  const roomId = created.state.roomId;
  const sessionId = id();
  const request = (actor = f.owner, patch: Partial<RoomPacketWrite> = {}): RoomPacketWrite => ({
    protocol: ROOM_PACKET_PROTOCOL, hub: HUB, roomId, actor: actor.agentId, signingPublicKey: actor.signingPublicKey,
    issuedAt: f.clock.now, expiresAt: f.clock.now + 60_000, requestId: id(), expectedRevision: 3,
    profile: ROOM_PACKET_PROFILE, sessionId, packetIndex: 0, kind: 'handshake', packetHex: 'ab'.repeat(96), ...patch,
  });
  const wire = (r = request(), actor = f.owner) => signRoomPacket(r, actor.signingPrivateKey);
  const write = async (r = request(), actor = f.owner) => f.store.writePacket(await wire(r, actor));
  const query = (actor = f.owner, patch: Partial<RoomPacketRead> = {}): RoomPacketRead => ({
    protocol: ROOM_PACKET_READ_PROTOCOL, hub: HUB, roomId, actor: actor.agentId, signingPublicKey: actor.signingPublicKey,
    queryId: id(), issuedAt: f.clock.now, expiresAt: f.clock.now + 60_000, expectedRevision: 3, afterStoredSeq: 0, limit: 8, ...patch,
  });
  const read = async (actor = f.owner, q = query(actor)) => f.store.readPackets(await signRoomPacketRead(q, actor.signingPrivateKey));
  const recoveryWire = (r: RoomPacketReceipt, actor = f.owner, patch = {}) => signRoomPacketRecovery({
    protocol: ROOM_PACKET_RECOVERY_PROTOCOL, hub: HUB, roomId: r.roomId, actor: actor.agentId,
    signingPublicKey: actor.signingPublicKey, requestId: r.requestId, proofDigest: r.proofDigest, queryId: id(),
    issuedAt: f.clock.now, expiresAt: f.clock.now + 60_000, ...patch,
  }, actor.signingPrivateKey);
  const snapshot = () => ({ control: f.counts(), rooms: f.db.prepare('SELECT * FROM room_lab_rooms').all(),
    packets: f.db.prepare('SELECT * FROM room_lab_packets ORDER BY room_id, stored_seq').all(),
    sessions: f.db.prepare('SELECT * FROM room_lab_packet_sessions ORDER BY room_id, session_id').all(),
    usage: f.db.prepare('SELECT * FROM room_lab_packet_usage ORDER BY scope').all(),
    windows: f.db.prepare('SELECT * FROM room_lab_packet_windows ORDER BY scope, bucket').all() });
  const handshake = async () => {
    const requests = [request(), request(f.peer, { packetHex: 'ab'.repeat(48) }),
      request(f.owner, { kind: 'confirmation', packetIndex: 1, packetHex: 'ab'.repeat(17) }),
      request(f.peer, { kind: 'confirmation', packetIndex: 1, packetHex: 'ab'.repeat(17) })];
    for (let i = 0; i < requests.length; i++) accepted(await write(requests[i], i % 2 ? f.peer : f.owner));
    return requests;
  };
  return { f, p, created, invited, accept, roomId, sessionId, request, wire, write, query, read, recoveryWire, snapshot, handshake };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const worker = fileURLToPath(new URL('./fixtures/packet-worker.mjs', import.meta.url));
function childConfig(s: Setup, wire: string, patch = {}) {
  return { path: s.f.path, hub: HUB, policy: s.f.policy, packets: s.p, now: s.f.clock.now, wire, method: 'writePacket', ...patch };
}
async function child(configuration: ReturnType<typeof childConfig>) {
  const proc = fork(worker, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  cleanup.push(() => { if (proc.exitCode === null) proc.kill(); });
  let result: RoomPacketWriteResult | undefined;
  const done = new Promise<{ result: RoomPacketWriteResult | undefined; code: number | null }>((resolve, reject) => {
    proc.on('message', (m: any) => { if (m.result) result = m.result; });
    proc.once('error', reject); proc.once('exit', code => resolve({ result, code }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    proc.once('message', (m: any) => m.ready ? resolve() : reject(new Error('Child not ready')));
    proc.once('error', reject); proc.once('exit', () => reject(new Error('Child exited before ready')));
  });
  proc.send(configuration); await ready;
  return { go: () => proc.send({ go: true }), done };
}

describe('opt-in primary packet storage', () => {
  it('is disabled by default, creates no packet tables and rejects altered/partial policy or schema', async () => {
    const f = await fixture(); cleanup.push(() => f.close());
    for (const method of ['writePacket', 'readPackets', 'recoverPacket'] as const)
      expect(await f.store[method]('not a proof')).toEqual({ ok: false, reason: 'not_configured' });
    expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'room_lab_packet%'").all()).toHaveLength(0);
    expect(() => packetPolicySnapshot({ ...policy(), surprise: 1 } as RoomPacketPolicy)).toThrow();
    for (const bad of [-1, 0, 1.5, Infinity, 1_000_001])
      expect(() => packetPolicySnapshot({ ...policy(), hub: { ...limits(), packets: bad } })).toThrow();
    const s = await setup(); const original = s.snapshot();
    const db = new DatabaseSync(s.f.path); cleanup.push(() => db.close());
    expect(() => new RoomAdmissionStore(db, { ...s.f.options, packets: { ...s.p, windowMs: 1 } })).toThrow('initialization');
    expect(s.snapshot()).toEqual(original);
    s.f.db.exec('DROP TABLE room_lab_packet_usage');
    expect(() => new RoomAdmissionStore(db, s.f.options)).toThrow('initialization');
    expect(s.f.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'room_lab_packet_usage'").all()).toHaveLength(0);
  });

  it('requires accepted current full-key membership, not invitation, short ID, columns or a status snapshot', async () => {
    const s = await setup(policy(), false);
    const before = s.snapshot();
    for (const actor of [s.f.owner, s.f.peer, s.f.outsider]) {
      expect(await s.write(s.request(actor, { expectedRevision: 2 }), actor)).toEqual({ ok: false, reason: 'unavailable' });
      expect(await s.read(actor, s.query(actor, { expectedRevision: 2 }))).toMatchObject({ ok: true, page: null });
    }
    expect(s.snapshot()).toEqual(before);
    admitted(await s.f.submit(s.accept, s.f.peer));
    expect(await s.read()).toMatchObject({ ok: true, page: { records: [], nextStoredSeq: null } });
    expect(await s.read(s.f.outsider)).toMatchObject({ ok: true, page: null });
    expect(await s.read(s.f.owner, s.query(s.f.owner, { roomId: `room_${'f'.repeat(32)}` }))).toMatchObject({ ok: true, page: null });
    expect(await s.write(s.request(s.f.owner, { expectedRevision: 2 }))).toEqual({ ok: false, reason: 'unavailable' });
    s.f.db.prepare('UPDATE room_lab_rooms SET owner_id = ?, peer_id = ?').run(s.f.outsider.agentId, s.f.outsider.agentId);
    expect(await s.read(s.f.outsider)).toMatchObject({ ok: true, page: null });
    const room = s.f.room(s.roomId); room.owner.signingPublicKey = s.f.outsider.signingPublicKey;
    s.f.db.prepare('UPDATE room_lab_rooms SET state_json = ?').run(canonicalizeJson(room));
    expect(await s.read()).toMatchObject({ ok: true, page: null });
    expect(await s.write()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('orders handshake flights and both sender counters, preserves wires and deduplicates without quota charges', async () => {
    const s = await setup(); const first = s.request(); const wire = await s.wire(first);
    const one = accepted(await s.f.store.writePacket(wire));
    const before = s.snapshot();
    expect(accepted(await s.f.store.writePacket(wire))).toEqual({ ...one, replayed: true });
    expect(s.snapshot()).toEqual(before);
    for (const r of [s.request(), s.request(s.f.owner, { kind: 'confirmation', packetIndex: 1, packetHex: 'ab'.repeat(17) }),
      s.request(s.f.owner, { kind: 'data', packetIndex: 2, packetHex: 'ab'.repeat(17) }),
      s.request(s.f.owner, { requestId: first.requestId, sessionId: id() })]) {
      expect(await s.write(r)).toEqual({ ok: false, reason: 'unavailable' });
    }
    expect(s.snapshot()).toEqual(before);
    expect(await s.write(s.request(s.f.peer), s.f.peer)).toEqual({ ok: false, reason: 'unavailable' }); // Wrong role's flight length.
    accepted(await s.write(s.request(s.f.peer, { packetHex: 'ab'.repeat(48) }), s.f.peer));
    accepted(await s.write(s.request(s.f.owner, { kind: 'confirmation', packetIndex: 1, packetHex: 'ab'.repeat(17) })));
    accepted(await s.write(s.request(s.f.peer, { kind: 'confirmation', packetIndex: 1, packetHex: 'ab'.repeat(17) }), s.f.peer));
    for (const actor of [s.f.owner, s.f.peer]) accepted(await s.write(s.request(actor, { kind: 'data', packetIndex: 2, packetHex: 'ab'.repeat(17) }), actor));
    const page = await s.read();
    expect(page).toMatchObject({ ok: true, page: { nextStoredSeq: 6 } });
    if (!page.ok || !page.page) throw new Error('Missing page');
    expect(page.page.records.map(r => r.storedSeq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(page.page.records[0].wire).toBe(wire);
    expect(await s.read(s.f.peer, s.query(s.f.peer, { afterStoredSeq: 4, limit: 1 })))
      .toMatchObject({ ok: true, page: { nextStoredSeq: 5, records: [{ storedSeq: 5 }] } });
    expect(await s.read(s.f.peer, s.query(s.f.peer, { afterStoredSeq: 6 })))
      .toMatchObject({ ok: true, page: { nextStoredSeq: null, records: [] } });
    expect(await s.write(s.request(s.f.owner, { kind: 'data', packetIndex: 4, packetHex: 'ab'.repeat(17) })))
      .toEqual({ ok: false, reason: 'unavailable' });
  });

  it('closes packet history access but preserves original-sender receipt recovery and exact historical acknowledgments', async () => {
    const s = await setup(); const wire = await s.wire(); const receipt = accepted(await s.f.store.writePacket(wire)).receipt;
    admitted(await s.f.submit(await actionFor(s.f.peer, 'close', START, s.f.room(s.roomId)), s.f.peer));
    const before = s.snapshot();
    for (const actor of [s.f.owner, s.f.peer, s.f.outsider]) {
      expect(await s.read(actor)).toMatchObject({ ok: true, page: null });
      expect(await s.write(s.request(actor, { sessionId: id(), expectedRevision: 4 }), actor))
        .toEqual({ ok: false, reason: 'unavailable' });
    }
    expect(accepted(await s.f.store.writePacket(wire))).toEqual({ ok: true, replayed: true, receipt });
    s.f.clock.now += 60_000; s.f.restart();
    expect(await s.f.store.writePacket(wire)).toEqual({ ok: false, reason: 'expired_proof' });
    expect(await s.f.store.recoverPacket(await s.recoveryWire(receipt))).toMatchObject({ ok: true, receipt });
    for (const actor of [s.f.peer, s.f.outsider]) expect(await s.f.store.recoverPacket(await s.recoveryWire(receipt, actor)))
      .toMatchObject({ ok: true, receipt: null });
    for (const patch of [{ roomId: `room_${'f'.repeat(32)}` }, { proofDigest: 'f'.repeat(64) }, { requestId: id() }])
      expect(await s.f.store.recoverPacket(await s.recoveryWire(receipt, s.f.owner, patch))).toMatchObject({ ok: true, receipt: null });
    expect(s.snapshot()).toEqual(before);
  });

  it('fences request IDs across rooms, isolates room pages, and shares hub caps across different initiators', async () => {
    const p = policy(); p.hub.sessions = 2;
    const s = await setup(p); const first = s.request(); const a = accepted(await s.write(first)).receipt;
    const second = await s.f.create(); const invitation = await s.f.invite(second.state);
    admitted(await s.f.submit(await actionFor(s.f.peer, 'accept', START, invitation.state), s.f.peer));
    const cross = s.request(s.f.owner, { roomId: second.state.roomId, requestId: first.requestId });
    expect(await s.write(cross)).toEqual({ ok: false, reason: 'unavailable' });
    accepted(await s.write({ ...cross, requestId: id() }));
    expect(await s.read()).toMatchObject({ ok: true, page: { records: [{ storedSeq: 1 }], nextStoredSeq: 1 } });
    const reversed = await s.f.create(s.f.peer); const revInvite = await s.f.invite(reversed.state, s.f.owner, s.f.peer);
    admitted(await s.f.submit(await actionFor(s.f.owner, 'accept', START, revInvite.state), s.f.owner));
    expect(await s.write(s.request(s.f.peer, { roomId: reversed.state.roomId }), s.f.peer)).toEqual({ ok: false, reason: 'unavailable' });
    expect(await s.f.store.recoverPacket(await s.recoveryWire(a, s.f.owner, { roomId: second.state.roomId })))
      .toMatchObject({ ok: true, receipt: null });
    expect(s.snapshot().packets).toHaveLength(2);
  });

  it.each(['hub', 'room', 'agent'] as const)('enforces every retained and fixed-window %s cap without consuming close reservations', async scope => {
    for (const field of ['packets', 'bytes', 'sessions', 'packetsPerWindow', 'bytesPerWindow', 'sessionsPerWindow'] as const) {
      const p = policy(); p[scope][field] = field === 'bytes' || field === 'bytesPerWindow' ? 2200 : 1;
      const s = await setup(p, true, { maxReceipts: 4 });
      accepted(await s.write());
      const before = s.snapshot();
      expect(await s.write(s.request(s.f.owner, { sessionId: id() })), field).toEqual({ ok: false, reason: 'unavailable' });
      expect(s.snapshot()).toEqual(before);
      admitted(await s.f.submit(await actionFor(s.f.peer, 'close', START, s.f.room(s.roomId)), s.f.peer));
      expect(s.f.counts().receipts).toBe(4);
    }
  });

  it('retains authority/capacity across expired sessions, prunes only old windows and leaves reads/recovery strictly read-only', async () => {
    const p = policy(); p.hub.sessionsPerWindow = 1;
    const s = await setup(p); const original = accepted(await s.write()).receipt;
    s.f.clock.now += 60_000;
    expect(await s.write(s.request(s.f.peer, { packetHex: 'ab'.repeat(48) }), s.f.peer)).toEqual({ ok: false, reason: 'unavailable' });
    accepted(await s.write(s.request(s.f.owner, { sessionId: id() })));
    const before = s.snapshot();
    expect(before.packets).toHaveLength(2); expect(before.sessions).toHaveLength(2);
    expect(new Set(before.windows.map(r => r.bucket))).toEqual(new Set([Math.floor(s.f.clock.now / p.windowMs)]));
    s.f.db.exec('PRAGMA query_only = ON');
    expect(await s.read()).toMatchObject({ ok: true, page: { nextStoredSeq: 2 } });
    expect(await s.f.store.recoverPacket(await s.recoveryWire(original))).toMatchObject({ ok: true, receipt: original });
    expect(s.snapshot()).toEqual(before);
    s.f.db.exec('PRAGMA query_only = OFF');
  });

  it('transports real encrypted flights and application bytes through signed storage reads, with closed history denied', async () => {
    const s = await setup(); const sessions: RoomNoiseSession[] = [];
    try {
      const bundle = { create: await s.f.wire(s.created.action), invite: await s.f.wire(s.invited.action),
        accept: await s.f.wire(s.accept, s.f.peer) };
      const pins = { hub: HUB, roomId: s.roomId, ownerSigningPublicKey: s.f.owner.signingPublicKey,
        peerSigningPublicKey: s.f.peer.signingPublicKey };
      for (const role of ['owner', 'peer'] as const) sessions.push(await createRoomNoiseSession({
        role, bundle, pins, encryptionPrivateKey: s.f[role].encryptionPrivateKey, now: () => s.f.clock.now,
      }));
      const [owner, peer] = sessions;
      const transfer = async (packet: Buffer | null, actor: AgentKeyPair, recipient: AgentKeyPair,
        kind: RoomPacketWrite['kind'], packetIndex: number) => {
        if (!packet) throw new Error('Expected flight');
        const request = s.request(actor, { kind, packetIndex, packetHex: packet.toString('hex') });
        const wire = await s.wire(request, actor);
        const result = accepted(await s.f.store.writePacket(wire));
        const response = await s.read(recipient, s.query(recipient, { afterStoredSeq: result.receipt.storedSeq - 1, limit: 1 }));
        if (!response.ok || !response.page || response.page.records.length !== 1) throw new Error('Missing packet page');
        expect(response.page.records[0].wire).toBe(wire);
        const received = await prepareRoomPacket(response.page.records[0].wire, { hub: HUB, now: s.f.clock.now });
        if (!received.ok) throw new Error('Invalid received packet');
        expect(received.request.signingPublicKey).toBe(actor.signingPublicKey);
        return Buffer.from(received.request.packetHex, 'hex');
      };
      const first = await transfer(owner.start(), s.f.owner, s.f.peer, 'handshake', 0);
      const second = await transfer(peer.receiveHandshake(first), s.f.peer, s.f.owner, 'handshake', 0);
      const third = await transfer(owner.receiveHandshake(second), s.f.owner, s.f.peer, 'confirmation', 1);
      const fourth = await transfer(peer.receiveHandshake(third), s.f.peer, s.f.owner, 'confirmation', 1);
      expect(owner.receiveHandshake(fourth)).toBeNull();
      const body = Buffer.from('Peer text is untrusted data, never a remote command.');
      expect(peer.open(await transfer(owner.seal(body), s.f.owner, s.f.peer, 'data', 2)).equals(body)).toBe(true);
      expect(owner.open(await transfer(peer.seal(Buffer.alloc(0)), s.f.peer, s.f.owner, 'data', 2)).length).toBe(0);
      admitted(await s.f.submit(await actionFor(s.f.peer, 'close', START, s.f.room(s.roomId)), s.f.peer));
      expect(await s.read()).toMatchObject({ ok: true, page: null });
      expect(await s.write(s.request(s.f.owner, { kind: 'data', packetIndex: 3, packetHex: owner.seal(body).toString('hex') })))
        .toEqual({ ok: false, reason: 'unavailable' });
      expect(ROOM_PACKET_STORAGE_LIMITS.handshakeLifetimeMs).toBe(ROOM_NOISE_LIMITS.handshakeLifetimeMs);
      expect(ROOM_PACKET_STORAGE_LIMITS.sessionLifetimeMs).toBe(ROOM_NOISE_LIMITS.sessionLifetimeMs);
    } finally { for (const session of sessions) session.close(); }
  });

  it('bounds maximum-sized pages, checks only a bounded number of signatures and indexes the room cursor seek', async () => {
    const s = await setup(); await s.handshake();
    for (let n = 2; n < 12; n++) accepted(await s.write(s.request(s.f.owner,
      { kind: 'data', packetIndex: n, packetHex: 'ab'.repeat(ROOM_PACKET_LIMITS.packetBytes) })));
    const q = await signRoomPacketRead(s.query(s.f.peer, { afterStoredSeq: 4 }), s.f.peer.signingPrivateKey);
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const result = await s.f.store.readPackets(q);
    expect(result).toMatchObject({ ok: true, page: { nextStoredSeq: 12 } });
    if (!result.ok || !result.page) throw new Error('Missing page');
    expect(result.page.records).toHaveLength(8);
    expect(Buffer.byteLength(canonicalizeJson(result))).toBeLessThanOrEqual(ROOM_PACKET_LIMITS.responseBytes);
    expect(verify).toHaveBeenCalledTimes(9); // One query proof plus at most eight stored proofs.
    const plan = s.f.db.prepare('EXPLAIN QUERY PLAN SELECT stored_seq, wire FROM room_lab_packets WHERE room_id = ? AND stored_seq > ? ORDER BY stored_seq LIMIT ?')
      .all(s.roomId, 4, 8);
    expect(plan.some(row => /SEARCH.*INDEX.*room_id=\? AND stored_seq>\?/.test(String(row.detail)))).toBe(true);
    expect(plan.some(row => /TEMP B-TREE|SCAN room_lab_packets/.test(String(row.detail)))).toBe(false);
  });

  it('bounds each direction independently at 1024 frames and expires active sessions without resetting positions', async () => {
    const s = await setup(); await s.handshake();
    for (let n = 2; n <= ROOM_PACKET_LIMITS.lastPacketIndex; n++) accepted(await s.write(s.request(s.f.owner,
      { kind: 'data', packetIndex: n, packetHex: 'ab'.repeat(17) })));
    const before = s.snapshot();
    await expect(s.wire(s.request(s.f.owner, { kind: 'data', packetIndex: 1026, packetHex: 'ab'.repeat(17) }))).rejects.toThrow();
    expect(await s.write(s.request(s.f.owner, { kind: 'data', packetIndex: 1025, packetHex: 'ab'.repeat(17) })))
      .toEqual({ ok: false, reason: 'unavailable' });
    expect(s.snapshot()).toEqual(before);
    accepted(await s.write(s.request(s.f.peer, { kind: 'data', packetIndex: 2, packetHex: 'ab'.repeat(17) }), s.f.peer));
    s.f.clock.now += ROOM_PACKET_STORAGE_LIMITS.sessionLifetimeMs;
    expect(await s.write(s.request(s.f.peer, { kind: 'data', packetIndex: 3, packetHex: 'ab'.repeat(17) }), s.f.peer))
      .toEqual({ ok: false, reason: 'unavailable' });
    expect(await s.write(s.request())).toEqual({ ok: false, reason: 'unavailable' });
    accepted(await s.write(s.request(s.f.owner, { sessionId: id() })));
  }, 20_000);
});

describe('packet failures, races and independent processes', () => {
  it.each(['before', 'after'] as const)('recovers exactly once after a thrown %s-COMMIT result, and poisons every method', async phase => {
    const s = await setup(); const wire = await s.wire(); const exec = s.f.db.exec.bind(s.f.db);
    const spy = vi.spyOn(s.f.db, 'exec').mockImplementation(sql => {
      if (sql === 'COMMIT' && phase === 'before') throw new Error('private driver detail');
      exec(sql);
      if (sql === 'COMMIT' && phase === 'after') throw new Error('private driver detail');
    });
    expect(await s.f.store.writePacket(wire)).toEqual({ ok: false, reason: 'storage_error' }); spy.mockRestore();
    for (const method of ['submit', 'recover', 'readState'] as const)
      expect(await s.f.store[method]('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
    for (const method of ['writePacket', 'readPackets', 'recoverPacket'] as const)
      expect(await s.f.store[method]('invalid')).toEqual({ ok: false, reason: 'storage_error' });
    s.f.restart();
    const recovered = accepted(await s.f.store.writePacket(wire));
    expect(recovered.replayed).toBe(phase === 'after');
    expect(s.snapshot().packets).toHaveLength(1);
    expect(s.snapshot().usage.every(row => row.packets === 1)).toBe(true);
  });

  it.each(['proof', 'session', 'window', 'after-commit'] as const)('guards %s expiry during synchronous SQL without claiming an uncertain write was rejected', async phase => {
    const p = policy(); p.windowMs = 10_000;
    const s = await setup(p);
    if (phase === 'session') { accepted(await s.write()); s.f.clock.now = START + 59_999; }
    const request = phase === 'session' ? s.request(s.f.peer, { packetHex: 'ab'.repeat(48) }) : s.request();
    const wire = await s.wire(request, phase === 'session' ? s.f.peer : s.f.owner);
    const before = s.snapshot();
    if (phase === 'after-commit') {
      const exec = s.f.db.exec.bind(s.f.db);
      vi.spyOn(s.f.db, 'exec').mockImplementation(sql => { exec(sql); if (sql === 'COMMIT') s.f.clock.now = request.expiresAt; });
    } else {
      s.f.db.function('test_clock', () => { s.f.clock.now = phase === 'proof' ? request.expiresAt
        : phase === 'session' ? START + 60_000 : START + 10_000; return 0; });
      s.f.db.exec('CREATE TEMP TRIGGER move_clock AFTER INSERT ON room_lab_packets BEGIN SELECT test_clock(); END;');
    }
    expect(await s.f.store.writePacket(wire)).toEqual({ ok: false, reason: phase === 'proof' ? 'expired_proof'
      : phase === 'session' ? 'unavailable' : phase === 'window' ? 'clock_changed' : 'storage_error' });
    if (phase !== 'after-commit') expect(s.snapshot()).toEqual(before);
    else expect(s.snapshot().packets).toHaveLength(1);
  });

  it('shares verification capacity and poisoned-instance state with control and discards an already-verifying packet', async () => {
    const s = await setup(policy(), true, { maxInFlightPerConnection: 1 }); const wire = await s.wire();
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => { await blocked; return verify(...args); });
    const pending = s.f.store.writePacket(wire);
    for (const method of ['writePacket', 'readPackets', 'recoverPacket'] as const)
      expect(await s.f.store[method]('invalid')).toEqual({ ok: false, reason: 'busy' });
    for (const method of ['submit', 'recover', 'readState'] as const)
      expect(await s.f.store[method]('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
    release(); accepted(await pending); spy.mockRestore();
    const s2 = await setup(policy(), true, { maxInFlightPerConnection: 2 }); const wire2 = await s2.wire();
    const blocked2 = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => { await blocked2; return verify(...args); });
    const pending2 = s2.f.store.writePacket(wire2);
    s2.f.db.exec('DROP TABLE room_lab_meta');
    expect(await s2.f.store.readState('invalid', s2.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
    release(); expect(await pending2).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('observes closure committed while signature verification was pending', async () => {
    const s = await setup(); const wire = await s.wire();
    const close = await s.f.wire(await actionFor(s.f.owner, 'close', START, s.f.room(s.roomId)));
    const verify = crypto.subtle.verify.bind(crypto.subtle); let closed = false;
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      const valid = await verify(...args);
      if (!closed) {
        closed = true;
        const result = JSON.parse(execFileSync(process.execPath, [worker], { input: JSON.stringify(childConfig(s, close,
          { method: 'submit', publicKey: s.f.owner.signingPublicKey })), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }));
        expect(result.ok).toBe(true);
      }
      return valid;
    });
    expect(await s.f.store.writePacket(wire)).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.snapshot().packets).toHaveLength(0);
  });

  it('uses one WAL read snapshot across an overlapping signed close; subsequent reads see closure', async () => {
    const s = await setup(); accepted(await s.write());
    const close = await s.f.wire(await actionFor(s.f.owner, 'close', START, s.f.room(s.roomId)));
    const prepare = s.f.db.prepare.bind(s.f.db); let closed = false;
    const spy = vi.spyOn(s.f.db, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('SELECT state_json') && !closed) {
        closed = true;
        const result = JSON.parse(execFileSync(process.execPath, [worker], { input: JSON.stringify(childConfig(s, close,
          { method: 'submit', publicKey: s.f.owner.signingPublicKey })), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }));
        expect(result.ok).toBe(true);
      }
      return prepare(sql);
    });
    expect(await s.read()).toMatchObject({ ok: true, page: { nextStoredSeq: 1 } });
    spy.mockRestore();
    expect(await s.read()).toMatchObject({ ok: true, page: null });
  });

  it.each(['same-proof', 'same-position', 'hub-cap', 'close'] as const)('serializes independent-process %s races without duplicate charge or lost closure', async mode => {
    const p = policy(); if (mode === 'hub-cap') p.hub.sessions = 1;
    const s = await setup(p); const first = s.request(); const aWire = await s.wire(first);
    const close = await s.f.wire(await actionFor(s.f.owner, 'close', START, s.f.room(s.roomId)));
    const bWire = mode === 'same-proof' ? aWire : mode === 'close' ? close
      : await s.wire(s.request(s.f.owner, { sessionId: mode === 'hub-cap' ? id() : first.sessionId }));
    const a = await child(childConfig(s, aWire));
    const b = await child(childConfig(s, bWire, mode === 'close' ? { method: 'submit', publicKey: s.f.owner.signingPublicKey } : {}));
    a.go(); b.go(); const outcomes = await Promise.all([a.done, b.done]);
    expect(outcomes.map(r => r.code)).toEqual([0, 0]);
    if (mode === 'same-proof') {
      expect(outcomes.map(r => accepted(r.result!).replayed).sort()).toEqual([false, true]);
    } else if (mode === 'close') {
      expect(outcomes[1].result?.ok).toBe(true); expect(s.f.room(s.roomId).status).toBe('closed');
      expect(await s.read()).toMatchObject({ ok: true, page: null });
    } else expect(outcomes.map(r => r.result!.ok).sort()).toEqual([false, true]);
    expect(s.snapshot().packets.length).toBeLessThanOrEqual(1);
    expect(s.snapshot().usage.every(r => r.packets === 1)).toBe(true);
  });

  it.each(['crash-before-packet', 'crash-after-commit'] as const)('reopens after process exit: %s, then recovers with a fresh proof from another process', async mode => {
    const s = await setup(); const wire = await s.wire(); const proc = await child(childConfig(s, wire, { mode }));
    proc.go(); const stopped = await proc.done;
    expect(stopped.code).toBe(mode === 'crash-before-packet' ? 23 : 24);
    s.f.restart();
    const receipt = accepted(await s.f.store.writePacket(wire));
    expect(receipt.replayed).toBe(mode === 'crash-after-commit');
    s.f.clock.now += 60_000;
    const result = JSON.parse(execFileSync(process.execPath, [worker], { input: JSON.stringify(childConfig(s,
      await s.recoveryWire(receipt.receipt), { method: 'recoverPacket' })), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }));
    expect(result).toMatchObject({ ok: true, receipt: receipt.receipt });
    expect(s.snapshot().packets).toHaveLength(1);
  });

  it.each(['write', 'read', 'recover'] as const)('rechecks %s freshness after async authentication without returning or storing data', async kind => {
    const s = await setup(); const receipt = accepted(await s.write()).receipt;
    const wire = kind === 'write' ? await s.wire(s.request(s.f.owner, { sessionId: id() }))
      : kind === 'read' ? await signRoomPacketRead(s.query(), s.f.owner.signingPrivateKey) : await s.recoveryWire(receipt);
    const before = s.snapshot(); const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      const valid = await verify(...args); s.f.clock.now += 60_000; return valid;
    });
    const result = kind === 'write' ? await s.f.store.writePacket(wire)
      : kind === 'read' ? await s.f.store.readPackets(wire) : await s.f.store.recoverPacket(wire);
    expect(result).toEqual({ ok: false, reason: 'expired_proof' });
    expect(s.snapshot()).toEqual(before);
  });

  it('withholds a page that expires during stored-signature verification after SQL, without holding a transaction', async () => {
    const s = await setup(); accepted(await s.write());
    const wire = await signRoomPacketRead(s.query(), s.f.owner.signingPrivateKey);
    const before = s.snapshot(); const verify = crypto.subtle.verify.bind(crypto.subtle); let calls = 0;
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      const valid = await verify(...args);
      if (++calls === 2) {
        s.f.db.exec('BEGIN'); s.f.db.exec('ROLLBACK'); // No transaction held across this await.
        s.f.clock.now += 60_000;
      }
      return valid;
    });
    expect(await s.f.store.readPackets(wire)).toEqual({ ok: false, reason: 'expired_proof' });
    expect(s.snapshot()).toEqual(before);
  });

  it.each(['submit', 'recover'] as const)('gives poisoning precedence over a pending invalid %s signature', async method => {
    const s = await setup(policy(), true, { maxInFlightPerConnection: 2 });
    const valid = method === 'submit' ? await s.f.wire(s.created.action) : await signRoomRecovery({
      protocol: ROOM_RECOVERY_PROTOCOL, hub: HUB, roomId: s.roomId, actor: s.f.owner.agentId,
      queryId: id(), requestId: s.created.action.requestId, proofDigest: s.created.result.receipt.proofDigest,
      issuedAt: START, expiresAt: START + 60_000,
    }, s.f.owner.signingPrivateKey);
    const wire = canonicalizeJson({ ...JSON.parse(valid), signature: '0'.repeat(128) });
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => { entered(); await blocked; return verify(...args); });
    const pending = s.f.store[method](wire, s.f.owner.signingPublicKey); await started;
    s.f.db.exec("UPDATE room_lab_packet_meta SET policy = '{}'");
    expect(await s.f.store.recoverPacket('invalid')).toEqual({ ok: false, reason: 'storage_error' });
    release(); expect(await pending).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('discards a page already verifying when a second operation poisons the instance', async () => {
    const s = await setup(); accepted(await s.write());
    const wire = await signRoomPacketRead(s.query(), s.f.owner.signingPrivateKey);
    let release!: () => void, entered!: () => void, calls = 0;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      if (++calls === 2) { entered(); await blocked; }
      return verify(...args);
    });
    const pending = s.f.store.readPackets(wire); await started;
    s.f.db.exec("UPDATE room_lab_packet_meta SET policy = '{}'");
    expect(await s.f.store.recoverPacket('invalid')).toEqual({ ok: false, reason: 'storage_error' });
    release(); expect(await pending).toEqual({ ok: false, reason: 'storage_error' });
  });

  it.each(['room', 'wire', 'binding', 'receipt', 'policy', 'clock-regression', 'session'] as const)
  ('fails closed and redacts corrupt %s state', async fault => {
    const s = await setup(); const receipt = accepted(await s.write()).receipt;
    if (fault === 'room') s.f.db.exec("UPDATE room_lab_rooms SET state_json = '{}'");
    if (fault === 'wire') s.f.db.exec("UPDATE room_lab_packets SET wire = '{}'");
    if (fault === 'binding') s.f.db.exec("UPDATE room_lab_packets SET digest = 'bad'");
    if (fault === 'receipt') s.f.db.exec("UPDATE room_lab_packets SET receipt_json = '{}'");
    if (fault === 'policy') s.f.db.exec("UPDATE room_lab_packet_meta SET policy = '{}'");
    if (fault === 'session') s.f.db.exec('UPDATE room_lab_packet_sessions SET owner_next = 2');
    if (fault === 'clock-regression') {
      const verify = crypto.subtle.verify.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
        const valid = await verify(...args); s.f.db.exec('UPDATE room_lab_meta SET clock = 0'); return valid;
      });
    }
    const result = fault === 'receipt' ? await s.f.store.recoverPacket(await s.recoveryWire(receipt))
      : fault === 'session' ? await s.write(s.request(s.f.peer, { packetHex: 'ab'.repeat(48) }), s.f.peer) : await s.read();
    expect(result).toEqual({ ok: false, reason: 'storage_error' });
    expect(await s.f.store.submit('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
  });
});
