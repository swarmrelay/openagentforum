import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson, generateAgentKeyPair } from '@openagentforum/protocol';
import { prepareRoomControl } from '../src/control.js';
import { RoomAdmissionStore, type AdmissionPolicy, type AdmissionResult } from '../src/sqlite.js';
import { actionFor, admitted, DatabaseSync, fixture, HUB, POLICY, START } from './fixtures.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!(); });
async function setup(patch: Partial<AdmissionPolicy> = {}) {
  const f = await fixture(patch);
  cleanup.push(() => f.close());
  return f;
}

async function child(input: { path: string; policy: AdmissionPolicy; wire: string; publicKey: string; mode?: string }) {
  const process = fork(fileURLToPath(new URL('./fixtures/submit-worker.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
  });
  cleanup.push(() => { if (process.exitCode === null) process.kill(); });
  let result: AdmissionResult | undefined;
  const done = new Promise<{ result: AdmissionResult | undefined; code: number | null }>((resolve, reject) => {
    process.on('message', (message: any) => { if (message.result) result = message.result; });
    process.once('error', reject);
    process.once('exit', code => resolve({ result, code }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    process.once('message', (message: any) => message.ready ? resolve() : reject(new Error('Child not ready')));
    process.once('exit', () => reject(new Error('Child exited before ready')));
    process.once('error', reject);
  });
  process.send({ ...input, hub: HUB, now: START });
  await ready;
  return { go: () => process.send({ go: true }), done };
}

describe('internal durable SQLite room admission', () => {
  it('retains create/invite/accept/close and returns original receipts across restarts', async () => {
    const f = await setup();
    const created = await f.create();
    f.restart();
    const invited = await f.invite(f.room(created.state.roomId));
    const acceptedAction = await actionFor(f.peer, 'accept', START, invited.state);
    admitted(await f.submit(acceptedAction, f.peer));
    f.restart();
    const joined = f.room(created.state.roomId);
    expect(joined.peer?.agentId).toBe(f.peer.agentId);
    admitted(await f.submit(await actionFor(f.peer, 'close', START, joined), f.peer));
    f.restart();
    expect(f.room(joined.roomId).status).toBe('closed');
    const before = f.counts();
    const retried = admitted(await f.submit(created.action));
    expect(retried.replayed).toBe(true);
    expect(retried.receipt).toEqual(created.result.receipt);
    expect(retried.receipt.status).toBe('open'); // original mutation, NOT current state
    expect(f.counts()).toEqual(before);
  });

  it('deduplicates identical concurrent requests without double charging', async () => {
    const f = await setup();
    const action = await actionFor(f.owner, 'create');
    const wire = await f.wire(action);
    const results = await Promise.all(Array.from({ length: 8 }, () => f.store.submit(wire, f.owner.signingPublicKey)));
    expect(results.map(admitted).filter(result => !result.replayed)).toHaveLength(1);
    expect(f.counts().rooms).toBe(1);
    expect(f.counts().receipts).toBe(1);
    expect(f.counts().budgets.map(row => row.count)).toEqual([1, 1]);
  });

  it('rejects conflicting request IDs even across rooms and after the original proof expires', async () => {
    const f = await setup();
    const first = await f.create();
    const second = await f.create();
    const conflicting = await actionFor(f.owner, 'close', START, second.state);
    conflicting.requestId = first.action.requestId;
    expect(await f.submit(conflicting)).toEqual({ ok: false, reason: 'request_conflict' });
    f.clock.now += 120_000;
    f.restart();
    conflicting.issuedAt = f.clock.now;
    conflicting.expiresAt = f.clock.now + 60_000;
    expect(await f.submit(conflicting)).toEqual({ ok: false, reason: 'request_conflict' });
    expect(f.counts().receipts).toBe(2);
    expect(f.room(second.state.roomId).status).toBe('open');
  });

  it('requires a valid signature and full actor key before returning a cached receipt', async () => {
    const f = await setup();
    const { action } = await f.create();
    const wire = await f.wire(action);
    const tampered = { ...JSON.parse(wire), signature: '0'.repeat(128) };
    const before = f.counts();
    expect(await f.store.submit(canonicalizeJson(tampered), f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'invalid_signature' });
    expect(await f.store.submit(wire, f.outsider.signingPublicKey))
      .toEqual({ ok: false, reason: 'identity_mismatch' });
    expect(f.counts()).toEqual(before);
  });

  it('rejects expired retries and rechecks proof expiry after asynchronous verification', async () => {
    const f = await setup();
    const action = await actionFor(f.owner, 'create');
    const wire = await f.wire(action);
    const pending = f.store.submit(wire, f.owner.signingPublicKey);
    f.clock.now = action.expiresAt;
    expect(await pending).toEqual({ ok: false, reason: 'expired_proof' });
    expect(f.counts().rooms).toBe(0);
    f.clock.now += 1;
    const created = await f.create();
    f.clock.now = created.action.expiresAt;
    expect(await f.submit(created.action)).toEqual({ ok: false, reason: 'expired_proof' });
  });

  it('rechecks invitation expiry at commit and cannot substitute a recipient', async () => {
    const f = await setup();
    const created = await f.create();
    const invite = await actionFor(f.owner, 'invite', START, created.state, f.peer);
    if (invite.action !== 'invite') throw new Error('Expected invite');
    invite.payload.inviteExpiresAt = START + 1;
    admitted(await f.submit(invite));
    const state = f.room(created.state.roomId);
    expect(await f.submit(await actionFor(f.outsider, 'accept', START, state), f.outsider))
      .toEqual({ ok: false, reason: 'not_authorized' });
    const wire = await f.wire(await actionFor(f.peer, 'accept', START, state), f.peer);
    const pending = f.store.submit(wire, f.peer.signingPublicKey);
    f.clock.now += 1;
    expect(await pending).toEqual({ ok: false, reason: 'invitation_expired' });
    expect(f.room(state.roomId).peer).toBeNull();
  });

  it.each(['proof', 'invitation', 'window'] as const)('rolls back when %s expires/changes during synchronous SQLite work', async kind => {
    const f = await setup();
    let action = await actionFor(f.owner, 'create');
    if (kind === 'invitation') {
      const { state } = await f.create();
      action = await actionFor(f.owner, 'invite', START, state, f.peer);
      if (action.action !== 'invite') throw new Error('Expected invite');
      action.payload.inviteExpiresAt = START + 1;
    }
    if (kind === 'window') action.expiresAt = START + 300_000;
    const before = f.counts();
    f.db.function('advance_test_clock', () => {
      f.clock.now = kind === 'invitation' ? START + 1 : START + 60_000;
      return 1;
    });
    f.db.exec(`CREATE TEMP TRIGGER advance_during_write AFTER INSERT ON room_lab_receipts
      BEGIN SELECT advance_test_clock(); END;`);
    expect(await f.submit(action)).toEqual({ ok: false,
      reason: kind === 'proof' ? 'expired_proof' : kind === 'invitation' ? 'invitation_expired' : 'clock_changed' });
    expect(f.counts()).toEqual(before);
    f.db.exec('DROP TRIGGER advance_during_write');
    if (kind === 'window') admitted(await f.submit(action)); // exact proof, re-evaluated in the new window
  });

  it('enforces per-agent create limits across connections and advances fixed windows', async () => {
    const f = await setup({ createsPerAgent: 1 });
    await f.create();
    f.restart();
    const before = f.counts();
    expect(await f.submit(await actionFor(f.owner, 'create'))).toEqual({ ok: false, reason: 'create_rate_limited' });
    expect(f.counts()).toEqual(before);
    await f.create(f.peer);
    f.clock.now += f.policy.windowMs;
    await f.create();
    expect(f.counts().budgets).toHaveLength(2); // expired counters only, not receipts, are pruned
    expect(f.counts().receipts).toBe(3);
  });

  it('enforces hub-wide create limits despite freshly generated identities', async () => {
    const f = await setup({ createsPerHub: 1 });
    await f.create();
    const newcomer = await generateAgentKeyPair();
    expect(await f.submit(await actionFor(newcomer, 'create'), newcomer))
      .toEqual({ ok: false, reason: 'create_rate_limited' });
    expect(f.counts().rooms).toBe(1);
  });

  it.each(['agent', 'hub'] as const)('enforces %s invite limits without double charging retries', async scope => {
    const f = await setup(scope === 'agent' ? { invitesPerAgent: 1 } : { invitesPerHub: 1 });
    const first = await f.create();
    const otherOwner = scope === 'agent' ? f.owner : f.outsider;
    const second = await f.create(otherOwner);
    const invited = await f.invite(first.state);
    expect(admitted(await f.submit(invited.action)).replayed).toBe(true);
    expect(await f.submit(await actionFor(otherOwner, 'invite', START, second.state, f.peer), otherOwner))
      .toEqual({ ok: false, reason: 'invite_rate_limited' });
    expect(f.room(second.state.roomId).invitation).toBeNull();
    // Exhausted invitation budgets must never prevent an owner closing.
    admitted(await f.submit(await actionFor(f.owner, 'close', START, invited.state)));
  });

  it('enforces retained-room and active-room caps independently', async () => {
    const f = await setup({ maxRetainedRooms: 2, maxActiveRooms: 1 });
    const first = await f.create();
    expect(await f.submit(await actionFor(f.peer, 'create'), f.peer))
      .toEqual({ ok: false, reason: 'active_room_limit' });
    admitted(await f.submit(await actionFor(f.owner, 'close', START, first.state)));
    const second = await f.create();
    admitted(await f.submit(await actionFor(f.owner, 'close', START, second.state)));
    expect(await f.submit(await actionFor(f.peer, 'create'), f.peer))
      .toEqual({ ok: false, reason: 'room_capacity' });
    expect(f.counts().rooms).toBe(2);
  });

  it('counts accepted membership but does not reserve a victim membership slot on invitation', async () => {
    const f = await setup({ maxActiveRoomsPerAgent: 1 });
    const first = await f.create();
    expect(await f.submit(await actionFor(f.owner, 'create')))
      .toEqual({ ok: false, reason: 'member_room_limit' });
    const invite = await f.invite(first.state);
    const own = await f.create(f.peer); // pending invitation is not membership
    expect(await f.submit(await actionFor(f.peer, 'accept', START, invite.state), f.peer))
      .toEqual({ ok: false, reason: 'member_room_limit' });
    admitted(await f.submit(await actionFor(f.peer, 'close', START, own.state), f.peer));
    admitted(await f.submit(await actionFor(f.peer, 'accept', START, invite.state), f.peer));
    expect(f.room(first.state.roomId).peer?.agentId).toBe(f.peer.agentId);
  });

  it('caps pending invitations per recipient while allowing replacement and expiry', async () => {
    const f = await setup({ maxPendingInvitesPerRecipient: 1 });
    const first = await f.create();
    const second = await f.create();
    const invited = await f.invite(first.state);
    const replacement = await f.invite(invited.state);
    expect(await f.submit(await actionFor(f.owner, 'invite', START, second.state, f.peer)))
      .toEqual({ ok: false, reason: 'pending_invite_limit' });
    f.clock.now = replacement.state.invitation!.expiresAt;
    await f.invite(second.state);
  });

  it('reserves close receipts for every open room when receipt capacity is saturated', async () => {
    const f = await setup({ maxReceipts: 5 });
    const first = await f.create();
    const second = await f.create(f.peer);
    const invite = await f.invite(first.state, f.outsider);
    expect(await f.submit(await actionFor(f.owner, 'invite', START, invite.state, f.outsider)))
      .toEqual({ ok: false, reason: 'receipt_capacity' });
    expect(await f.submit(await actionFor(f.outsider, 'accept', START, invite.state), f.outsider))
      .toEqual({ ok: false, reason: 'receipt_capacity' });
    admitted(await f.submit(await actionFor(f.owner, 'close', START, invite.state)));
    admitted(await f.submit(await actionFor(f.peer, 'close', START, second.state), f.peer));
    expect(f.counts().receipts).toBe(5);
    f.restart();
    expect(admitted(await f.submit(first.action)).replayed).toBe(true);
    expect(await f.submit(await actionFor(f.owner, 'create'))).toEqual({ ok: false, reason: 'receipt_capacity' });
  });

  it('retains terminal tombstones and request conflicts through later windows and restarts', async () => {
    const f = await setup();
    const first = await f.create();
    admitted(await f.submit(await actionFor(f.owner, 'close', START, first.state)));
    f.clock.now += 3_600_000;
    f.restart();
    const closed = f.room(first.state.roomId);
    expect(await f.submit(await actionFor(f.owner, 'invite', f.clock.now, closed, f.peer)))
      .toEqual({ ok: false, reason: 'room_closed' });
    expect(await f.submit({ ...first.action, issuedAt: f.clock.now, expiresAt: f.clock.now + 60_000 }))
      .toEqual({ ok: false, reason: 'request_conflict' });
    expect(f.counts().rooms).toBe(1);
  });

  it('pins policy, hub and schema across connections without modifying existing data', async () => {
    const f = await setup();
    await f.create();
    const before = f.counts();
    for (const options of [
      { ...f.options, hub: 'https://other.example.com' },
      { ...f.options, policy: { ...f.policy, createsPerHub: f.policy.createsPerHub + 1 } },
    ]) {
      const db = new DatabaseSync(f.path);
      try { expect(() => new RoomAdmissionStore(db, options)).toThrow('configuration mismatch'); }
      finally { db.close(); }
    }
    expect(f.counts()).toEqual(before);
    f.db.prepare('UPDATE room_lab_meta SET schema_version = 2').run();
    expect(await f.submit(await actionFor(f.owner, 'create'))).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('rejects missing, invalid or inconsistent explicit policy and snapshots caller options', async () => {
    const f = await setup();
    for (const patch of [{ maxReceipts: 1 }, { createsPerHub: 0 }, { windowMs: 1.5 },
      { maxActiveRooms: 101 }, { maxInFlightPerConnection: 65 }, { extra: 1 }]) {
      const db = new DatabaseSync(':memory:');
      try { expect(() => new RoomAdmissionStore(db, { ...f.options, policy: { ...POLICY, ...patch } }))
        .toThrow('Invalid admission policy'); }
      finally { db.close(); }
    }
    f.policy.createsPerAgent = 1;
    await f.create();
    await f.create(); // constructor copied policy; caller mutation does not lower/change it
  });

  it('uses committed clock high-water across restart and rollback without reopening old windows', async () => {
    const f = await setup({ createsPerAgent: 1 });
    await f.create();
    f.clock.now += f.policy.windowMs;
    const current = await f.create();
    f.restart();
    f.clock.now = START;
    const attempt = await actionFor(f.owner, 'create', current.action.issuedAt);
    expect(await f.submit(attempt)).toEqual({ ok: false, reason: 'create_rate_limited' });
    expect(f.db.prepare('SELECT clock FROM room_lab_meta').get()?.clock).toBe(current.action.issuedAt);
  });

  it('limits in-flight verification per connection and accepts only raw signed inputs', async () => {
    const f = await setup({ maxInFlightPerConnection: 1 });
    const wire = await f.wire(await actionFor(f.owner, 'create'));
    const pending = f.store.submit(wire, f.owner.signingPublicKey);
    expect(await f.store.submit(wire, f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
    admitted(await pending);
    expect(await f.store.submit({ ok: true } as unknown as string, f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'invalid_wire' });
  });

  it('keeps prepared transition fields private even if the exposed metadata snapshot changes', async () => {
    const f = await setup();
    const action = await actionFor(f.owner, 'create');
    const prepared = await prepareRoomControl(await f.wire(action), f.owner.signingPublicKey, { hub: HUB, now: START });
    if (!prepared.ok) throw new Error(prepared.reason);
    prepared.action.roomId = `room_${'f'.repeat(32)}`;
    const result = prepared.evaluate(null, START);
    if (!result.ok) throw new Error(result.reason);
    expect(result.state.roomId).toBe(action.roomId);
  });

  it('rolls back state, rates and receipts together on a real SQLite statement failure', async () => {
    const f = await setup();
    f.db.exec(`CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON room_lab_receipts
      BEGIN SELECT RAISE(ABORT, 'private-error-marker'); END;`);
    const action = await actionFor(f.owner, 'create');
    expect(await f.submit(action)).toEqual({ ok: false, reason: 'storage_error' });
    expect(f.counts()).toEqual({ rooms: 0, receipts: 0, budgets: [] });
    expect(f.db.prepare('SELECT clock FROM room_lab_meta').get()?.clock).toBe(0);
    f.restart(); // temp trigger is gone; same signed request remains safe to retry
    admitted(await f.submit(action));
    expect(f.counts().receipts).toBe(1);
  });

  it('does not treat an uncertain COMMIT as absent or reuse an ambiguous connection', async () => {
    const f = await setup();
    const original = f.db.exec.bind(f.db);
    const spy = vi.spyOn(f.db, 'exec').mockImplementation(sql => {
      original(sql);
      if (sql === 'COMMIT') throw new Error('private-commit-error-marker');
    });
    const action = await actionFor(f.owner, 'create');
    expect(await f.submit(action)).toEqual({ ok: false, reason: 'storage_error' });
    spy.mockRestore();
    expect(await f.submit(action)).toEqual({ ok: false, reason: 'storage_error' });
    f.restart();
    expect(admitted(await f.submit(action)).replayed).toBe(true);
    expect(f.counts().rooms).toBe(1);
    expect(f.counts().receipts).toBe(1);
    expect(f.counts().budgets.map(row => row.count)).toEqual([1, 1]);
  });

  it('stops already-in-flight requests after the connection becomes ambiguous', async () => {
    const f = await setup();
    const original = f.db.exec.bind(f.db);
    const spy = vi.spyOn(f.db, 'exec').mockImplementation(sql => {
      original(sql);
      if (sql === 'COMMIT') throw new Error('lost-commit-result');
    });
    const wires = await Promise.all([f.owner, f.peer].map(async actor =>
      f.wire(await actionFor(actor, 'create'), actor)));
    const results = await Promise.all(wires.map((wire, i) => f.store.submit(wire,
      [f.owner, f.peer][i].signingPublicKey)));
    spy.mockRestore();
    expect(results).toEqual([{ ok: false, reason: 'storage_error' }, { ok: false, reason: 'storage_error' }]);
    expect(f.counts().rooms).toBe(1);
    expect(f.counts().receipts).toBe(1);
  });

  it('fails closed on a busy primary database instead of falling back to memory', async () => {
    const f = await setup();
    const other = new DatabaseSync(f.path);
    try {
      other.exec('BEGIN IMMEDIATE');
      expect(await f.submit(await actionFor(f.owner, 'create'))).toEqual({ ok: false, reason: 'storage_error' });
      other.exec('ROLLBACK');
    } finally { other.close(); }
    expect(f.counts().rooms).toBe(0);
  });

  it('serializes conflicting revisions from independent processes on the same database', async () => {
    const f = await setup();
    const { state } = await f.create();
    const actors = [f.peer, f.outsider];
    const children = await Promise.all(actors.map(async recipient => child({
      path: f.path, policy: f.policy, publicKey: f.owner.signingPublicKey,
      wire: await f.wire(await actionFor(f.owner, 'invite', START, state, recipient)),
    })));
    children.forEach(process => process.go());
    const results = await Promise.all(children.map(process => process.done));
    expect(results.map(result => result.code)).toEqual([0, 0]);
    expect(results.filter(result => result.result?.ok)).toHaveLength(1);
    expect(results.find(result => !result.result?.ok)?.result).toEqual({ ok: false, reason: 'revision_conflict' });
    expect(f.room(state.roomId).revision).toBe(2);
    expect(f.counts().receipts).toBe(2);
  });

  it('enforces a shared hub quota across independent processes and identities', async () => {
    const f = await setup({ createsPerHub: 1 });
    const children = await Promise.all([f.owner, f.peer].map(async actor => child({
      path: f.path, policy: f.policy, publicKey: actor.signingPublicKey,
      wire: await f.wire(await actionFor(actor, 'create'), actor),
    })));
    children.forEach(process => process.go());
    const results = await Promise.all(children.map(process => process.done));
    expect(results.filter(result => result.result?.ok)).toHaveLength(1);
    expect(results.find(result => !result.result?.ok)?.result).toEqual({ ok: false, reason: 'create_rate_limited' });
    expect(f.counts().rooms).toBe(1);
  });

  it.each(['crash-before-receipt', 'crash-after-commit'])('recovers safely from process %s', async mode => {
    const f = await setup();
    const action = await actionFor(f.owner, 'create');
    const process = await child({ path: f.path, policy: f.policy, mode,
      wire: await f.wire(action), publicKey: f.owner.signingPublicKey });
    process.go();
    const crash = await process.done;
    expect(crash.code).toBe(mode === 'crash-before-receipt' ? 23 : 24);
    expect(crash.result).toBeUndefined();
    f.restart();
    const expected = mode === 'crash-before-receipt' ? 0 : 1;
    expect(f.counts().rooms).toBe(expected);
    expect(f.counts().receipts).toBe(expected);
    expect(admitted(await f.submit(action)).replayed).toBe(expected === 1);
    expect(f.counts().rooms).toBe(1);
    expect(f.counts().receipts).toBe(1);
    expect(f.counts().budgets.map(row => row.count)).toEqual([1, 1]);
  });
});
