import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalizeJson, generateAgentKeyPair, sha256Hex } from '@openagentforum/protocol';
import { fixture, HUB, START, actionFor, DatabaseSync } from './fixtures.js';
import { TestD1 } from './d1-fixture.js';
import { initializeD1RoomAdmission } from '../src/d1-admission.js';
import { createBudgetedD1RoomStore, initializeD1RoomRequestBudget } from '../src/d1-request-gate.js';
import { createBudgetedSQLiteRoomStore, initializeSQLiteRoomRequestBudget } from '../src/sqlite-request-gate.js';
import { REQUEST_LANES, type RoomRequestPolicy } from '../src/request-budget.js';
import { ROOM_STATE_PROTOCOL, signRoomState } from '../src/state-read.js';
import { ROOM_RECOVERY_PROTOCOL, signRoomRecovery } from '../src/recovery.js';
import { roomControlSignString } from '../src/control.js';
import type { AdmissionPolicy } from '../src/storage-types.js';
import { BudgetedRoomStore } from '../src/request-gate.js';
import type { RequestBudget, Reservation } from '../src/request-budget.js';

const limits = () => ({ requests: 20, inputBytes: 1_000_000, verifications: 200, responseBytes: 20_000_000 });
export const requestPolicy = (): RoomRequestPolicy => ({ windowMs: 60_000,
  ordinary: limits(), read: limits(), close: limits(), recovery: limits() });
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });

