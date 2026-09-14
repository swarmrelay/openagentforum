import { afterEach, expect, it, vi } from 'vitest';
import { canonicalizeJson, sha256Hex } from '@openagentforum/protocol';
import { D1RoomAdmissionStore, initializeD1RoomAdmission } from '../src/d1-admission.js';
import { roomControlSignString, type RoomControlAction } from '../src/control.js';
import { ROOM_RECOVERY_PROTOCOL, signRoomRecovery } from '../src/recovery.js';
import { actionFor, admitted, fixture, START } from './fixtures.js';
import type { AdmissionPolicy } from '../src/storage-types.js';
import { TestD1 } from './d1-fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanups.length) cleanups.pop()!(); });
async function setup(policy: Partial<AdmissionPolicy> = {}) {
  const f = await fixture(policy);
  cleanups.push(() => f.close());
  f.db.function('unixepoch', { varargs: true }, () => f.clock.now / 1000);
  const db = new TestD1(f.db);
  await initializeD1RoomAdmission(db, f.options);
  const store = new D1RoomAdmissionStore(db, f.options);
  const submit = async (a: RoomControlAction, actor = f.owner, target = store) => target.submit(await f.wire(a, actor), actor.signingPublicKey);
  const create = async (actor = f.owner) => {
    const action = await actionFor(actor, 'create', f.clock.now);
    const result = admitted(await submit(action, actor));
    return { action, result, state: f.room(action.roomId) };
  };
  const recover = async (action: RoomControlAction, target = store) => target.recover(await signRoomRecovery({
    protocol: ROOM_RECOVERY_PROTOCOL, hub: action.hub, actor: action.actor, queryId: 'a'.repeat(32),
    roomId: action.roomId, requestId: action.requestId, proofDigest: await sha256Hex(roomControlSignString(action)),
    issuedAt: f.clock.now, expiresAt: f.clock.now + 60_000,
  }, f.owner.signingPrivateKey), f.owner.signingPublicKey);
  const snapshot = () => ({ ...f.counts(), meta: f.db.prepare('SELECT * FROM room_lab_meta').all(),
    rooms: f.db.prepare('SELECT * FROM room_lab_rooms ORDER BY room_id').all(),
    receipts: f.db.prepare('SELECT * FROM room_lab_receipts ORDER BY request_id').all(),
    gate: f.db.prepare('SELECT * FROM room_lab_d1_gate').all() });
  return { f, db, store, submit, create, recover, snapshot };
}

it('admits create/invite/accept/peer-close with immutable receipts and retained tombstones', async () => {
  const s = await setup();
  const c = await s.create();
  const invite = await actionFor(s.f.owner, 'invite', START, c.state, s.f.peer);
  expect((await s.submit(invite)).ok).toBe(true);
  const accept = await actionFor(s.f.peer, 'accept', START, s.f.room(c.action.roomId));
  expect((await s.submit(accept, s.f.peer)).ok).toBe(true);
  const close = await actionFor(s.f.peer, 'close', START, s.f.room(c.action.roomId));
  expect((await s.submit(close, s.f.peer)).ok).toBe(true);
  expect(s.f.room(c.action.roomId).status).toBe('closed');
  expect(await s.submit(c.action)).toEqual({ ok: true, replayed: true, receipt: c.result.receipt });
  expect(s.f.counts().receipts).toBe(4);
  expect(s.snapshot().gate).toEqual([]);
  s.f.clock.now += 120_000;
  const reopened = new D1RoomAdmissionStore(s.db, s.f.options);
  expect(await s.recover(c.action, reopened)).toMatchObject({ ok: true, receipt: c.result.receipt });
  expect(await s.submit({ ...c.action, issuedAt: s.f.clock.now, expiresAt: s.f.clock.now + 60_000 }, s.f.owner, reopened))
    .toEqual({ ok: false, reason: 'request_conflict' });
});

it.each(['outsider', 'stale-revision', 'noncanonical', 'signature'] as const)('rejects %s with no partial admission', async kind => {
  const s = await setup();
  const c = await s.create();
  const actor = kind === 'outsider' ? s.f.outsider : s.f.owner;
  const action = await actionFor(actor, 'close', START, c.state);
  if (kind === 'stale-revision') action.expectedRevision++;
  let wire = await s.f.wire(action, actor);
  if (kind === 'noncanonical') wire += ' ';
  if (kind === 'signature') wire = canonicalizeJson({ ...JSON.parse(wire), signature: '0'.repeat(128) });
  const before = s.snapshot();
  expect((await s.store.submit(wire, actor.signingPublicKey)).ok).toBe(false);
  expect(s.snapshot()).toEqual(before);
});

