import { createPublicKey, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson } from '@openagentforum/protocol';
import {
  prepareRoomStateRead, ROOM_STATE_PROTOCOL, signRoomState, type RoomStateQuery,
} from '../src/state-read.js';
import { prepareRoomControl, type RoomControlAction } from '../src/control.js';
import { prepareRoomRecovery, ROOM_RECOVERY_PROTOCOL, signRoomRecovery } from '../src/recovery.js';
import { D1RoomAdmissionStore, initializeD1RoomAdmission } from '../src/d1-admission.js';
import { D1RoomStateReader } from '../src/d1-state-read.js';
import { D1RoomOperationScope } from '../src/d1-scope.js';
import type { AdmissionPolicy } from '../src/storage-types.js';
import { actionFor, DatabaseSync, fixture, HUB, START } from './fixtures.js';
import { TestD1 } from './d1-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!(); });
async function setup(adapter: 'sqlite' | 'd1' = 'sqlite', policy: Partial<AdmissionPolicy> = {}) {
  const f = await fixture(policy);
  cleanup.push(() => f.close());
  f.db.function('unixepoch', { varargs: true }, () => f.clock.now / 1000);
  const db = new TestD1(f.db);
  if (adapter === 'd1') await initializeD1RoomAdmission(db, f.options);
  const store = adapter === 'sqlite' ? f.store : new D1RoomAdmissionStore(db, f.options);
  const submit = async (a: RoomControlAction, actor = f.owner) => store.submit(await f.wire(a, actor), actor.signingPublicKey);
  const action = await actionFor(f.owner, 'create');
  expect((await submit(action)).ok).toBe(true);
  const query = (actor = f.owner): RoomStateQuery => ({ protocol: ROOM_STATE_PROTOCOL, hub: HUB,
    actor: actor.agentId, queryId: '1'.repeat(32), roomId: action.roomId, issuedAt: f.clock.now, expiresAt: f.clock.now + 60_000 });
  const read = async (actor = f.owner, q = query(actor)) => store.readState(await signRoomState(q, actor.signingPrivateKey), actor.signingPublicKey);
  const snapshot = () => ({ ...f.counts(), meta: f.db.prepare('SELECT * FROM room_lab_meta').all(),
    rooms: f.db.prepare('SELECT * FROM room_lab_rooms').all(), receipts: f.db.prepare('SELECT * FROM room_lab_receipts').all(),
    changes: f.db.prepare('SELECT total_changes() AS n').get() });
  return { f, db, store, action, query, read, submit, snapshot };
}

