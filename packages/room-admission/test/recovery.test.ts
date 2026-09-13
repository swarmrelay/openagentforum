import { createPublicKey, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson, sha256Hex } from '@openagentforum/protocol';
import { roomControlSignString, type RoomControlAction } from '../src/control.js';
import {
  prepareRoomRecovery, ROOM_RECOVERY_PROTOCOL, roomRecoverySignString,
  signRoomRecovery, type RoomRecoveryQuery,
} from '../src/recovery.js';
import type { AdmissionPolicy } from '../src/sqlite.js';
import { actionFor, admitted, DatabaseSync, fixture, HUB, START } from './fixtures.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!(); });
async function setup(policy: Partial<AdmissionPolicy> = {}) {
  const f = await fixture(policy);
  cleanup.push(() => f.close());
  return f;
}
let queryCounter = 0;
async function queryFor(action: RoomControlAction, at = START): Promise<RoomRecoveryQuery> {
  return {
    protocol: ROOM_RECOVERY_PROTOCOL, hub: action.hub, actor: action.actor,
    queryId: (++queryCounter).toString(16).padStart(32, '0'),
    roomId: action.roomId, requestId: action.requestId,
    proofDigest: await sha256Hex(roomControlSignString(action)), issuedAt: at, expiresAt: at + 60_000,
  };
}
function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    counts: f.counts(), meta: f.db.prepare('SELECT * FROM room_lab_meta').all(),
    rooms: f.db.prepare('SELECT * FROM room_lab_rooms ORDER BY room_id').all(),
    receipts: f.db.prepare('SELECT * FROM room_lab_receipts ORDER BY actor, request_id').all(),
    changes: f.db.prepare('SELECT total_changes() AS n').get(),
  };
}