it('does not reserve peer membership before acceptance and releases it only on closure', async () => {
  const s = await setup({ maxActiveRoomsPerAgent: 1 });
  const c = await s.create(), peerRoom = await s.create(s.f.peer);
  expect((await s.submit(await actionFor(s.f.owner, 'invite', START, c.state, s.f.peer))).ok).toBe(true);
  const accept = await actionFor(s.f.peer, 'accept', START, s.f.room(c.action.roomId));
  expect(await s.submit(accept, s.f.peer)).toEqual({ ok: false, reason: 'member_room_limit' });
  expect((await s.submit(await actionFor(s.f.peer, 'close', START, peerRoom.state), s.f.peer)).ok).toBe(true);
  expect((await s.submit(accept, s.f.peer)).ok).toBe(true);
});

it.each(['invitesPerAgent', 'invitesPerHub'] as const)('atomically enforces %s across different rooms', async field => {
  const s = await setup({ [field]: 1 });
  const a = await s.create(), b = await s.create();
  const actions = await Promise.all([actionFor(s.f.owner, 'invite', START, a.state, s.f.peer),
    actionFor(s.f.owner, 'invite', START, b.state, s.f.outsider)]);
  const results = await Promise.all(actions.map(action => s.submit(action, s.f.owner, new D1RoomAdmissionStore(s.db, s.f.options))));
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.find(r => !r.ok)).toEqual({ ok: false, reason: 'invite_rate_limited' });
});

it('rechecks invitation expiry for acceptance after the batch was queued', async () => {
  const s = await setup(); const c = await s.create();
  const invite = await actionFor(s.f.owner, 'invite', START, c.state, s.f.peer);
  if (invite.action !== 'invite') throw new Error('fixture');
  invite.payload.inviteExpiresAt = START + 10_000;
  expect((await s.submit(invite)).ok).toBe(true);
  const accept = await actionFor(s.f.peer, 'accept', START, s.f.room(c.action.roomId));
  s.db.beforeBatch = async () => { s.f.clock.now = START + 10_000; };
  expect(await s.submit(accept, s.f.peer)).toEqual({ ok: false, reason: 'invitation_expired' });
  expect(s.f.room(c.action.roomId).peer).toBeNull();
});

it('uses the stored full signing key when an old receipt shares a short ID', async () => {
  const s = await setup(); const c = await s.create();
  s.f.db.prepare('UPDATE room_lab_receipts SET signing_key = ?').run(s.f.outsider.signingPublicKey);
  expect(await s.submit(c.action)).toEqual({ ok: false, reason: 'request_conflict' });
});

it('keeps committed time monotonic across clock rollback and prunes only obsolete rate buckets', async () => {
  const s = await setup(); const c = await s.create();
  s.f.clock.now -= 10_000;
  expect(await s.submit(c.action)).toEqual({ ok: true, replayed: true, receipt: c.result.receipt });
  s.f.clock.now = START + 120_000;
  await s.create();
  expect(s.f.counts().budgets.every(b => b.bucket === Math.floor(s.f.clock.now / s.f.policy.windowMs))).toBe(true);
  expect(s.f.counts().receipts).toBe(2);
});

it('treats a delayed successful acknowledgment as committed history, not a fresh proof', async () => {
  const s = await setup(); const action = await actionFor(s.f.owner, 'create');
  s.db.afterCommit = async () => { s.f.clock.now = action.expiresAt; };
  expect(await s.submit(action)).toMatchObject({ ok: true, replayed: false, receipt: { committedAt: START } });
  expect(await s.submit(action)).toEqual({ ok: false, reason: 'expired_proof' });
});

it('rechecks proof expiry after asynchronous signature verification', async () => {
  const s = await setup(); const action = await actionFor(s.f.owner, 'create');
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const result = await verify(...args); s.f.clock.now = action.expiresAt; return result;
  });
  expect(await s.submit(action)).toEqual({ ok: false, reason: 'expired_proof' });
  expect(s.f.counts().rooms).toBe(0);
});

