import { afterEach, expect, it, vi } from 'vitest';
import { canonicalizeJson } from '@openagentforum/protocol';
import { D1RoomAdmissionStore, initializeD1RoomAdmission } from '../src/d1-admission.js';
import { RoomAdmissionStore } from '../src/sqlite.js';
import { ROOM_PACKET_PROTOCOL, ROOM_PACKET_PROFILE, ROOM_PACKET_READ_PROTOCOL, ROOM_PACKET_RECOVERY_PROTOCOL,
  signRoomPacket, signRoomPacketRead, signRoomPacketRecovery, type RoomPacketWrite } from '../src/packet-wire.js';
import type { RoomPacketPolicy, RoomPacketReceipt, RoomPacketWriteResult } from '../src/packet-storage-contract.js';
import { actionFor, admitted, fixture, HUB, START } from './fixtures.js';
import { TestD1 } from './d1-fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanups.length) cleanups.pop()!(); });
let counter = 0;
const id = () => (++counter).toString(16).padStart(32, '0');
const limits = () => ({ packets: 10000, bytes: 50_000_000, sessions: 100, packetsPerWindow: 10000, bytesPerWindow: 50_000_000, sessionsPerWindow: 100 });
const policy = (): RoomPacketPolicy => ({ hub: limits(), room: limits(), agent: limits(), windowMs: 60000 });
function accepted(r: RoomPacketWriteResult) { expect(r.ok).toBe(true); if (!r.ok) throw new Error(r.reason); return r; }
async function setup(packets = policy(), joined = true, admission = {}) {
  const f = await fixture(admission); cleanups.push(() => f.close());
  f.db.function('unixepoch', { varargs: true }, () => f.clock.now / 1000);
  const db = new TestD1(f.db), options = { ...f.options, packets };
  await initializeD1RoomAdmission(db, options);
  const store = new D1RoomAdmissionStore(db, options);
  const create = await actionFor(f.owner, 'create');
  admitted(await store.submit(await f.wire(create), f.owner.signingPublicKey));
  const invite = await actionFor(f.owner, 'invite', START, f.room(create.roomId), f.peer);
  admitted(await store.submit(await f.wire(invite), f.owner.signingPublicKey));
  const accept = await actionFor(f.peer, 'accept', START, f.room(create.roomId));
  if (joined) admitted(await store.submit(await f.wire(accept, f.peer), f.peer.signingPublicKey));
  const sessionId = id(), roomId = create.roomId;
  const request = (actor = f.owner, patch: Partial<RoomPacketWrite> = {}): RoomPacketWrite => ({ protocol: ROOM_PACKET_PROTOCOL,
    hub: HUB, roomId, actor: actor.agentId, signingPublicKey: actor.signingPublicKey, requestId: id(),
    issuedAt: f.clock.now, expiresAt: f.clock.now + 60000, expectedRevision: 3, profile: ROOM_PACKET_PROFILE,
    sessionId, packetIndex: 0, kind: 'handshake', packetHex: 'ab'.repeat(96), ...patch });
  const wire = (r = request(), actor = f.owner) => signRoomPacket(r, actor.signingPrivateKey);
  const write = async (r = request(), actor = f.owner) => store.writePacket(await wire(r, actor));
  const readWire = (actor = f.owner, patch = {}) => signRoomPacketRead({ protocol: ROOM_PACKET_READ_PROTOCOL,
    hub: HUB, roomId, actor: actor.agentId, signingPublicKey: actor.signingPublicKey, queryId: id(),
    issuedAt: f.clock.now, expiresAt: f.clock.now + 60000, expectedRevision: 3, afterStoredSeq: 0, limit: 8, ...patch }, actor.signingPrivateKey);
  const recoverWire = (r: RoomPacketReceipt, actor = f.owner, patch = {}) => signRoomPacketRecovery({
    protocol: ROOM_PACKET_RECOVERY_PROTOCOL, hub: HUB, roomId, actor: actor.agentId, signingPublicKey: actor.signingPublicKey,
    queryId: id(), requestId: r.requestId, proofDigest: r.proofDigest, issuedAt: f.clock.now, expiresAt: f.clock.now + 60000, ...patch }, actor.signingPrivateKey);
  const close = async () => {
    const a = await actionFor(f.peer, 'close', f.clock.now, f.room(roomId));
    return new D1RoomAdmissionStore(db, options).submit(await f.wire(a, f.peer), f.peer.signingPublicKey);
  };
  const snapshot = () => Object.fromEntries(['room_lab_meta', 'room_lab_rooms', 'room_lab_receipts', 'room_lab_budgets',
    'room_lab_packets', 'room_lab_packet_sessions', 'room_lab_packet_usage', 'room_lab_packet_windows', 'room_lab_d1_packet_gate']
    .map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const handshake = async () => {
    accepted(await write());
    accepted(await write(request(f.peer, { packetHex: 'ab'.repeat(48) }), f.peer));
    accepted(await write(request(f.owner, { kind: 'confirmation', packetIndex: 1, packetHex: 'ab'.repeat(17) })));
    accepted(await write(request(f.peer, { kind: 'confirmation', packetIndex: 1, packetHex: 'ab'.repeat(17) }), f.peer));
  };
  return { f, db, options, store, roomId, request, wire, write, readWire, recoverWire, close, snapshot, handshake, accept };
}

it('is opt-in, has no constructor I/O, pins policy and rejects partial schema without recreation', async () => {
  const f = await fixture(); cleanups.push(() => f.close());
  const db = new TestD1(f.db), store = new D1RoomAdmissionStore(db, f.options);
  for (const method of ['writePacket', 'readPackets', 'recoverPacket'] as const)
    expect(await store[method]('invalid')).toEqual({ ok: false, reason: 'not_configured' });
  expect(db.calls).toHaveLength(0);
  expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'room_lab_packet%'").all()).toHaveLength(0);
  const s = await setup(), before = s.snapshot();
  await expect(initializeD1RoomAdmission(s.db, { ...s.options, packets: { ...s.options.packets, windowMs: 1 } })).rejects.toThrow('initialization');
  expect(s.snapshot()).toEqual(before);
  s.f.db.exec('DROP TABLE room_lab_packet_usage');
  await expect(initializeD1RoomAdmission(s.db, s.options)).rejects.toThrow('initialization');
  expect(s.f.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'room_lab_packet_usage'").all()).toHaveLength(0);
});

it('enforces current accepted full keys, same-snapshot pages and closed history with historical own recovery', async () => {
  const s = await setup(policy(), false);
  for (const actor of [s.f.owner, s.f.peer, s.f.outsider]) {
    expect(await s.write(s.request(actor, { expectedRevision: 2 }), actor)).toEqual({ ok: false, reason: 'unavailable' });
    expect(await s.store.readPackets(await s.readWire(actor, { expectedRevision: 2 }))).toMatchObject({ ok: true, page: null });
  }
  admitted(await s.store.submit(await s.f.wire(s.accept, s.f.peer), s.f.peer.signingPublicKey));
  const wire = await s.wire(), first = accepted(await s.store.writePacket(wire));
  expect(await s.store.readPackets(await s.readWire(s.f.peer))).toMatchObject({ ok: true, page: { records: [{ storedSeq: 1, wire }] } });
  expect(await s.store.readPackets(await s.readWire(s.f.outsider))).toMatchObject({ ok: true, page: null });
  expect(await s.store.recoverPacket(await s.recoverWire(first.receipt, s.f.peer))).toMatchObject({ ok: true, receipt: null });
  admitted(await s.close());
  expect(await s.store.readPackets(await s.readWire())).toMatchObject({ ok: true, page: null });
  expect(await s.write()).toEqual({ ok: false, reason: 'unavailable' });
  expect(await s.store.writePacket(wire)).toEqual({ ...first, replayed: true });
  s.f.clock.now += 60000;
  expect(await s.store.recoverPacket(await s.recoverWire(first.receipt))).toMatchObject({ ok: true, receipt: first.receipt });
});

it('uses one shared session state machine and wire contract across SQLite and D1', async () => {
  const s = await setup();
  const sqlite = new RoomAdmissionStore(s.f.db, s.options);
  const wires = [await s.wire(), await s.wire(s.request(s.f.peer, { packetHex: 'ab'.repeat(48) }), s.f.peer),
    await s.wire(s.request(s.f.owner, { kind: 'confirmation', packetIndex: 1, packetHex: 'ab'.repeat(17) })),
    await s.wire(s.request(s.f.peer, { kind: 'confirmation', packetIndex: 1, packetHex: 'ab'.repeat(17) }), s.f.peer)];
  for (const [i, wire] of wires.entries()) accepted(await (i % 2 ? sqlite : s.store).writePacket(wire));
  const data = s.request(s.f.owner, { kind: 'data', packetIndex: 2, packetHex: 'cd'.repeat(17) });
  const receipt = accepted(await s.write(data)).receipt;
  const query = await s.readWire(), recovery = await s.recoverWire(receipt);
  expect(await s.store.readPackets(query)).toEqual(await sqlite.readPackets(query));
  expect(await s.store.recoverPacket(recovery)).toEqual(await sqlite.recoverPacket(recovery));
  const before = s.snapshot();
  for (const target of [s.store, sqlite]) {
    expect(await target.writePacket(await s.wire(data))).toMatchObject({ ok: true, replayed: true });
    expect(await target.writePacket(await s.wire({ ...data, requestId: id() }))).toEqual({ ok: false, reason: 'unavailable' });
  }
  expect(s.snapshot()).toEqual(before);
});

it.each(['hub', 'room', 'agent'] as const)('enforces every %s lifetime/window budget and preserves close capacity', async scope => {
  for (const field of ['packets', 'bytes', 'sessions', 'packetsPerWindow', 'bytesPerWindow', 'sessionsPerWindow'] as const) {
    const p = policy(); p[scope][field] = 1;
    const s = await setup(p, true, { maxReceipts: 4 });
    if (field !== 'bytes' && field !== 'bytesPerWindow') accepted(await s.write());
    const before = s.snapshot();
    expect(await s.write(s.request(s.f.owner, { sessionId: id() }))).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.snapshot()).toEqual(before);
    admitted(await s.close());
  }
});

it('charges exact wire plus receipt bytes once, bounds indexed pages, and performs no read writes at saturation', async () => {
  const s = await setup(); await s.handshake();
  for (let packetIndex = 2; packetIndex < 10; packetIndex++) accepted(await s.write(s.request(s.f.owner,
    { kind: 'data', packetIndex, packetHex: 'ab'.repeat(16401) })));
  const wire = await s.readWire(s.f.peer, { afterStoredSeq: 4 }), before = s.snapshot();
  s.db.beforeRead = async sql => {
    if (!sql.includes('records_json')) return;
    const plan = s.f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ '?1': s.roomId, '?2': 4, '?3': 3,
      '?4': s.f.peer.agentId, '?5': s.f.peer.signingPublicKey, '?6': 8 });
    expect(plan.some(row => /SEARCH room_lab_packets USING INDEX.*room_id=\? AND stored_seq>\?/.test(String(row.detail)))).toBe(true);
    expect(plan.some(row => /SCAN room_lab_packets|TEMP B-TREE/.test(String(row.detail)))).toBe(false);
  };
  const verify = vi.spyOn(crypto.subtle, 'verify');
  s.db.sessions.length = 0;
  s.f.db.exec('PRAGMA query_only = ON');
  const page = await s.store.readPackets(wire);
  expect(page).toMatchObject({ ok: true, page: { nextStoredSeq: 12 } });
  expect(Buffer.byteLength(canonicalizeJson(page))).toBeLessThanOrEqual(327680);
  expect(verify).toHaveBeenCalledTimes(9);
  expect(s.db.sessions.every(queries => queries.length === 1 && queries[0].startsWith('SELECT '))).toBe(true);
  const totals = s.f.db.prepare('SELECT sum(length(CAST(wire AS BLOB)) + length(CAST(receipt_json AS BLOB))) AS n FROM room_lab_packets').get();
  expect(s.f.db.prepare("SELECT bytes FROM room_lab_packet_usage WHERE scope = 'hub'").get()?.bytes).toBe(totals?.n);
  expect(s.snapshot()).toEqual(before);
  s.f.db.exec('PRAGMA query_only = OFF');
});

