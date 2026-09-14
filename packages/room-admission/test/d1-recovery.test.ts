import { afterEach, expect, it, vi } from 'vitest';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { SQLInputValue } from 'node:sqlite';
import { sha256Hex, canonicalizeJson } from '@openagentforum/protocol';
import { D1RoomReceiptReader } from '../src/d1-recovery.js';
import { roomControlSignString } from '../src/control.js';
import { ROOM_RECOVERY_PROTOCOL, signRoomRecovery, type RoomRecoveryQuery } from '../src/recovery.js';
import { actionFor, fixture, START } from './fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanups.length) cleanups.pop()!(); });
async function setup() {
  const f = await fixture({ maxReceipts: 2 });
  cleanups.push(() => f.close());
  const created = await f.create();
  const query: RoomRecoveryQuery = {
    protocol: ROOM_RECOVERY_PROTOCOL, hub: created.action.hub, actor: f.owner.agentId,
    queryId: '1'.repeat(32), roomId: created.action.roomId, requestId: created.action.requestId,
    proofDigest: await sha256Hex(roomControlSignString(created.action)), issuedAt: START, expiresAt: START + 60_000,
  };
  const wire = await signRoomRecovery(query, f.owner.signingPrivateKey);
  const calls: { sql: string; values: unknown[] }[] = [];
  let hook: (sql: string) => Promise<void> = async () => {};
  let afterRead: (sql: string) => void = () => {};
  class Statement implements D1PreparedStatement {
    values: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) { this.values = values; return this; }
    async first<T = Record<string, unknown>>(): Promise<T | null> {
      calls.push({ sql: this.sql, values: this.values });
      expect(this.sql).toMatch(/^SELECT /);
      await hook(this.sql);
      const row = f.db.prepare(this.sql).get(...this.values as SQLInputValue[]);
      afterRead(this.sql);
      return (row ?? null) as T | null;
    }
    async run(): Promise<never> { throw new Error('No writes'); }
    async all(): Promise<never> { throw new Error('No enumeration'); }
    async raw(): Promise<never> { throw new Error('No raw reads'); }
  }
  const db: Pick<D1Database, 'withSession'> = {
    withSession(constraint) {
      expect(constraint).toBe('first-primary');
      let used = false;
      return {
        prepare(sql) { expect(used).toBe(false); used = true; return new Statement(sql); },
        async batch() { throw new Error('No batch'); }, getBookmark() { throw new Error('No bookmark'); },
      };
    },
  };
  const reader = new D1RoomReceiptReader(db, f.options);
  const recover = () => reader.recover(wire, f.owner.signingPublicKey);
  return { f, created, query, wire, db, reader, recover, calls,
    hook(value: typeof hook) { hook = value; }, afterRead(value: typeof afterRead) { afterRead = value; } };
}

it('recovers at saturation without writing metadata, receipts, budgets or close reservations', async () => {
  const s = await setup();
  const before = s.f.db.prepare('SELECT total_changes() AS n').get();
  s.f.db.exec('PRAGMA query_only = ON');
  expect(await s.recover()).toEqual({ ok: true, queryId: s.query.queryId, observedAt: START, receipt: s.created.result.receipt });
  expect(s.calls).toHaveLength(2);
  expect(s.calls[1].sql).toContain('LEFT JOIN');
  expect(s.calls[1].values).toEqual([s.query.actor, s.query.requestId, s.f.owner.signingPublicKey, s.query.proofDigest]);
  expect(s.f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});

it('recovers an expired action after closure as history, not current membership', async () => {
  const s = await setup();
  expect((await s.f.submit(await actionFor(s.f.owner, 'close', START, s.created.state))).ok).toBe(true);
  s.f.clock.now += 120_000;
  const q = { ...s.query, issuedAt: s.f.clock.now, expiresAt: s.f.clock.now + 60_000 };
  expect(await s.reader.recover(await signRoomRecovery(q, s.f.owner.signingPrivateKey), s.f.owner.signingPublicKey))
    .toEqual({ ok: true, queryId: q.queryId, observedAt: s.f.clock.now, receipt: s.created.result.receipt });
  expect(s.f.room(q.roomId).status).toBe('closed');
});

it.each(['actor', 'requestId', 'roomId', 'proofDigest', 'full-key'] as const)
('returns only unavailable for mismatched %s', async field => {
  const s = await setup();
  const q = { ...s.query };
  const actor = field === 'actor' ? s.f.outsider : s.f.owner;
  if (field === 'full-key') s.f.db.prepare('UPDATE room_lab_receipts SET signing_key = ?').run(s.f.outsider.signingPublicKey);
  else if (field === 'actor') q.actor = actor.agentId;
  else q[field] = field === 'roomId' ? `room_${'f'.repeat(32)}` : 'f'.repeat(field === 'proofDigest' ? 64 : 32);
  expect(await s.reader.recover(await signRoomRecovery(q, actor.signingPrivateKey), actor.signingPublicKey))
    .toEqual({ ok: true, queryId: q.queryId, observedAt: START, receipt: null });
});

it.each(['signature', 'noncanonical', 'hub', 'expired'] as const)
('rejects %s before reading receipts', async kind => {
  const s = await setup();
  let wire = s.wire;
  if (kind === 'signature') wire = canonicalizeJson({ ...JSON.parse(wire), signature: '0'.repeat(128) });
  if (kind === 'noncanonical') wire += ' ';
  if (kind === 'hub') wire = await signRoomRecovery({ ...s.query, hub: 'https://wrong.invalid' }, s.f.owner.signingPrivateKey);
  if (kind === 'expired') s.f.clock.now = s.query.expiresAt;
  expect((await s.reader.recover(wire, s.f.owner.signingPublicKey)).ok).toBe(false);
  expect(s.calls).toHaveLength(1);
});

it('rechecks expiry after asynchronous verification without a receipt query', async () => {
  const s = await setup();
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const result = await verify(...args); s.f.clock.now = s.query.expiresAt; return result;
  });
  expect(await s.recover()).toEqual({ ok: false, reason: 'expired_proof' });
  expect(s.calls).toHaveLength(1);
});