it.each(['missing-guard', 'changed-guard', 'changed-policy', 'clock-rollback'] as const)
('fails closed for %s inside the batch and poisons admission/recovery', async fault => {
  const s = await setup(); const c = await s.create();
  s.db.beforeBatch = async () => {
    if (fault === 'changed-policy') s.f.db.exec("UPDATE room_lab_meta SET policy = '{}'");
    else if (fault === 'clock-rollback') s.f.db.exec('UPDATE room_lab_meta SET clock = 0');
    else {
      s.f.db.exec('DROP TRIGGER room_lab_d1_finish');
      if (fault === 'changed-guard') s.f.db.exec('CREATE TRIGGER room_lab_d1_finish BEFORE DELETE ON room_lab_d1_gate BEGIN SELECT 1; END');
    }
  };
  expect(await s.submit(await actionFor(s.f.owner, 'close', START, c.state))).toEqual({ ok: false, reason: 'storage_error' });
  expect(s.f.room(c.action.roomId).status).toBe('open');
  expect(await s.recover(c.action)).toEqual({ ok: false, reason: 'storage_error' });
});

it('catches silently skipped state writes before committing a receipt', async () => {
  const s = await setup(); const before = s.snapshot();
  s.f.db.exec('CREATE TRIGGER ignore_room BEFORE INSERT ON room_lab_rooms BEGIN SELECT RAISE(IGNORE); END');
  expect(await s.submit(await actionFor(s.f.owner, 'create'))).toEqual({ ok: false, reason: 'storage_error' });
  expect(s.snapshot()).toEqual(before);
});

it('preserves immutable configuration across initialization and constructor option mutation', async () => {
  const s = await setup(); const before = s.snapshot();
  await expect(initializeD1RoomAdmission(s.db, { ...s.f.options, policy: { ...s.f.policy, maxReceipts: 2 } })).rejects.toThrow('initialization failed');
  expect(s.snapshot()).toEqual(before);
  const options = { ...s.f.options, policy: { ...s.f.policy } };
  const store = new D1RoomAdmissionStore(s.db, options);
  options.policy.maxReceipts = 2;
  options.hub = 'https://wrong.invalid';
  expect((await s.submit(await actionFor(s.f.owner, 'create'), s.f.owner, store)).ok).toBe(true);
});

it('exact concurrent retries charge once across independent adapters', async () => {
  const s = await setup();
  const action = await actionFor(s.f.owner, 'create');
  const wire = await s.f.wire(action);
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    new D1RoomAdmissionStore(s.db, s.f.options).submit(wire, s.f.owner.signingPublicKey)));
  expect(results.every(r => r.ok)).toBe(true);
  expect(results.filter(r => r.ok && !r.replayed)).toHaveLength(1);
  expect(s.f.counts().receipts).toBe(1);
  expect(s.f.counts().budgets.every(b => b.count === 1)).toBe(true);
});

it('rechecks same-room state inside the batch so competing invitations cannot both win', async () => {
  const s = await setup();
  const c = await s.create();
  const a = await actionFor(s.f.owner, 'invite', START, c.state, s.f.peer);
  const b = await actionFor(s.f.owner, 'invite', START, c.state, s.f.outsider);
  const results = await Promise.all([s.submit(a), s.submit(b, s.f.owner, new D1RoomAdmissionStore(s.db, s.f.options))]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.find(r => !r.ok)).toEqual({ ok: false, reason: 'revision_conflict' });
  expect(s.f.counts().receipts).toBe(2);
});

it.each([
  ['maxRetainedRooms', 'room_capacity'], ['maxActiveRooms', 'active_room_limit'],
  ['maxActiveRoomsPerAgent', 'member_room_limit'], ['createsPerHub', 'create_rate_limited'],
  ['createsPerAgent', 'create_rate_limited'],
] as const)('enforces %s against racing creates', async (limit, reason) => {
  const s = await setup({ [limit]: 1, ...(limit === 'maxRetainedRooms' ? { maxActiveRooms: 1 } : {}) });
  const actions = await Promise.all(Array.from({ length: 6 }, () => actionFor(s.f.owner, 'create')));
  const results = await Promise.all(actions.map(a => s.submit(a, s.f.owner, new D1RoomAdmissionStore(s.db, s.f.options))));
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.filter(r => !r.ok).every(r => !r.ok && r.reason === reason)).toBe(true);
  expect(s.f.counts().receipts).toBe(1);
});

it('preserves a close reservation even when receipt capacity is saturated', async () => {
  const s = await setup({ maxReceipts: 2 });
  const c = await s.create();
  expect(await s.submit(await actionFor(s.f.owner, 'invite', START, c.state, s.f.peer)))
    .toEqual({ ok: false, reason: 'receipt_capacity' });
  expect((await s.submit(await actionFor(s.f.owner, 'close', START, c.state))).ok).toBe(true);
  expect(s.f.counts().receipts).toBe(2);
  expect(await s.recover(c.action)).toMatchObject({ ok: true, receipt: c.result.receipt });
});