it('serializes competing exact proofs, positions and hub capacity across independent stores', async () => {
  const p = policy(); p.hub.sessions = 2;
  const s = await setup(p), wire = await s.wire();
  const exact = await Promise.all(Array.from({ length: 6 }, () => new D1RoomAdmissionStore(s.db, s.options).writePacket(wire)));
  expect(exact.filter(r => r.ok && !r.replayed)).toHaveLength(1);
  expect(exact.every(r => r.ok)).toBe(true);
  const rival = await s.wire(s.request(s.f.peer, { packetHex: 'ab'.repeat(48) }), s.f.peer);
  const rival2 = await s.wire(s.request(s.f.peer, { packetHex: 'ab'.repeat(48) }), s.f.peer);
  const positions = await Promise.all([rival, rival2].map(w => new D1RoomAdmissionStore(s.db, s.options).writePacket(w)));
  expect(positions.filter(r => r.ok)).toHaveLength(1);
  const capacity = await Promise.all(Array.from({ length: 6 }, async () => new D1RoomAdmissionStore(s.db, s.options)
    .writePacket(await s.wire(s.request(s.f.owner, { sessionId: id() })))));
  expect(capacity.filter(r => r.ok)).toHaveLength(1);
  expect(s.f.db.prepare('SELECT * FROM room_lab_d1_packet_gate').all()).toEqual([]);
});