describe.each(['sqlite', 'd1'] as const)('%s member-only state read', adapter => {
  it('reads minimal owner/peer state, excludes pending invitees, and reports terminal closure', async () => {
    const s = await setup(adapter); const q = s.query();
    expect(await s.read()).toEqual({ ok: true, queryId: q.queryId, observedAt: START,
      room: { roomId: s.action.roomId, revision: 1, status: 'open', role: 'owner' } });
    expect((await s.submit(await actionFor(s.f.owner, 'invite', START, s.f.room(s.action.roomId), s.f.peer))).ok).toBe(true);
    for (const actor of [s.f.peer, s.f.outsider]) expect(await s.read(actor)).toEqual({ ok: true, queryId: q.queryId, observedAt: START, room: null });
    expect((await s.submit(await actionFor(s.f.peer, 'accept', START, s.f.room(s.action.roomId)), s.f.peer)).ok).toBe(true);
    expect(await s.read(s.f.peer)).toMatchObject({ ok: true, room: { revision: 3, status: 'open', role: 'peer' } });
    expect((await s.submit(await actionFor(s.f.peer, 'close', START, s.f.room(s.action.roomId)), s.f.peer)).ok).toBe(true);
    const before = s.snapshot();
    for (const [actor, role] of [[s.f.owner, 'owner'], [s.f.peer, 'peer']] as const) {
      expect(await s.read(actor)).toEqual({ ok: true, queryId: q.queryId, observedAt: START,
        room: { roomId: s.action.roomId, revision: 4, status: 'closed', role } });
    }
    expect(await s.read(s.f.outsider)).toMatchObject({ ok: true, room: null });
    expect(s.snapshot()).toEqual(before);
    expect(await s.store.submit(await signRoomState(q, s.f.owner.signingPrivateKey), s.f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'invalid_schema' });
  });

  it('uses one unavailable shape for unknown rooms and valid nonmember signatures', async () => {
    const s = await setup(adapter);
    const unknown = { ...s.query(), roomId: `room_${'f'.repeat(32)}` };
    expect(await s.read(s.f.owner, unknown)).toEqual(await s.read(s.f.outsider));
    const before = s.snapshot();
    expect(await s.read(s.f.owner, unknown)).toMatchObject({ ok: true, room: null });
    expect(s.snapshot()).toEqual(before);
  });

  it.each(['owner', 'peer'] as const)('pins the complete stored %s signing key, not a matching short ID', async role => {
    const s = await setup(adapter);
    if (role === 'peer') {
      await s.submit(await actionFor(s.f.owner, 'invite', START, s.f.room(s.action.roomId), s.f.peer));
      await s.submit(await actionFor(s.f.peer, 'accept', START, s.f.room(s.action.roomId)), s.f.peer);
    }
    const state = s.f.room(s.action.roomId);
    state[role]!.signingPublicKey = s.f.outsider.signingPublicKey; // Model an alias, not a claimed feasible hash collision.
    s.f.db.prepare('UPDATE room_lab_rooms SET state_json = ?').run(canonicalizeJson(state));
    expect(await s.read(s.f[role])).toMatchObject({ ok: true, room: null });
  });

  it('ignores forged denormalized identity columns and never promotes an invitation to membership', async () => {
    const s = await setup(adapter);
    s.f.db.prepare('UPDATE room_lab_rooms SET owner_id = ?, peer_id = ?').run(s.f.outsider.agentId, s.f.outsider.agentId);
    expect(await s.read(s.f.outsider)).toMatchObject({ ok: true, room: null });
    expect(await s.read()).toMatchObject({ ok: true, room: { role: 'owner' } });
  });

  it('does not write at quota saturation or reclaim expired counters and close reservations', async () => {
    const s = await setup(adapter, { maxReceipts: 2 });
    s.f.clock.now += 120_000;
    const before = s.snapshot();
    s.f.db.exec('PRAGMA query_only = ON');
    expect(await s.read()).toMatchObject({ ok: true, room: { revision: 1 } });
    expect(s.snapshot()).toEqual(before);
    s.f.db.exec('PRAGMA query_only = OFF');
    expect((await s.submit(await actionFor(s.f.owner, 'close', s.f.clock.now, s.f.room(s.action.roomId)))).ok).toBe(true);
  });

  it('checks expiry after signature verification and does not return state from an expired query', async () => {
    const s = await setup(adapter); const q = s.query();
    const wire = await signRoomState(q, s.f.owner.signingPrivateKey);
    const original = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      const result = await original(...args); s.f.clock.now = q.expiresAt; return result;
    });
    const before = s.snapshot();
    expect(await s.store.readState(wire, s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'expired_proof' });
    expect(s.snapshot()).toEqual(before);
  });

  it('shares all three methods\' verification slots and storage-error poisoning', async () => {
    const s = await setup(adapter, { maxInFlightPerConnection: 1 });
    const wire = await signRoomState(s.query(), s.f.owner.signingPrivateKey);
    const original = crypto.subtle.verify.bind(crypto.subtle);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => { await waiting; return original(...args); });
    const pending = s.store.readState(wire, s.f.owner.signingPublicKey);
    expect(await s.store.submit('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
    expect(await s.store.recover('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
    expect(await s.store.readState(wire, s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
    release(); expect((await pending).ok).toBe(true); spy.mockRestore();
    s.f.db.exec('DROP TABLE room_lab_rooms'); // Disposable fault injection only.
    expect(await s.read()).toEqual({ ok: false, reason: 'storage_error' });
    for (const method of ['submit', 'recover', 'readState'] as const)
      expect(await s.store[method]('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
  });

  it.each(['bad-json', 'wrong-room', 'wrong-hub', 'wrong-protocol', 'bad-revision', 'unexpected-field', 'closed-invitation'] as const)
  ('fails closed on %s in the authoritative snapshot', async fault => {
    const s = await setup(adapter); const state = s.f.room(s.action.roomId);
    const patches = { 'wrong-room': { roomId: `room_${'f'.repeat(32)}` }, 'wrong-hub': { hub: 'https://wrong.invalid' },
      'wrong-protocol': { protocol: ROOM_STATE_PROTOCOL }, 'bad-revision': { revision: 0 }, 'unexpected-field': { secret: 'fixture' },
      'closed-invitation': { status: 'closed', invitation: { digest: 'a'.repeat(64), recipient: s.f.peer.agentId,
        recipientSigningPublicKey: s.f.peer.signingPublicKey, expiresAt: START + 1000 } }, 'bad-json': {} };
    s.f.db.prepare('UPDATE room_lab_rooms SET state_json = ?').run(fault === 'bad-json' ? '{' : canonicalizeJson({ ...state, ...patches[fault] }));
    expect(await s.read()).toEqual({ ok: false, reason: 'storage_error' });
    expect(await s.store.recover('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('withholds a state response already verifying when another operation poisons the instance', async () => {
    const s = await setup(adapter, { maxInFlightPerConnection: 2 });
    const wire = await signRoomState(s.query(), s.f.owner.signingPrivateKey);
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      entered(); await blocked; return verify(...args);
    });
    const pending = s.store.readState(wire, s.f.owner.signingPublicKey);
    await started;
    s.f.db.exec('DROP TABLE room_lab_meta');
    expect(await s.store.recover('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
    release();
    expect(await pending).toEqual({ ok: false, reason: 'storage_error' });
  });
});

describe('state proof bytes and domain separation', () => {
  it('has independently verifiable PureEd25519 bytes and immutable signed/prepared fields', async () => {
    const s = await setup(); const q = s.query(); const original = { ...q };
    const pending = signRoomState(q, s.f.owner.signingPrivateKey); q.roomId = `room_${'f'.repeat(32)}`;
    const wire = await pending; const proof = JSON.parse(wire);
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(s.f.owner.signingPublicKey, 'hex')]), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(`${ROOM_STATE_PROTOCOL}\n${canonicalizeJson(original)}`), publicKey, Buffer.from(proof.signature, 'hex'))).toBe(true);
    const prepared = await prepareRoomStateRead(wire, s.f.owner.signingPublicKey, { hub: HUB, now: START });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('fixture');
    expect(Object.isFrozen(prepared.query)).toBe(true);
    expect(prepared.query).toEqual(original);
    expect(prepared.freshness(original.expiresAt)).toBe('expired_proof');
    expect((await prepareRoomControl(wire, s.f.owner.signingPublicKey, { hub: HUB, now: START })).ok).toBe(false);
    expect((await prepareRoomRecovery(wire, s.f.owner.signingPublicKey, { hub: HUB, now: START })).ok).toBe(false);
    expect((await s.store.readState(await s.f.wire(s.action), s.f.owner.signingPublicKey)).ok).toBe(false);
    const recovery = await signRoomRecovery({ ...original, protocol: ROOM_RECOVERY_PROTOCOL,
      requestId: s.action.requestId, proofDigest: 'a'.repeat(64) }, s.f.owner.signingPrivateKey);
    expect((await s.store.readState(recovery, s.f.owner.signingPublicKey)).ok).toBe(false);
  });

  it.each(['protocol', 'hub', 'actor', 'queryId', 'roomId', 'issuedAt', 'expiresAt', 'signature'] as const)
  ('rejects signed-field substitution: %s', async field => {
    const s = await setup(); const proof = JSON.parse(await signRoomState(s.query(), s.f.owner.signingPrivateKey));
    const substitutions = { protocol: ROOM_RECOVERY_PROTOCOL, hub: 'https://wrong.invalid', actor: s.f.peer.agentId,
      queryId: 'f'.repeat(32), roomId: `room_${'f'.repeat(32)}`, issuedAt: START + 1, expiresAt: START + 59_000, signature: '0'.repeat(128) };
    proof[field] = substitutions[field];
    expect((await s.store.readState(canonicalizeJson(proof), s.f.owner.signingPublicKey)).ok).toBe(false);
  });

  it.each(['whitespace', 'duplicate', 'order', 'escape', 'extra', 'missing', 'nested', 'oversized', 'utf8-size', 'number-alias'] as const)
  ('rejects malformed/noncanonical input: %s', async kind => {
    const s = await setup(); const wire = await signRoomState(s.query(), s.f.owner.signingPrivateKey); const p = JSON.parse(wire);
    const variants = { whitespace: wire + ' ', duplicate: wire.replace('{', `{"actor":"${p.actor}",`),
      order: JSON.stringify(p, Object.keys(p).reverse()), escape: wire.replace('agent_', '\\u0061gent_'),
      extra: canonicalizeJson({ ...p, authority: true }), missing: canonicalizeJson({ ...p, roomId: undefined }),
      nested: canonicalizeJson({ ...p, roomId: { value: p.roomId } }), oversized: 'x'.repeat(2049),
      'utf8-size': 'é'.repeat(1100), 'number-alias': wire.replace(String(START), '18e11') };
    expect((await s.store.readState(variants[kind], s.f.owner.signingPublicKey)).ok).toBe(false);
  });

  it.each(['expired', 'future', 'long-lived', 'negative-zero', 'bad-key'] as const)('rejects %s proof', async kind => {
    const s = await setup(); const q = s.query();
    if (kind === 'future') { q.issuedAt = START + 30_001; q.expiresAt = q.issuedAt + 60_000; }
    if (kind === 'expired') s.f.clock.now = q.expiresAt;
    let wire = await signRoomState(q, s.f.owner.signingPrivateKey);
    if (kind === 'long-lived') wire = canonicalizeJson({ ...JSON.parse(wire), expiresAt: START + 60_001 });
    if (kind === 'negative-zero') wire = wire.replace(String(q.issuedAt), '-0');
    expect((await s.store.readState(wire, kind === 'bad-key' ? 'invalid' : s.f.owner.signingPublicKey)).ok).toBe(false);
  });
});

describe('D1 state snapshot boundaries', () => {
  it('uses fresh first-primary sessions and a single metadata/membership/status SELECT', async () => {
    const s = await setup('d1'); s.db.sessions.length = 0;
    expect((await s.read()).ok).toBe(true);
    expect(s.db.sessions).toHaveLength(2);
    expect(s.db.sessions.every(sql => sql.length === 1 && sql[0].startsWith('SELECT '))).toBe(true);
    expect(s.db.sessions[1][0]).toContain('LEFT JOIN room_lab_rooms');
  });

  it('never looks up room state before authenticating the query', async () => {
    const s = await setup('d1'); s.db.calls.length = 0;
    const wire = canonicalizeJson({ ...JSON.parse(await signRoomState(s.query(), s.f.owner.signingPrivateKey)), signature: '0'.repeat(128) });
    expect(await s.store.readState(wire, s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'invalid_signature' });
    expect(s.db.calls).toHaveLength(1); expect(s.db.calls[0]).not.toContain('room_lab_rooms');
  });

  it.each(['before', 'after'] as const)('handles closure %s the SQL snapshot without claiming a lease', async timing => {
    const s = await setup('d1'); const q = s.query();
    const close = await actionFor(s.f.owner, 'close', START, s.f.room(s.action.roomId));
    let changed = false;
    const hook = async (sql: string) => { if (!changed && sql.includes('LEFT JOIN room_lab_rooms')) {
      changed = true; expect((await s.f.submit(close)).ok).toBe(true);
    } };
    if (timing === 'before') s.db.beforeRead = hook; else s.db.afterRead = hook;
    expect(await s.read(s.f.owner, q)).toMatchObject({ ok: true, room: { status: timing === 'before' ? 'closed' : 'open' } });
    expect(await s.read(s.f.owner, q)).toMatchObject({ ok: true, room: { status: 'closed' } });
    expect((await s.submit(await actionFor(s.f.owner, 'invite', START, { ...s.f.room(s.action.roomId), status: 'open' }, s.f.peer))).ok).toBe(false);
  });

  it('rechecks asynchronous delivery expiry and committed clock high-water on rollback', async () => {
    const s = await setup('d1'); const q = s.query();
    s.f.clock.now = START - 10_000;
    expect((await s.read(s.f.owner, q)).ok).toBe(true);
    s.db.afterRead = async sql => { if (sql.includes('JOIN')) s.f.clock.now = q.expiresAt; };
    expect(await s.read(s.f.owner, q)).toEqual({ ok: false, reason: 'expired_proof' });
  });

  it.each(['metadata', 'snapshot', 'policy', 'rollback'] as const)('poisons all methods on %s failure without returning state', async fault => {
    const s = await setup('d1');
    s.db.beforeRead = async sql => {
      if (fault === 'metadata' || (fault === 'snapshot' && sql.includes('JOIN'))) throw new Error('private fault marker');
      if (sql.includes('JOIN')) s.f.db.exec(fault === 'policy' ? "UPDATE room_lab_meta SET policy = '{}'" : 'UPDATE room_lab_meta SET clock = 0');
    };
    expect(await s.read()).toEqual({ ok: false, reason: 'storage_error' });
    expect(await s.store.submit('invalid', s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('snapshots configuration and rejects standalone reader limit mismatches', async () => {
    const s = await setup('d1'); const options = { ...s.f.options, policy: { ...s.f.policy } };
    const reader = new D1RoomStateReader(s.db, options); options.hub = 'https://wrong.invalid'; options.policy.maxReceipts = 2;
    const wire = await signRoomState(s.query(), s.f.owner.signingPrivateKey);
    expect((await reader.readState(wire, s.f.owner.signingPublicKey)).ok).toBe(true);
    expect(() => new D1RoomStateReader(s.db, { ...s.f.options, now: undefined! })).toThrow('configuration');
    expect(() => new D1RoomStateReader(s.db, { ...s.f.options, scope: new D1RoomOperationScope(1) })).toThrow('limit');
  });
});

it.each(['storage', 'commit', 'clock-regression'] as const)('SQLite rechecks freshness/integrity at %s', async phase => {
  const s = await setup(); const q = s.query();
  if (phase === 'storage') {
    const prepare = s.f.db.prepare.bind(s.f.db);
    vi.spyOn(s.f.db, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('SELECT state_json')) s.f.clock.now = q.expiresAt;
      return prepare(sql);
    });
  } else if (phase === 'commit') {
    const exec = s.f.db.exec.bind(s.f.db);
    vi.spyOn(s.f.db, 'exec').mockImplementation(sql => { exec(sql); if (sql === 'COMMIT') s.f.clock.now = q.expiresAt; });
  } else {
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      const result = await verify(...args); s.f.db.exec('UPDATE room_lab_meta SET clock = 0'); return result;
    });
  }
  expect(await s.read(s.f.owner, q)).toEqual({ ok: false, reason: phase === 'clock-regression' ? 'storage_error' : 'expired_proof' });
});

it('SQLite keeps one WAL snapshot across concurrent closure and persists terminal status after restart', async () => {
  const s = await setup(); const other = new DatabaseSync(s.f.path);
  try {
    const prepare = s.f.db.prepare.bind(s.f.db); let changed = false;
    const spy = vi.spyOn(s.f.db, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('SELECT state_json') && !changed) {
        changed = true;
        const closed = { ...s.f.room(s.action.roomId), status: 'closed', revision: 2 };
        other.prepare("UPDATE room_lab_rooms SET state_json = ?, status = 'closed', revision = 2").run(canonicalizeJson(closed));
      }
      return prepare(sql);
    });
    expect(await s.read()).toMatchObject({ ok: true, room: { status: 'open', revision: 1 } });
    spy.mockRestore(); s.f.restart();
    expect(await s.f.store.readState(await signRoomState(s.query(), s.f.owner.signingPrivateKey), s.f.owner.signingPublicKey))
      .toMatchObject({ ok: true, room: { status: 'closed', revision: 2 } });
  } finally { other.close(); }
});