it('enforces recipient invitation caps, allows same-room replacement and invalidates old acceptance', async () => {
  const s = await setup({ maxPendingInvitesPerRecipient: 1 });
  const c = await s.create(), other = await s.create();
  const invite = await actionFor(s.f.owner, 'invite', START, c.state, s.f.peer);
  expect((await s.submit(invite)).ok).toBe(true);
  const staleAccept = await actionFor(s.f.peer, 'accept', START, s.f.room(c.action.roomId));
  expect(await s.submit(await actionFor(s.f.owner, 'invite', START, other.state, s.f.peer)))
    .toEqual({ ok: false, reason: 'pending_invite_limit' });
  expect((await s.submit(await actionFor(s.f.owner, 'invite', START, s.f.room(c.action.roomId), s.f.peer))).ok).toBe(true);
  expect((await s.submit(staleAccept, s.f.peer)).ok).toBe(false);
});

it.each(['proof', 'invitation', 'window'] as const)('rolls back every write if %s expires at the final commit guard', async kind => {
  const s = await setup();
  const c = await s.create();
  const action = await actionFor(s.f.owner, 'invite', START, c.state, s.f.peer);
  if (action.action !== 'invite') throw new Error('fixture');
  action.expiresAt = START + 120_000;
  action.payload.inviteExpiresAt = START + 30_000;
  const before = s.snapshot();
  s.db.beforeStatement = sql => {
    if (sql === 'DELETE FROM room_lab_d1_gate') {
      s.f.clock.now = START + (kind === 'proof' ? 120_000 : kind === 'invitation' ? 30_000 : 60_000);
      if (kind === 'window') s.f.db.exec('UPDATE room_lab_d1_gate SET invite_expires = NULL');
    }
  };
  expect(await s.submit(action)).toEqual({ ok: false, reason: 'storage_error' });
  expect(s.snapshot()).toEqual(before);
  expect(await s.recover(c.action)).toEqual({ ok: false, reason: 'storage_error' });
});

it('rechecks database time after a batch is queued, not just worker preflight', async () => {
  const s = await setup();
  const action = await actionFor(s.f.owner, 'create');
  s.db.beforeBatch = async () => { s.f.clock.now = action.expiresAt; };
  expect(await s.submit(action)).toEqual({ ok: false, reason: 'expired_proof' });
  expect(s.f.counts().rooms).toBe(0);
});

it('retains a committed receipt after a lost batch response; fresh recovery resolves it after expiry', async () => {
  const s = await setup();
  const action = await actionFor(s.f.owner, 'create');
  s.db.afterCommit = async () => { throw new Error('private-driver-marker'); };
  expect(await s.submit(action)).toEqual({ ok: false, reason: 'storage_error' });
  expect(s.f.counts().receipts).toBe(1);
  expect(await s.submit(action)).toEqual({ ok: false, reason: 'storage_error' });
  s.db.afterCommit = async () => {};
  const reopened = new D1RoomAdmissionStore(s.db, s.f.options);
  expect(await s.submit(action, s.f.owner, reopened)).toMatchObject({ ok: true, replayed: true });
  s.f.clock.now = action.expiresAt;
  expect(await s.recover(action, reopened)).toMatchObject({ ok: true, receipt: { requestId: action.requestId } });
  expect(s.f.counts().receipts).toBe(1);
});

it('rolls back an actual SQL failure after room mutation but before receipt insertion', async () => {
  const s = await setup();
  const before = s.snapshot();
  s.f.db.exec("CREATE TRIGGER fault BEFORE INSERT ON room_lab_receipts BEGIN SELECT RAISE(ABORT, 'fixture fault'); END");
  expect(await s.submit(await actionFor(s.f.owner, 'create'))).toEqual({ ok: false, reason: 'storage_error' });
  expect(s.snapshot()).toEqual(before);
});

it('shares concurrency bounds and poison state between admission and recovery', async () => {
  const s = await setup({ maxInFlightPerConnection: 1 });
  const c = await s.create();
  let release!: () => void;
  s.db.beforeRead = () => new Promise<void>(resolve => { release = resolve; });
  const pending = s.store.submit('invalid', s.f.owner.signingPublicKey);
  expect(await s.recover(c.action)).toEqual({ ok: false, reason: 'busy' });
  release();
  expect(await pending).toEqual({ ok: false, reason: 'invalid_wire' });
  s.db.beforeRead = async () => { throw new Error('private read fault'); };
  expect(await s.recover(c.action)).toEqual({ ok: false, reason: 'storage_error' });
  expect(await s.submit(c.action)).toEqual({ ok: false, reason: 'storage_error' });
});