it('rechecks closure after the proposal but inside the batch; permits only pre-close read snapshots', async () => {
  const s = await setup(); accepted(await s.write());
  const peerWire = await s.wire(s.request(s.f.peer, { packetHex: 'ab'.repeat(48) }), s.f.peer);
  s.db.beforeBatch = async () => { s.db.beforeBatch = async () => {}; admitted(await s.close()); };
  expect(await s.store.writePacket(peerWire)).toEqual({ ok: false, reason: 'unavailable' });
  const other = await setup(); accepted(await other.write());
  other.db.afterRead = async sql => { if (sql.includes('records_json')) { other.db.afterRead = async () => {}; admitted(await other.close()); } };
  expect(await other.store.readPackets(await other.readWire())).toMatchObject({ ok: true, page: { nextStoredSeq: 1 } });
  expect(await other.store.readPackets(await other.readWire())).toMatchObject({ ok: true, page: null });
});

it.each(['proof', 'session', 'window'] as const)('rolls back packet/phase/quotas/clock when %s crosses the final guard', async kind => {
  const s = await setup();
  accepted(await s.write());
  s.f.clock.now += 30000;
  const r = s.request(s.f.peer, { packetHex: 'ab'.repeat(48) });
  const before = s.snapshot();
  s.db.beforeStatement = sql => {
    if (sql === 'DELETE FROM room_lab_d1_packet_gate') {
      s.f.clock.now = START + (kind === 'proof' ? 90000 : 60000);
      if (kind === 'window') s.f.db.exec('UPDATE room_lab_d1_packet_gate SET session_expires = session_expires + 60000');
    }
  };
  expect(await s.write(r, s.f.peer)).toEqual({ ok: false, reason: 'storage_error' });
  expect(s.snapshot()).toEqual(before);
  expect(await s.store.readState('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
});

it.each(['lost-response', 'expired-response'] as const)('reconciles %s without calling a durable write a rejected operation', async fault => {
  const s = await setup(), r = s.request(), wire = await s.wire(r);
  s.db.afterCommit = async () => { if (fault === 'lost-response') throw new Error('private-marker'); s.f.clock.now = r.expiresAt; };
  expect(await s.store.writePacket(wire)).toEqual({ ok: false, reason: 'storage_error' });
  expect(s.f.db.prepare('SELECT count(*) AS n FROM room_lab_packets').get()?.n).toBe(1);
  s.db.afterCommit = async () => {};
  const reopened = new D1RoomAdmissionStore(s.db, s.options);
  if (fault === 'lost-response') expect(await reopened.writePacket(wire)).toMatchObject({ ok: true, replayed: true });
  const receipt = JSON.parse(s.f.db.prepare('SELECT receipt_json FROM room_lab_packets').get()!.receipt_json as string) as RoomPacketReceipt;
  s.f.clock.now = r.expiresAt;
  expect(await reopened.recoverPacket(await s.recoverWire(receipt))).toMatchObject({ ok: true, receipt });
  expect(await s.store.recoverPacket(await s.recoverWire(receipt))).toEqual({ ok: false, reason: 'storage_error' });
});

it.each(['room_lab_packet_sessions', 'room_lab_packets', 'room_lab_packet_usage', 'room_lab_packet_windows'])
('rolls back and poisons when %s writes silently fail', async table => {
  const s = await setup(), before = s.snapshot();
  s.f.db.exec(`CREATE TRIGGER ignore_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
  expect(await s.write()).toEqual({ ok: false, reason: 'storage_error' });
  expect(s.snapshot()).toEqual(before);
});

it.each(['metadata', 'guard', 'room', 'session', 'wire', 'binding', 'receipt', 'clock'] as const)
('fails closed and redacts %s corruption', async fault => {
  const s = await setup(), one = accepted(await s.write());
  if (fault === 'metadata') s.f.db.exec("UPDATE room_lab_packet_meta SET policy = '{}'");
  if (fault === 'guard') s.f.db.exec('DROP TRIGGER room_lab_d1_packet_finish');
  if (fault === 'room') s.f.db.exec("UPDATE room_lab_rooms SET state_json = 'private-marker'");
  if (fault === 'session') s.f.db.exec('UPDATE room_lab_packet_sessions SET peer_next = 2');
  if (fault === 'wire') s.f.db.exec("UPDATE room_lab_packets SET wire = 'private-marker'");
  if (fault === 'binding') s.f.db.exec("UPDATE room_lab_packets SET digest = 'private-marker'");
  if (fault === 'receipt') s.f.db.exec("UPDATE room_lab_packets SET receipt_json = 'private-marker'");
  if (fault === 'clock') s.db.beforeBatch = async () => { s.f.db.exec('UPDATE room_lab_meta SET clock = 0'); };
  const result = fault === 'wire' || fault === 'binding' ? await s.store.readPackets(await s.readWire())
    : fault === 'receipt' ? await s.store.recoverPacket(await s.recoverWire(one.receipt))
    : await s.write(s.request(s.f.peer, { packetHex: 'ab'.repeat(48) }), s.f.peer);
  expect(result).toEqual({ ok: false, reason: 'storage_error' });
  for (const method of ['writePacket', 'readPackets', 'recoverPacket'] as const)
    expect(await s.store[method]('invalid')).toEqual({ ok: false, reason: 'storage_error' });
  expect(await s.store.submit('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
});

it('rechecks query freshness after storage and historical verification, sharing concurrency with control', async () => {
  const s = await setup(policy(), true, { maxInFlightPerConnection: 1 }); accepted(await s.write());
  let release!: () => void;
  s.db.beforeRead = () => new Promise<void>(resolve => { release = resolve; });
  const pending = s.store.readPackets(await s.readWire());
  expect(await s.store.submit('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
  s.db.beforeRead = async () => {}; release(); expect((await pending).ok).toBe(true);
  const query = await s.readWire();
  const verify = crypto.subtle.verify.bind(crypto.subtle); let calls = 0;
  vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const result = await verify(...args); if (++calls === 2) s.f.clock.now += 60000; return result;
  });
  expect(await s.store.readPackets(query)).toEqual({ ok: false, reason: 'expired_proof' });
});

it('retains expired sessions, prunes only rate windows and independently caps both directional positions', async () => {
  const s = await setup(); await s.handshake();
  for (let packetIndex = 2; packetIndex <= 1025; packetIndex++) accepted(await s.write(s.request(s.f.owner,
    { kind: 'data', packetIndex, packetHex: 'cd'.repeat(17) })));
  expect(await s.write(s.request(s.f.owner, { kind: 'data', packetIndex: 1025, packetHex: 'cd'.repeat(17) })))
    .toEqual({ ok: false, reason: 'unavailable' });
  accepted(await s.write(s.request(s.f.peer, { kind: 'data', packetIndex: 2, packetHex: 'ef'.repeat(17) }), s.f.peer));
  s.f.clock.now += 300000;
  expect(await s.write(s.request(s.f.peer, { kind: 'data', packetIndex: 3, packetHex: 'ef'.repeat(17) }), s.f.peer))
    .toEqual({ ok: false, reason: 'unavailable' });
  expect(await s.write()).toEqual({ ok: false, reason: 'unavailable' });
  accepted(await s.write(s.request(s.f.owner, { sessionId: id() })));
  expect(s.f.db.prepare('SELECT count(*) AS n FROM room_lab_packets').get()?.n).toBe(1030);
  expect(s.f.db.prepare('SELECT count(*) AS n FROM room_lab_packet_sessions').get()?.n).toBe(2);
  expect(s.f.db.prepare('SELECT DISTINCT bucket FROM room_lab_packet_windows').all()).toEqual([{ bucket: Math.floor(s.f.clock.now / 60000) }]);
}, 20000);

it('fences request IDs and receipt/page access across rooms even with a shared session ID', async () => {
  const s = await setup(); const request = s.request(), wire = await s.wire(request);
  const one = accepted(await s.store.writePacket(wire));
  const created = await s.f.create(), invited = await s.f.invite(created.state);
  admitted(await s.f.submit(await actionFor(s.f.peer, 'accept', s.f.clock.now, invited.state), s.f.peer));
  expect(await s.write({ ...request, roomId: created.state.roomId })).toEqual({ ok: false, reason: 'unavailable' });
  const two = accepted(await s.write({ ...request, roomId: created.state.roomId, requestId: id() }));
  expect(two.receipt.storedSeq).toBe(1);
  expect(await s.store.recoverPacket(await s.recoverWire(one.receipt, s.f.owner, { roomId: created.state.roomId })))
    .toMatchObject({ ok: true, receipt: null });
  expect(await s.store.readPackets(await s.readWire(s.f.peer, { roomId: created.state.roomId })))
    .toMatchObject({ ok: true, page: { records: [{ storedSeq: 1 }], nextStoredSeq: 1 } });
});

it.each(['verification', 'queued-batch', 'recovery'] as const)('checks expiry after asynchronous %s work', async phase => {
  const s = await setup(), request = s.request();
  if (phase === 'verification') {
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      const result = await verify(...args); s.f.clock.now = request.expiresAt; return result;
    });
  }
  if (phase === 'queued-batch') s.db.beforeBatch = async () => { s.f.clock.now = request.expiresAt; };
  if (phase === 'recovery') {
    const one = accepted(await s.write(request));
    s.db.afterRead = async sql => { if (sql.includes('old.receipt_json')) s.f.clock.now = request.expiresAt; };
    expect(await s.store.recoverPacket(await s.recoverWire(one.receipt))).toEqual({ ok: false, reason: 'expired_proof' });
  } else {
    expect(await s.write(request)).toEqual({ ok: false, reason: 'expired_proof' });
    expect(s.f.db.prepare('SELECT * FROM room_lab_packets').all()).toHaveLength(0);
  }
});

it.each(['packet', 'control', 'page'] as const)('discards in-flight %s results when another operation poisons the shared store', async kind => {
  const s = await setup(); accepted(await s.write());
  const wire = kind === 'page' ? await s.readWire() : kind === 'control'
    ? await s.f.wire(await actionFor(s.f.owner, 'close', s.f.clock.now, s.f.room(s.roomId)))
    : await s.wire(s.request(s.f.peer, { packetHex: 'ab'.repeat(48) }), s.f.peer);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const verify = crypto.subtle.verify.bind(crypto.subtle); let calls = 0;
  const spy = vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const result = await verify(...args);
    if (++calls === (kind === 'page' ? 2 : 1)) { entered(); await blocked; }
    return result;
  });
  const pending = kind === 'control' ? s.store.submit(wire, s.f.owner.signingPublicKey)
    : kind === 'page' ? s.store.readPackets(wire) : s.store.writePacket(wire);
  await waiting;
  s.db.beforeRead = async () => { throw new Error('private storage marker'); };
  expect(await s.store.readState('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
  release(); expect(await pending).toEqual({ ok: false, reason: 'storage_error' }); spy.mockRestore();
});