for (const adapter of ['sqlite', 'd1'] as const) describe(`${adapter} durable request gate`, () => {
  async function setup(policy = requestPolicy(), localLimit = 32) {
    const f = await fixture({ maxInFlightPerConnection: localLimit }); cleanups.push(() => f.close());
    const options = { ...f.options, requests: policy };
    const binding = new TestD1(f.db);
    if (adapter === 'd1') {
      await initializeD1RoomAdmission(binding, options);
      await initializeD1RoomRequestBudget(binding, options);
    } else initializeSQLiteRoomRequestBudget(f.db, options);
    const fresh = (opts = options) => adapter === 'd1' ? createBudgetedD1RoomStore(binding, opts) : createBudgetedSQLiteRoomStore(f.db, opts);
    const state = () => JSON.parse(String(f.db.prepare('SELECT state_json FROM room_lab_request_budget').get()!.state_json));
    const initialize = () => adapter === 'd1' ? initializeD1RoomRequestBudget(binding, options) : initializeSQLiteRoomRequestBudget(f.db, options);
    const signedState = async (roomId: string) => signRoomState({ protocol: ROOM_STATE_PROTOCOL, hub: HUB,
      actor: f.owner.agentId, queryId: 'a'.repeat(32), roomId, issuedAt: f.clock.now, expiresAt: f.clock.now + 60000 }, f.owner.signingPrivateKey);
    return { f, binding, options, fresh, store: fresh(), state, initialize, signedState };
  }

  it('charges all six entrypoints before parsing and keeps fixed-size shared state', async () => {
    const t = await setup();
    await t.store.submit('{}', t.f.owner.signingPublicKey);
    await t.store.writePacket('{}');
    await t.store.readState('{}', t.f.owner.signingPublicKey);
    await t.store.readPackets('{}');
    await t.store.recover('{}', t.f.owner.signingPublicKey);
    await t.store.recoverPacket('{}');
    await t.store.submit('{"action":"close"}', t.f.owner.signingPublicKey);
    const s = t.state();
    expect(s.lanes.ordinary.requests).toBe(2); expect(s.lanes.read.requests).toBe(2);
    expect(s.lanes.read.verifications).toBe(10); expect(s.lanes.read.responseBytes).toBe(327680 + 4096);
    expect(s.lanes.recovery.requests).toBe(2); expect(s.lanes.close.requests).toBe(1);
    expect(t.f.db.prepare('SELECT count(*) AS n FROM room_lab_request_budget').get()!.n).toBe(1);
    expect(t.f.counts().rooms).toBe(0);
    expect(Object.keys(t.store)).toEqual([]); // no exposed inner store or reusable budget permit
  });

  it('bounds decoded inputs before budget I/O and does not stringify caller objects', async () => {
    const t = await setup(); const start = t.state();
    expect(await t.store.writePacket('x'.repeat(36865))).toEqual({ ok: false, reason: 'invalid_wire' });
    expect(await t.store.readPackets('é'.repeat(1500))).toEqual({ ok: false, reason: 'invalid_wire' });
    expect(await t.store.submit('{}', 'x'.repeat(1_000_000))).toEqual({ ok: false, reason: 'invalid_public_key' });
    expect(t.state()).toEqual(start);
  });

  it('fresh instances and new signing keys share the allowance; denies before crypto', async () => {
    const p = requestPolicy(); p.ordinary.requests = 2;
    const t = await setup(p);
    const verify = vi.spyOn(crypto.subtle, 'verify');
    for (let i = 0; i < 2; i++) {
      const key = await generateAgentKeyPair(), a = await actionFor(key, 'create');
      expect((await t.fresh().submit(await t.f.wire(a, key), key.signingPublicKey)).ok).toBe(true);
    }
    const before = verify.mock.calls.length;
    const a = await actionFor(t.f.owner, 'create');
    expect(await t.fresh().submit(await t.f.wire(a), t.f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'rate_limited', retryAfterMs: 60000 });
    expect(verify.mock.calls.length).toBe(before); expect(t.state().lanes.ordinary.requests).toBe(2);
    expect(t.f.counts().rooms).toBe(2);
  });

  it('exact mutation retries pay request budget without duplicating the mutation', async () => {
    const p = requestPolicy(); p.ordinary.requests = 2; const t = await setup(p);
    const a = await actionFor(t.f.owner, 'create'), wire = await t.f.wire(a);
    const first = await t.store.submit(wire, t.f.owner.signingPublicKey);
    const second = await t.store.submit(wire, t.f.owner.signingPublicKey);
    expect(first.ok).toBe(true); expect(second).toMatchObject({ ok: true, replayed: true });
    expect(await t.store.submit(wire, t.f.owner.signingPublicKey)).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(t.f.counts().rooms).toBe(1); expect(t.f.counts().receipts).toBe(1);
  });

  it('invalid signatures consume allowance and cannot become a free verification loop', async () => {
    const p = requestPolicy(); p.ordinary.requests = 1; const t = await setup(p);
    const a = await actionFor(t.f.owner, 'create');
    const original = JSON.parse(await t.f.wire(a)); original.signature = '0'.repeat(128);
    expect(await t.store.submit(canonicalizeJson(original), t.f.owner.signingPublicKey)).toMatchObject({ ok: false, reason: 'invalid_signature' });
    expect(await t.fresh().submit(await t.f.wire(a), t.f.owner.signingPublicKey)).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(t.f.counts().rooms).toBe(0);
  });

  for (const counter of ['inputBytes', 'verifications', 'responseBytes'] as const) it(`enforces shared ${counter} budgets`, async () => {
    const p = requestPolicy(); p.read[counter] = counter === 'inputBytes' ? 4 : counter === 'verifications' ? 9 : 327680;
    const t = await setup(p);
    expect((await t.store.readPackets('{}')).ok).toBe(false);
    // '{}' is two bytes, so the input budget allows exactly two attempts.
    if (counter === 'inputBytes') await t.store.readPackets('{}');
    expect(await t.store.readPackets('{}')).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(t.state().lanes.read[counter]).toBe(p.read[counter]);
  });

  it('keeps close and recovery capacity after ordinary/read exhaustion', async () => {
    const p = requestPolicy(); p.ordinary.requests = 1; p.read.requests = 1; const t = await setup(p);
    const a = await actionFor(t.f.owner, 'create');
    const created = await t.store.submit(await t.f.wire(a), t.f.owner.signingPublicKey);
    expect(created.ok).toBe(true);
    const query = await t.signedState(a.roomId);
    expect((await t.store.readState(query, t.f.owner.signingPublicKey)).ok).toBe(true);
    expect(await t.store.readState(query, t.f.owner.signingPublicKey)).toMatchObject({ reason: 'rate_limited' });
    const close = await actionFor(t.f.owner, 'close', START, t.f.room(a.roomId));
    expect((await t.store.submit(await t.f.wire(close), t.f.owner.signingPublicKey)).ok).toBe(true);
    const recovery = await signRoomRecovery({ protocol: ROOM_RECOVERY_PROTOCOL, hub: HUB,
      actor: t.f.owner.agentId, queryId: 'b'.repeat(32), roomId: a.roomId, requestId: a.requestId,
      proofDigest: await sha256Hex(roomControlSignString(a)), issuedAt: START, expiresAt: START + 60000 }, t.f.owner.signingPrivateKey);
    const recovered = await t.store.recover(recovery, t.f.owner.signingPublicKey);
    expect(recovered).toMatchObject({ ok: true, receipt: { roomId: a.roomId, status: 'open' } });
    expect(t.f.room(a.roomId).status).toBe('closed');
    expect(t.state().lanes.close.requests).toBe(1); expect(t.state().lanes.recovery.requests).toBe(1);
  });

  it('read charges touch only the budget record, not protected room/receipt/clock state', async () => {
    const t = await setup(); const created = await t.f.create();
    const snapshot = () => JSON.stringify({ ...t.f.counts(), meta: t.f.db.prepare('SELECT * FROM room_lab_meta').get(),
      rooms: t.f.db.prepare('SELECT * FROM room_lab_rooms').all() });
    const before = snapshot();
    expect((await t.store.readState(await t.signedState(created.state.roomId), t.f.owner.signingPublicKey)).ok).toBe(true);
    expect(snapshot()).toBe(before); expect(t.state().lanes.read.requests).toBe(1);
  });

  it('close classification never bypasses raw proof validation or grants room authority', async () => {
    const p = requestPolicy(); p.ordinary.requests = 1; const t = await setup(p);
    await t.store.submit('{}', t.f.owner.signingPublicKey);
    const created = await t.f.create();
    const outsider = await actionFor(t.f.outsider, 'close', START, created.state);
    expect((await t.store.submit(await t.f.wire(outsider, t.f.outsider), t.f.outsider.signingPublicKey)).ok).toBe(false);
    expect(t.f.room(created.state.roomId).status).toBe('open');
    expect(await t.store.submit('{"action":"close","action":"create"}', t.f.owner.signingPublicKey))
      .toMatchObject({ reason: 'rate_limited' });
    expect(t.state().lanes.close.requests).toBe(1);
  });

  it('resets only at the next window and clamps rollback to retained time', async () => {
    const p = requestPolicy(); p.ordinary.requests = 1; const t = await setup(p);
    await t.store.writePacket('{}'); t.f.clock.now += 60000; await t.fresh().writePacket('{}');
    const after = t.state(); t.f.clock.now -= 120000;
    expect(await t.fresh().writePacket('{}')).toMatchObject({ reason: 'rate_limited' });
    expect(t.state()).toEqual(after);
    t.f.clock.now = START + 120000; await t.fresh().writePacket('{}');
    expect(t.state().lanes.ordinary.requests).toBe(1);
    expect(t.state().clock).toBe(START + 120000);
  });

  it('pins and snapshots configuration without resetting existing counters', async () => {
    const p = requestPolicy(); p.ordinary.requests = 1; const t = await setup(p);
    p.ordinary.requests = 100; // mutation after construction is not a quota increase
    await t.store.writePacket('{}');
    expect(await t.store.writePacket('{}')).toMatchObject({ reason: 'rate_limited' });
    const prior = t.state();
    expect(await t.fresh().writePacket('{}')).toMatchObject({ reason: 'storage_error' });
    expect(t.state()).toEqual(prior);
  });

  it('missing state fails closed across all methods and is not refilled on reopen', async () => {
    const t = await setup(); t.f.db.exec('DELETE FROM room_lab_request_budget');
    expect(await t.store.writePacket('{}')).toEqual({ ok: false, reason: 'storage_error' });
    expect(await t.store.recoverPacket('{}')).toEqual({ ok: false, reason: 'storage_error' });
    expect(await t.fresh().writePacket('{}')).toEqual({ ok: false, reason: 'storage_error' });
    await expect(Promise.resolve().then(t.initialize)).rejects.toThrow('initialization failed');
    expect(t.f.db.prepare('SELECT count(*) AS n FROM room_lab_request_budget').get()!.n).toBe(0);
  });

  for (const corruption of ['json', 'clock', 'window', 'counter', 'unknown', 'noncanonical', 'hub', 'policy']) {
    it(`retained ${corruption} corruption stops verification and is never repaired by initialization`, async () => {
      const t = await setup();
      const s = t.state();
      if (corruption === 'clock') s.clock = -1;
      if (corruption === 'window') s.bucket = 1;
      if (corruption === 'counter') s.lanes.read.requests = 21;
      if (corruption === 'unknown') s.extra = 1;
      const wire = corruption === 'json' ? '{' : corruption === 'noncanonical' ? ' ' + canonicalizeJson(s) : canonicalizeJson(s);
      t.f.db.prepare('UPDATE room_lab_request_budget SET state_json = ?').run(wire);
      if (corruption === 'hub') t.f.db.prepare('UPDATE room_lab_request_budget SET hub = ?').run('https://other.example');
      if (corruption === 'policy') t.f.db.prepare('UPDATE room_lab_request_budget SET policy = ?').run('{}');
      const before = t.f.db.prepare('SELECT * FROM room_lab_request_budget').get();
      const verify = vi.spyOn(crypto.subtle, 'verify');
      const a = await actionFor(t.f.owner, 'create');
      expect(await t.store.submit(await t.f.wire(a), t.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
      expect(verify).not.toHaveBeenCalled();
      expect(await t.fresh().readPackets('{}')).toEqual({ ok: false, reason: 'storage_error' });
      await expect(Promise.resolve().then(t.initialize)).rejects.toThrow('initialization failed');
      expect(t.f.db.prepare('SELECT * FROM room_lab_request_budget').get()).toEqual(before);
      expect(t.f.counts().rooms).toBe(0);
    });
  }

  it('missing budget table is never created by request handling', async () => {
    const t = await setup(); t.f.db.exec('DROP TABLE room_lab_request_budget');
    expect(await t.fresh().writePacket('{}')).toEqual({ ok: false, reason: 'storage_error' });
    expect(t.f.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'room_lab_request_budget'").get()).toBeUndefined();
  });

  it('caps local work while a reservation is pending', async () => {
    const t = await setup(requestPolicy(), 1);
    const first = t.store.writePacket('{}');
    expect(await t.store.writePacket('{}')).toEqual({ ok: false, reason: 'busy' });
    await first; expect(t.state().lanes.ordinary.requests).toBe(1);
  });

  it('concurrent independent instances cannot oversubscribe one shared allowance', async () => {
    const p = requestPolicy(); p.ordinary.requests = 1; const t = await setup(p);
    const results = await Promise.all(Array.from({ length: 10 }, () => t.fresh().writePacket('{}')));
    expect(results.filter(r => !r.ok && r.reason === 'not_configured')).toHaveLength(1);
    expect(results.every(r => !r.ok && ['not_configured', 'rate_limited', 'busy'].includes(r.reason))).toBe(true);
    expect(t.state().lanes.ordinary.requests).toBe(1);
  });

  if (adapter === 'd1') {
    // Hold both primary snapshots until both callers have read the same counter.
    // Unlike timing-based stress, this forces the stale-CAS interleaving.
    function collide(binding: TestD1) {
      let reads = 0, release!: () => void;
      const paired = new Promise<void>(resolve => { release = resolve; });
      binding.afterRead = async sql => {
        if (!sql.includes('AS db_now FROM room_lab_request_budget')) return;
        if (++reads === 2) release();
        if (reads <= 2) await paired;
      };
    }

    it('replans a definite missed reservation so concurrent callers can both use remaining capacity', async () => {
      const t = await setup(); const created = await t.f.create();
      const wire = await t.signedState(created.state.roomId);
      collide(t.binding); const batch = vi.spyOn(t.binding, 'batch');
      const results = await Promise.all([t.fresh(), t.fresh()].map(store => store.readState(wire, t.f.owner.signingPublicKey)));
      expect(results.every(r => r.ok)).toBe(true);
      expect(batch).toHaveBeenCalledTimes(3); // winner, definite zero-row loser, fresh reservation
      expect(t.state().lanes.read.requests).toBe(2);
      expect(t.state().lanes.read.verifications).toBe(2);
      expect(t.f.counts().receipts).toBe(1);
    });

    it('rechecks exhaustion after the competing reservation wins without extra verification', async () => {
      const p = requestPolicy(); p.read.requests = 1;
      const t = await setup(p); const created = await t.f.create();
      const wire = await t.signedState(created.state.roomId);
      collide(t.binding); const verify = vi.spyOn(crypto.subtle, 'verify');
      const batch = vi.spyOn(t.binding, 'batch');
      const results = await Promise.all([t.fresh(), t.fresh()].map(store => store.readState(wire, t.f.owner.signingPublicKey)));
      expect(results.filter(r => r.ok)).toHaveLength(1);
      expect(results.find(r => !r.ok)).toMatchObject({ reason: 'rate_limited' });
      expect(batch).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(t.state().lanes.read.requests).toBe(1);
    });

    it('keeps different lanes independent when they race on the shared row', async () => {
      const t = await setup(); collide(t.binding);
      const results = await Promise.all([t.fresh().writePacket('{}'), t.fresh().recoverPacket('{}')]);
      expect(results).toEqual([{ ok: false, reason: 'not_configured' }, { ok: false, reason: 'not_configured' }]);
      expect(t.state().lanes.ordinary.requests).toBe(1);
      expect(t.state().lanes.recovery.requests).toBe(1);
    });

    it('bounds persistent CAS contention to three attempts without protected work', async () => {
      const t = await setup(); const wire = await t.f.wire(await actionFor(t.f.owner, 'create'));
      let attempts = 0;
      t.binding.beforeBatch = async () => {
        attempts++;
        const state = t.state(); state.clock++;
        t.f.db.prepare('UPDATE room_lab_request_budget SET state_json = ?').run(canonicalizeJson(state));
      };
      const verify = vi.spyOn(crypto.subtle, 'verify');
      expect(await t.store.submit(wire, t.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
      expect(attempts).toBe(3); expect(verify).not.toHaveBeenCalled();
      expect(t.state().lanes.ordinary.requests).toBe(0); expect(t.f.counts().rooms).toBe(0);
    });

    for (const change of ['policy', 'missing', 'rollover', 'deadline'] as const) {
      it(`refuses ${change} after a definite missed reservation`, async () => {
        const t = await setup(); const wire = await t.f.wire(await actionFor(t.f.owner, 'create'));
        let attempts = 0, expired = false;
        const store = t.fresh({ ...t.options, now: () => { if (expired) throw new Error('Operation deadline'); return t.f.clock.now; } });
        t.binding.beforeBatch = async () => {
          attempts++;
          if (change === 'policy') t.f.db.prepare('UPDATE room_lab_request_budget SET policy = ?').run('{}');
          else if (change === 'missing') t.f.db.exec('DELETE FROM room_lab_request_budget');
          else {
            const state = t.state(); state.clock++;
            t.f.db.prepare('UPDATE room_lab_request_budget SET state_json = ?').run(canonicalizeJson(state));
            if (change === 'rollover') t.f.clock.now += 60000; else expired = true;
          }
        };
        const verify = vi.spyOn(crypto.subtle, 'verify');
        expect(await store.submit(wire, t.f.owner.signingPublicKey))
          .toEqual({ ok: false, reason: change === 'rollover' ? 'busy' : 'storage_error' });
        expect(attempts).toBe(1); expect(verify).not.toHaveBeenCalled(); expect(t.f.counts().rooms).toBe(0);
      });
    }
  }

  it('uncertain budget commit never reaches protected work and does not refund the charge', async () => {
    const t = await setup(); const a = await actionFor(t.f.owner, 'create'), wire = await t.f.wire(a);
    const batches = vi.spyOn(t.binding, 'batch');
    if (adapter === 'd1') t.binding.afterCommit = async () => { throw new Error('lost budget acknowledgment'); };
    else {
      const original = t.f.db.exec.bind(t.f.db);
      vi.spyOn(t.f.db, 'exec').mockImplementation(sql => { original(sql); if (sql === 'COMMIT') throw new Error('lost budget acknowledgment'); });
    }
    expect(await t.store.submit(wire, t.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
    expect(t.f.counts().rooms).toBe(0); expect(t.state().lanes.ordinary.requests).toBe(1);
    expect(await t.store.recoverPacket('{}')).toEqual({ ok: false, reason: 'storage_error' });
    if (adapter === 'd1') expect(batches).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks(); t.binding.afterCommit = async () => {};
    expect((await t.fresh().submit(wire, t.f.owner.signingPublicKey)).ok).toBe(true);
    expect(t.state().lanes.ordinary.requests).toBe(2);
  });

  it('a late budget acknowledgment does not start protected work in another window', async () => {
    const t = await setup(); const a = await actionFor(t.f.owner, 'create'), wire = await t.f.wire(a);
    const batches = vi.spyOn(t.binding, 'batch');
    if (adapter === 'd1') t.binding.afterCommit = async () => { t.f.clock.now += 60000; };
    else {
      const original = t.f.db.exec.bind(t.f.db);
      vi.spyOn(t.f.db, 'exec').mockImplementation(sql => { original(sql); if (sql === 'COMMIT') t.f.clock.now += 60000; });
    }
    expect(await t.store.submit(wire, t.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
    expect(t.f.counts().rooms).toBe(0); expect(t.state().lanes.ordinary.requests).toBe(1);
    if (adapter === 'd1') expect(batches).toHaveBeenCalledTimes(1);
  });

  it('survives a database connection restart without resetting allowance', async () => {
    const p = requestPolicy(); p.ordinary.requests = 1; const t = await setup(p);
    await t.store.writePacket('{}');
    const reopened = new DatabaseSync(t.f.path); cleanups.push(() => reopened.close());
    const other = adapter === 'd1' ? createBudgetedD1RoomStore(new TestD1(reopened), t.options) : createBudgetedSQLiteRoomStore(reopened, t.options);
    expect(await other.writePacket('{}')).toMatchObject({ reason: 'rate_limited' });
  });
});

describe('shared wrapper failure boundaries', () => {
  function pending<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  async function wrapped(budget: RequestBudget) {
    const f = await fixture(); cleanups.push(() => f.close());
    const spy = vi.spyOn(f.store, 'readPackets');
    return { f, spy, store: new BudgetedRoomStore(f.store, budget, () => START, 4) };
  }
  it('does not start a pending reserved operation after another reservation poisons the instance', async () => {
    const held = pending<Reservation>(); let calls = 0;
    const t = await wrapped({ reserve: () => ++calls === 1 ? held.promise : Promise.resolve({ ok: false, reason: 'storage_error' }) });
    const first = t.store.readPackets('{}');
    expect(await t.store.readPackets('{}')).toEqual({ ok: false, reason: 'storage_error' });
    held.resolve({ ok: true, expiresAt: START + 60000 });
    expect(await first).toEqual({ ok: false, reason: 'storage_error' });
    expect(t.spy).not.toHaveBeenCalled();
  });
  it('suppresses a pending protected read after another reservation fails', async () => {
    let calls = 0;
    const t = await wrapped({ reserve: async () => ++calls === 1 ? { ok: true, expiresAt: START + 60000 } : { ok: false, reason: 'storage_error' } });
    const started = pending<void>();
    const result = pending<Awaited<ReturnType<typeof t.f.store.readPackets>>>();
    t.spy.mockImplementation(() => { started.resolve(); return result.promise; });
    const first = t.store.readPackets('{}'); await started.promise;
    expect(await t.store.readPackets('{}')).toEqual({ ok: false, reason: 'storage_error' });
    result.resolve({ ok: false, reason: 'not_configured' });
    expect(await first).toEqual({ ok: false, reason: 'storage_error' });
  });
  it('redacts an oversized protected response and poisons later requests', async () => {
    const t = await wrapped({ reserve: async () => ({ ok: true, expiresAt: START + 60000 }) });
    t.spy.mockResolvedValue({ ok: false, reason: 'not_configured', extra: 'x'.repeat(327681) } as Awaited<ReturnType<typeof t.f.store.readPackets>>);
    expect(await t.store.readPackets('{}')).toEqual({ ok: false, reason: 'storage_error' });
    expect(await t.store.writePacket('{}')).toEqual({ ok: false, reason: 'storage_error' });
    expect(t.spy).toHaveBeenCalledTimes(1);
  });
});

it('rejects invalid and oversized policy fields with no implicit defaults', async () => {
  const f = await fixture(); cleanups.push(() => f.close());
  for (const lane of REQUEST_LANES) {
    const p = requestPolicy(); p[lane].requests = 0;
    expect(() => createBudgetedD1RoomStore(new TestD1(f.db), { ...f.options, requests: p })).toThrow();
  }
  const p = requestPolicy(); p.windowMs = 86_400_001;
  expect(() => createBudgetedSQLiteRoomStore(f.db, { ...f.options, requests: p })).toThrow();
});

async function budgetChild(configuration: { path: string; hub: string; policy: AdmissionPolicy;
  requests: RoomRequestPolicy; now: number; wire: string; key: string; crashAfterCharge?: boolean }) {
  const proc = fork(fileURLToPath(new URL('./fixtures/request-budget-worker.mjs', import.meta.url)), [],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  cleanups.push(() => { if (proc.exitCode === null) proc.kill(); });
  let result: unknown;
  const done = new Promise<{ result: unknown; code: number | null }>((resolve, reject) => {
    proc.on('message', message => {
      if (message && typeof message === 'object' && 'result' in message) result = message.result;
    });
    proc.once('error', reject); proc.once('exit', code => resolve({ result, code }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    proc.once('message', message => message && typeof message === 'object' && 'ready' in message && message.ready
      ? resolve() : reject(new Error('Child not ready')));
    proc.once('error', reject); proc.once('exit', () => reject(new Error('Child exited before ready')));
  });
  proc.send(configuration); await ready;
  return { go: () => proc.send({ go: true }), done };
}

it('independent SQLite processes share one pre-verification request allowance', async () => {
  const f = await fixture(); cleanups.push(() => f.close());
  const requests = requestPolicy(); requests.ordinary.requests = 1;
  initializeSQLiteRoomRequestBudget(f.db, { ...f.options, requests });
  const children = [];
  for (const key of [f.owner, f.peer, f.outsider]) {
    const wire = await f.wire(await actionFor(key, 'create'), key);
    children.push(await budgetChild({ path: f.path, hub: HUB, policy: f.policy, requests, now: START, wire, key: key.signingPublicKey }));
  }
  children.forEach(child => child.go());
  const results = await Promise.all(children.map(child => child.done));
  expect(results.every(r => r.code === 0)).toBe(true);
  expect(results.filter(r => r.result && typeof r.result === 'object' && 'ok' in r.result && r.result.ok)).toHaveLength(1);
  expect(results.filter(r => r.result && typeof r.result === 'object' && 'reason' in r.result && r.result.reason === 'rate_limited')).toHaveLength(2);
  expect(f.counts().rooms).toBe(1);
  expect(JSON.parse(String(f.db.prepare('SELECT state_json FROM room_lab_request_budget').get()!.state_json)).lanes.ordinary.requests).toBe(1);
}, 15000);

it('process exit after the budget commit consumes allowance without performing the room action', async () => {
  const f = await fixture(); cleanups.push(() => f.close());
  const requests = requestPolicy(); requests.ordinary.requests = 1;
  initializeSQLiteRoomRequestBudget(f.db, { ...f.options, requests });
  const wire = await f.wire(await actionFor(f.owner, 'create'));
  const config = { path: f.path, hub: HUB, policy: f.policy, requests, now: START, wire, key: f.owner.signingPublicKey };
  const first = await budgetChild({ ...config, crashAfterCharge: true }); first.go();
  expect(await first.done).toEqual({ result: undefined, code: 24 });
  expect(f.counts().rooms).toBe(0);
  const restarted = await budgetChild(config); restarted.go();
  expect(await restarted.done).toMatchObject({ result: { ok: false, reason: 'rate_limited' }, code: 0 });
  expect(f.counts().rooms).toBe(0);
}, 15000);