describe('internal signed receipt recovery', () => {
  it('recovers the original receipt after proof expiry and restart without any storage writes', async () => {
    const f = await setup();
    const created = await f.create();
    f.clock.now = created.action.expiresAt;
    f.restart();
    const before = snapshot(f);
    f.db.exec('PRAGMA query_only = ON');
    const query = await queryFor(created.action, f.clock.now);
    const result = await f.store.recover(await signRoomRecovery(query, f.owner.signingPrivateKey), f.owner.signingPublicKey);
    expect(result).toEqual({ ok: true, queryId: query.queryId, observedAt: f.clock.now, receipt: created.result.receipt });
    expect(snapshot(f)).toEqual(before); // includes durable clock and old rate-window counters
  });

  it('returns historical receipts after closure, not current membership, keys or invitation data', async () => {
    const f = await setup();
    const created = await f.create();
    const invited = await f.invite(created.state);
    const accept = await actionFor(f.peer, 'accept', START, invited.state);
    const accepted = admitted(await f.submit(accept, f.peer));
    const close = await actionFor(f.peer, 'close', START, f.room(created.state.roomId));
    const closed = admitted(await f.submit(close, f.peer));
    f.clock.now += 120_000;
    f.restart();
    for (const [action, actor, receipt] of [
      [created.action, f.owner, created.result.receipt], [invited.action, f.owner, invited.result.receipt],
      [accept, f.peer, accepted.receipt], [close, f.peer, closed.receipt],
    ] as const) {
      const query = await queryFor(action, f.clock.now);
      expect(await f.store.recover(await signRoomRecovery(query, actor.signingPrivateKey), actor.signingPublicKey))
        .toEqual({ ok: true, queryId: query.queryId, observedAt: f.clock.now, receipt });
    }
    expect(created.result.receipt.status).toBe('open');
    expect(f.room(created.state.roomId).status).toBe('closed');
  });

  it.each(['actor', 'requestId', 'roomId', 'proofDigest', 'stored-full-key'] as const)
  ('returns the same unavailable shape for a mismatched %s', async field => {
    const f = await setup();
    const created = await f.create();
    const query = await queryFor(created.action);
    const actor = field === 'actor' ? f.outsider : f.owner;
    if (field === 'actor') query.actor = actor.agentId;
    else if (field === 'stored-full-key') {
      // Model a short-ID alias without relying on the feasibility of finding a hash collision.
      f.db.prepare('UPDATE room_lab_receipts SET signing_key = ?').run(f.outsider.signingPublicKey);
    } else query[field] = field === 'roomId' ? `room_${'f'.repeat(32)}` : 'f'.repeat(field === 'proofDigest' ? 64 : 32);
    const before = snapshot(f);
    expect(await f.store.recover(await signRoomRecovery(query, actor.signingPrivateKey), actor.signingPublicKey))
      .toEqual({ ok: true, queryId: query.queryId, observedAt: START, receipt: null });
    expect(snapshot(f)).toEqual(before);
  });

  it('cannot recover another member\'s receipt just because the caller joined the room', async () => {
    const f = await setup();
    const created = await f.create();
    const invite = await f.invite(created.state);
    admitted(await f.submit(await actionFor(f.peer, 'accept', START, invite.state), f.peer));
    const query = { ...await queryFor(created.action), actor: f.peer.agentId };
    expect(await f.store.recover(await signRoomRecovery(query, f.peer.signingPrivateKey), f.peer.signingPublicKey))
      .toEqual({ ok: true, queryId: query.queryId, observedAt: START, receipt: null });
  });

  it('treats unavailable as a snapshot result, not a promise that a pending action cannot commit', async () => {
    const f = await setup();
    const action = await actionFor(f.owner, 'create');
    const query = await queryFor(action);
    const wire = await signRoomRecovery(query, f.owner.signingPrivateKey);
    expect(await f.store.recover(wire, f.owner.signingPublicKey))
      .toEqual({ ok: true, queryId: query.queryId, observedAt: START, receipt: null });
    const result = admitted(await f.submit(action));
    expect(await f.store.recover(wire, f.owner.signingPublicKey))
      .toEqual({ ok: true, queryId: query.queryId, observedAt: START, receipt: result.receipt });
  });

  it('recovers after an uncertain COMMIT with the original action expired', async () => {
    const f = await setup();
    const action = await actionFor(f.owner, 'create');
    const original = f.db.exec.bind(f.db);
    const spy = vi.spyOn(f.db, 'exec').mockImplementation(sql => {
      original(sql);
      if (sql === 'COMMIT') throw new Error('private-commit-marker');
    });
    expect(await f.submit(action)).toEqual({ ok: false, reason: 'storage_error' });
    spy.mockRestore();
    const query = await queryFor(action, action.expiresAt);
    const wire = await signRoomRecovery(query, f.owner.signingPrivateKey);
    expect(await f.store.recover(wire, f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'storage_error' });
    f.clock.now = action.expiresAt;
    f.restart();
    const before = snapshot(f);
    const result = await f.store.recover(wire, f.owner.signingPublicKey);
    expect(result.ok && result.receipt?.requestId).toBe(action.requestId);
    expect(snapshot(f)).toEqual(before);
    expect(f.counts().receipts).toBe(1);
  });

  it('reads one committed WAL snapshot despite another connection committing during the lookup', async () => {
    const f = await setup();
    const created = await f.create();
    const other = new DatabaseSync(f.path);
    try {
      const prepare = f.db.prepare.bind(f.db);
      let changed = false;
      const spy = vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
        if (sql.includes('SELECT receipt_json') && !changed) {
          changed = true;
          // A deliberate fixture-only update after the reader established its snapshot.
          other.prepare('UPDATE room_lab_receipts SET signing_key = ?').run(f.outsider.signingPublicKey);
        }
        return prepare(sql);
      });
      const query = await queryFor(created.action);
      const wire = await signRoomRecovery(query, f.owner.signingPrivateKey);
      const first = await f.store.recover(wire, f.owner.signingPublicKey);
      expect(changed).toBe(true);
      expect(first.ok && first.receipt).toEqual(created.result.receipt);
      spy.mockRestore();
      const next = await f.store.recover(wire, f.owner.signingPublicKey);
      expect(next.ok && next.receipt).toBeNull();
    } finally { other.close(); }
  });

  it('does not expose uncommitted changes from another connection', async () => {
    const f = await setup();
    const created = await f.create();
    const other = new DatabaseSync(f.path);
    try {
      other.exec('BEGIN IMMEDIATE');
      other.prepare('UPDATE room_lab_receipts SET signing_key = ?').run(f.outsider.signingPublicKey);
      const query = await queryFor(created.action);
      const result = await f.store.recover(await signRoomRecovery(query, f.owner.signingPrivateKey), f.owner.signingPublicKey);
      expect(result.ok && result.receipt).toEqual(created.result.receipt);
      other.exec('ROLLBACK');
    } finally { other.close(); }
  });

  it('keeps recovery repeatable at capacity without consuming the reserved close receipt', async () => {
    const f = await setup({ maxReceipts: 2 });
    const created = await f.create();
    const query = await queryFor(created.action);
    const wire = await signRoomRecovery(query, f.owner.signingPrivateKey);
    const before = snapshot(f);
    const results = await Promise.all(Array.from({ length: 8 }, () => f.store.recover(wire, f.owner.signingPublicKey)));
    expect(results.every(result => result.ok && result.receipt?.requestId === created.action.requestId)).toBe(true);
    expect(snapshot(f)).toEqual(before);
    admitted(await f.submit(await actionFor(f.owner, 'close', START, created.state)));
    expect(f.counts().receipts).toBe(2);
  });

  it.each(['expired', 'future', 'during-verification', 'during-read'] as const)('rejects %s recovery proofs', async kind => {
    const f = await setup();
    const created = await f.create();
    const query = await queryFor(created.action, kind === 'future' ? START + 30_001 : START);
    const wire = await signRoomRecovery(query, f.owner.signingPrivateKey);
    if (kind === 'expired') f.clock.now = query.expiresAt;
    if (kind === 'during-read') {
      const prepare = f.db.prepare.bind(f.db);
      vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
        if (sql.includes('SELECT receipt_json')) f.clock.now = query.expiresAt;
        return prepare(sql);
      });
    }
    const before = snapshot(f);
    const result = f.store.recover(wire, f.owner.signingPublicKey);
    if (kind === 'during-verification') f.clock.now = query.expiresAt;
    expect(await result).toEqual({ ok: false, reason: kind === 'future' ? 'future_proof' : 'expired_proof' });
    expect(snapshot(f)).toEqual(before);
  });

  it('honors committed clock high-water across rollback and restart', async () => {
    const f = await setup();
    const created = await f.create();
    const query = await queryFor(created.action);
    f.clock.now = query.expiresAt;
    await f.create(); // admission persists clock progress; recovery never writes it
    f.restart();
    f.clock.now = START;
    expect(await f.store.recover(await signRoomRecovery(query, f.owner.signingPrivateKey), f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'expired_proof' });
  });

  it('shares the local in-flight bound with admission in both directions', async () => {
    const f = await setup({ maxInFlightPerConnection: 1 });
    const created = await f.create();
    const query = await queryFor(created.action);
    const read = await signRoomRecovery(query, f.owner.signingPrivateKey);
    const write = await f.wire(created.action);
    const pendingRead = f.store.recover(read, f.owner.signingPublicKey);
    expect(await f.store.submit(write, f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
    expect(await f.store.recover(read, f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
    expect((await pendingRead).ok).toBe(true);
    const pendingWrite = f.store.submit(write, f.owner.signingPublicKey);
    expect(await f.store.recover(read, f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'busy' });
    admitted(await pendingWrite);
  });

  it.each(['storage-read', 'read-commit'] as const)('redacts %s failures and poisons queued operations', async kind => {
    const f = await setup();
    const created = await f.create();
    const query = await queryFor(created.action);
    const wire = await signRoomRecovery(query, f.owner.signingPrivateKey);
    if (kind === 'storage-read') {
      f.db.prepare('UPDATE room_lab_receipts SET receipt_json = ?').run('{');
    } else {
      const original = f.db.exec.bind(f.db);
      vi.spyOn(f.db, 'exec').mockImplementation(sql => {
        original(sql);
        if (sql === 'COMMIT') throw new Error('private-read-commit-marker');
      });
    }
    expect(await Promise.all([1, 2].map(() => f.store.recover(wire, f.owner.signingPublicKey))))
      .toEqual([{ ok: false, reason: 'storage_error' }, { ok: false, reason: 'storage_error' }]);
    expect(await f.submit(created.action)).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('does not return unexpected fields from a damaged stored receipt', async () => {
    const f = await setup();
    const created = await f.create();
    f.db.prepare('UPDATE room_lab_receipts SET receipt_json = ?')
      .run(canonicalizeJson({ ...created.result.receipt, unexpected: 'private-marker' }));
    const query = await queryFor(created.action);
    expect(await f.store.recover(await signRoomRecovery(query, f.owner.signingPrivateKey), f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'storage_error' });
  });
});

describe('recovery wire and signature boundaries', () => {
  it('pins the signing prefix and verifies with the independent Node Ed25519 API', async () => {
    const f = await setup();
    const query = await queryFor(await actionFor(f.owner, 'create'));
    const wire = await signRoomRecovery(query, f.owner.signingPrivateKey);
    const signature = JSON.parse(wire).signature;
    const bytes = `oaf-room-recovery-v1-draft1\n${canonicalizeJson(query)}`;
    expect(roomRecoverySignString(query)).toBe(bytes);
    const key = createPublicKey({ key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(f.owner.signingPublicKey, 'hex'),
    ]), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(bytes), key, Buffer.from(signature, 'hex'))).toBe(true);
    expect(verify(null, Buffer.from(bytes.replace('recovery', 'control')), key, Buffer.from(signature, 'hex'))).toBe(false);
  });

  it.each([
    ['extra', { extra: true }], ['missing', { queryId: undefined }], ['protocol', { protocol: 'oaf-room-control-v1-draft1' }],
    ['nested', { queryId: {} }], ['room', { roomId: 'general' }], ['actor', { actor: 'agent_0' }],
    ['request', { requestId: '0' }], ['digest', { proofDigest: 'A'.repeat(64) }],
    ['lifetime', { expiresAt: START + 60_001 }], ['empty-lifetime', { expiresAt: START }],
    ['fractional', { issuedAt: START + 0.5 }], ['hub-path', { hub: `${HUB}/` }],
  ] as const)('rejects invalid %s schema', async (_name, patch) => {
    const f = await setup();
    const query = await queryFor(await actionFor(f.owner, 'create'));
    const fields = Object.fromEntries(Object.entries({ ...query, ...patch, signature: '0'.repeat(128) })
      .filter(([, value]) => value !== undefined));
    const wire = canonicalizeJson(fields);
    expect(await f.store.recover(wire, f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'invalid_schema' });
  });

  it.each(['whitespace', 'duplicate', 'escaped', 'reordered'] as const)('rejects %s wire without normalizing it', async kind => {
    const f = await setup();
    const query = await queryFor(await actionFor(f.owner, 'create'));
    const wire = await signRoomRecovery(query, f.owner.signingPrivateKey);
    const malformed = kind === 'whitespace' ? `${wire}\n`
      : kind === 'duplicate' ? wire.replace('{', `{"actor":"${query.actor}",`)
      : kind === 'escaped' ? wire.replace('actor', '\\u0061ctor')
      : JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(wire)).reverse()));
    expect(await f.store.recover(malformed, f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'noncanonical_wire' });
  });

  it('rejects non-string, malformed and oversized input before verification', async () => {
    const f = await setup();
    const spy = vi.spyOn(crypto.subtle, 'verify');
    for (const wire of [{ ok: true }, '{', ' '.repeat(2049), '界'.repeat(1000)]) {
      expect(await f.store.recover(wire as string, f.owner.signingPublicKey))
        .toEqual({ ok: false, reason: 'invalid_wire' });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects tampering, wrong hub/key, and crossing the control/recovery boundary', async () => {
    const f = await setup();
    const created = await f.create();
    const query = await queryFor(created.action);
    const wire = await signRoomRecovery(query, f.owner.signingPrivateKey);
    expect(await f.store.recover(canonicalizeJson({ ...JSON.parse(wire), signature: '0'.repeat(128) }), f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'invalid_signature' });
    expect(await f.store.recover(wire, 'bad')).toEqual({ ok: false, reason: 'invalid_public_key' });
    expect(await f.store.recover(wire, f.outsider.signingPublicKey)).toEqual({ ok: false, reason: 'identity_mismatch' });
    expect(await f.store.recover(await signRoomRecovery({ ...query, hub: 'https://other.example.com' }, f.owner.signingPrivateKey), f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'wrong_hub' });
    expect(await f.store.recover(await f.wire(created.action), f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'invalid_schema' });
    expect(await f.store.submit(wire, f.owner.signingPublicKey)).toEqual({ ok: false, reason: 'invalid_schema' });
    expect(await f.store.recover(await signRoomRecovery(query, f.outsider.signingPrivateKey), f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it.each(['roomId', 'requestId', 'proofDigest', 'queryId', 'issuedAt', 'expiresAt'] as const)
  ('authenticates the signed %s field without allowing substitution', async field => {
    const f = await setup();
    const created = await f.create();
    const query = await queryFor(created.action);
    const proof = JSON.parse(await signRoomRecovery(query, f.owner.signingPrivateKey));
    proof[field] = field === 'roomId' ? `room_${'f'.repeat(32)}`
      : field === 'issuedAt' ? START + 1 : field === 'expiresAt' ? START + 59_999
      : 'f'.repeat(field === 'proofDigest' ? 64 : 32);
    expect(await f.store.recover(canonicalizeJson(proof), f.owner.signingPublicKey))
      .toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('snapshots local signing input and freezes every prepared query field', async () => {
    const f = await setup();
    const query = await queryFor(await actionFor(f.owner, 'create'));
    const original = structuredClone(query);
    const pending = signRoomRecovery(query, f.owner.signingPrivateKey);
    query.roomId = `room_${'f'.repeat(32)}`;
    const wire = await pending;
    expect(JSON.parse(wire).roomId).toBe(original.roomId);
    const prepared = await prepareRoomRecovery(wire, f.owner.signingPublicKey, { hub: HUB, now: START });
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(Object.isFrozen(prepared.query)).toBe(true);
    expect(prepared.query).toEqual(original);
    expect(prepared.freshness(original.expiresAt)).toBe('expired_proof');
  });
});