it('rechecks expiry after storage and honors committed high-water on local clock rollback', async () => {
  const s = await setup();
  s.f.clock.now = START - 100_000;
  expect((await s.recover()).ok).toBe(true);
  s.hook(async sql => { if (sql.includes('JOIN')) s.f.db.prepare('UPDATE room_lab_meta SET clock = ?').run(s.query.expiresAt); });
  expect(await s.recover()).toEqual({ ok: false, reason: 'expired_proof' });
});

it('rejects a valid snapshot whose asynchronous delivery outlives the proof', async () => {
  const s = await setup();
  s.afterRead(sql => { if (sql.includes('JOIN')) s.f.clock.now = s.query.expiresAt; });
  expect(await s.recover()).toEqual({ ok: false, reason: 'expired_proof' });
});

it('allows an unavailable query to observe a later commit without a mutation or negative cache', async () => {
  const s = await setup();
  const row = s.f.db.prepare('SELECT * FROM room_lab_receipts').get()!;
  // Simulate the ordering of a pending commit, only in this disposable fixture.
  s.f.db.exec('DELETE FROM room_lab_receipts');
  expect(await s.recover()).toEqual({ ok: true, queryId: s.query.queryId, observedAt: START, receipt: null });
  s.f.db.prepare('INSERT INTO room_lab_receipts VALUES (?, ?, ?, ?, ?)').run(...Object.values(row));
  expect(await s.recover()).toEqual({ ok: true, queryId: s.query.queryId, observedAt: START, receipt: s.created.result.receipt });
});

it('holds the single statement snapshot when a later commit changes metadata and the receipt', async () => {
  const s = await setup();
  s.afterRead(sql => {
    if (sql.includes('JOIN')) s.f.db.exec(`UPDATE room_lab_meta SET clock = ${s.query.expiresAt}; DELETE FROM room_lab_receipts;`);
  });
  expect((await s.recover())).toEqual({ ok: true, queryId: s.query.queryId, observedAt: START, receipt: s.created.result.receipt });
  expect(await s.recover()).toEqual({ ok: false, reason: 'expired_proof' });
});

it.each(['metadata', 'snapshot', 'corrupt-receipt', 'rollback', 'configuration'] as const)
('redacts %s failure and poisons the instance', async kind => {
  const s = await setup();
  if (kind === 'corrupt-receipt') s.f.db.prepare('UPDATE room_lab_receipts SET receipt_json = ?').run('{}');
  if (kind === 'configuration') s.f.db.exec("UPDATE room_lab_meta SET policy = '{}'");
  s.hook(async sql => {
    if ((kind === 'metadata' && !sql.includes('JOIN')) || (kind === 'snapshot' && sql.includes('JOIN'))) throw new Error('private-driver-marker');
    if (kind === 'rollback' && sql.includes('JOIN')) s.f.db.exec('UPDATE room_lab_meta SET clock = 0');
  });
  expect(await s.recover()).toEqual({ ok: false, reason: 'storage_error' });
  const count = s.calls.length;
  expect(await s.recover()).toEqual({ ok: false, reason: 'storage_error' });
  expect(s.calls).toHaveLength(count);
});

it('bounds local concurrency and releases verification slots after denial', async () => {
  const s = await setup();
  const reader = new D1RoomReceiptReader(s.db, { ...s.f.options, policy: { ...s.f.policy, maxInFlightPerConnection: 1 } });
  // Pin the matching test policy; construction must not initialize or mutate it.
  s.f.db.prepare('UPDATE room_lab_meta SET policy = ?').run(canonicalizeJson({ ...s.f.policy, maxInFlightPerConnection: 1 }));
  let release!: () => void;
  s.hook(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = reader.recover('invalid', s.f.owner.signingPublicKey);
  expect(await reader.recover(s.wire, s.f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
  release();
  expect(await pending).toEqual({ ok: false, reason: 'invalid_wire' });
  s.hook(async () => {});
  expect((await reader.recover(s.wire, s.f.owner.signingPublicKey)).ok).toBe(true);
});

it('does not release an in-flight result after another request poisons the reader', async () => {
  const s = await setup();
  let release!: () => void;
  let calls = 0;
  s.hook(() => { if (++calls === 1) return new Promise<void>(resolve => { release = resolve; }); throw new Error('storage fault'); });
  const pending = s.recover();
  expect(await s.recover()).toEqual({ ok: false, reason: 'storage_error' });
  release();
  expect(await pending).toEqual({ ok: false, reason: 'storage_error' });
});
