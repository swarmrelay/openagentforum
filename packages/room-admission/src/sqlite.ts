/** Internal, opt-in SQLite laboratory. No public route, listener or data-plane authorization. */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { canonicalizeJson } from '@openagentforum/protocol';
import {
  prepareRoomControl, ROOM_CONTROL_PROTOCOL,
  type PreparedRoomControl, type RoomControlError, type RoomState,
} from './control.js';
import { prepareRoomRecovery, type RoomRecoveryQuery } from './recovery.js';
import { policySnapshot, recoveryReceipt } from './storage-contract.js';
import { ROOM_LAB_SCHEMA } from './storage-schema.js';
import type { AdmissionPolicy, AdmissionReceipt, AdmissionError, AdmissionResult, RecoveryResult } from './storage-types.js';
export type { AdmissionPolicy, AdmissionReceipt, AdmissionError, AdmissionResult, RecoveryResult } from './storage-types.js';
export { ROOM_LAB_SCHEMA } from './storage-schema.js';

const SCHEMA_VERSION = 1;
type Meta = { schema_version: number; hub: string; protocol: string; policy: string; clock: number };
const fail = (reason: AdmissionError): AdmissionResult => ({ ok: false, reason });

/**
 * Own a dedicated connection for this instance. Caller opens/closes the database
 * in a protected local directory; never share the connection with other writers.
 * Separate instances/processes MUST open the same primary database, not replicas.
 */
export class RoomAdmissionStore {
  readonly #db: DatabaseSync;
  readonly #hub: string;
  readonly #policy: Readonly<AdmissionPolicy>;
  readonly #policyJson: string;
  readonly #now: () => number;
  #inFlight = 0;
  #broken = false;

  constructor(db: DatabaseSync, options: { hub: string; policy: AdmissionPolicy; now: () => number }) {
    const url = new URL(options.hub);
    if (url.protocol !== 'https:' || url.origin !== options.hub || options.hub.length > 256
        || typeof options.now !== 'function') throw new Error('Invalid admission configuration');
    this.#db = db;
    this.#hub = options.hub;
    this.#policy = policySnapshot(options.policy);
    this.#policyJson = canonicalizeJson(this.#policy);
    this.#now = options.now;
    let begun = false;
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000;');
      db.exec('BEGIN IMMEDIATE');
      begun = true;
      db.exec(ROOM_LAB_SCHEMA);
      db.prepare(`INSERT OR IGNORE INTO room_lab_meta VALUES (1, ?, ?, ?, ?, 0)`)
        .run(SCHEMA_VERSION, this.#hub, ROOM_CONTROL_PROTOCOL, this.#policyJson);
      this.#meta();
      db.exec('COMMIT');
    } catch {
      if (begun) { try { db.exec('ROLLBACK'); } catch { /* already rolled back or committed */ } }
      throw new Error('Admission initialization failed: unavailable storage or configuration mismatch');
    }
  }

  #meta(): Meta {
    const meta = this.#db.prepare('SELECT * FROM room_lab_meta WHERE id = 1').get() as Meta | undefined;
    if (!meta || meta.schema_version !== SCHEMA_VERSION || meta.hub !== this.#hub
        || meta.protocol !== ROOM_CONTROL_PROTOCOL || meta.policy !== this.#policyJson
        || !Number.isSafeInteger(meta.clock) || meta.clock < 0) throw new Error('Invalid admission metadata');
    return meta;
  }

  #time(meta: Meta): number {
    const time = this.#now();
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid admission clock');
    return Math.max(time, meta.clock);
  }

  /** Only raw signed wire is admitted. There is no caller-supplied verified/state fast path. */
  async submit(wire: string, signingPublicKey: string): Promise<AdmissionResult> {
    if (this.#broken) return fail('storage_error');
    if (this.#inFlight >= this.#policy.maxInFlightPerConnection) return fail('busy');
    this.#inFlight += 1;
    let begun = false;
    try {
      const prepared = await prepareRoomControl(wire, signingPublicKey, {
        hub: this.#hub, now: this.#time(this.#meta()),
      });
      if (!prepared.ok) return prepared;
      if (this.#broken) return fail('storage_error');
      // Never await inside this transaction. BEGIN IMMEDIATE serializes independent
      // connections before reading authoritative state, receipts and shared budgets.
      this.#db.exec('BEGIN IMMEDIATE');
      begun = true;
      const now = this.#time(this.#meta());
      this.#db.prepare('UPDATE room_lab_meta SET clock = ? WHERE id = 1').run(now);
      const bucket = Math.floor(now / this.#policy.windowMs);
      this.#db.prepare('DELETE FROM room_lab_budgets WHERE bucket < ?').run(bucket);
      const guard: { invitationExpiresAt: number | null } = { invitationExpiresAt: null };
      const result = this.#admit(prepared, signingPublicKey, now, bucket, guard);
      if (result.ok) {
        // SQLite work and disk I/O take time even with no await. Recheck immediately
        // before COMMIT and roll back the entire mutation if it aged out meanwhile.
        const commitNow = this.#time(this.#meta());
        const stale = prepared.freshness(commitNow)
          ?? (guard.invitationExpiresAt !== null && commitNow >= guard.invitationExpiresAt ? 'invitation_expired' : null);
        const changedWindow = !result.replayed && (prepared.action.action === 'create' || prepared.action.action === 'invite')
          && Math.floor(commitNow / this.#policy.windowMs) !== bucket;
        if (stale || changedWindow) {
          this.#db.exec('ROLLBACK');
          begun = false;
          return fail(stale ?? 'clock_changed');
        }
        this.#db.prepare('UPDATE room_lab_meta SET clock = ? WHERE id = 1').run(commitNow);
      }
      this.#db.exec('COMMIT');
      begun = false;
      return result;
    } catch {
      if (begun) { try { this.#db.exec('ROLLBACK'); } catch { /* commit outcome may be uncertain */ } }
      // Do not echo database paths/SQL/errors, assume a failed commit was absent,
      // or keep using a potentially ambiguous connection. Reopen and retry exact wire.
      this.#broken = true;
      return fail('storage_error');
    } finally { this.#inFlight -= 1; }
  }

  #count(sql: string, ...args: SQLInputValue[]): number {
    return (this.#db.prepare(sql).get(...args) as { count: number }).count;
  }

  /** Bounded primary snapshot read. No receipt, room, quota or clock writes. */
  async recover(wire: string, signingPublicKey: string): Promise<RecoveryResult> {
    const fail = (reason: RoomControlError | 'storage_error' | 'busy'): RecoveryResult => ({ ok: false, reason });
    if (this.#broken) return fail('storage_error');
    if (this.#inFlight >= this.#policy.maxInFlightPerConnection) return fail('busy');
    this.#inFlight += 1;
    let begun = false;
    try {
      const prepared = await prepareRoomRecovery(wire, signingPublicKey, {
        hub: this.#hub, now: this.#time(this.#meta()),
      });
      if (!prepared.ok) return prepared;
      if (this.#broken) return fail('storage_error');
      // No await inside the read transaction. Metadata establishes the snapshot;
      // another connection's uncommitted or later writes are not recovery results.
      this.#db.exec('BEGIN');
      begun = true;
      const meta = this.#meta();
      const observedAt = this.#time(meta);
      const stale = prepared.freshness(observedAt);
      if (stale) {
        this.#db.exec('ROLLBACK');
        begun = false;
        return fail(stale);
      }
      const receipt = this.#recoverReceipt(prepared.query, signingPublicKey);
      const expired = prepared.freshness(Math.max(observedAt, this.#time(meta)));
      if (expired) {
        this.#db.exec('ROLLBACK');
        begun = false;
        return fail(expired);
      }
      this.#db.exec('COMMIT');
      begun = false;
      return { ok: true, queryId: prepared.query.queryId, observedAt, receipt };
    } catch {
      if (begun) { try { this.#db.exec('ROLLBACK'); } catch { /* connection may be uncertain */ } }
      this.#broken = true;
      return fail('storage_error');
    } finally { this.#inFlight -= 1; }
  }

  #recoverReceipt(query: Readonly<RoomRecoveryQuery>, signingKey: string): AdmissionReceipt | null {
    const row = this.#db.prepare(`SELECT receipt_json FROM room_lab_receipts
      WHERE actor = ? AND request_id = ? AND signing_key = ? AND digest = ?`)
      .get(query.actor, query.requestId, signingKey, query.proofDigest) as { receipt_json: string } | undefined;
    if (!row) return null;
    return recoveryReceipt(row.receipt_json, query);
  }

  #memberships(agent: string): number {
    return this.#count(`SELECT count(*) AS count FROM room_lab_rooms
      WHERE status = 'open' AND (owner_id = ? OR peer_id = ?)`, agent, agent);
  }

  #admit(prepared: PreparedRoomControl, signingKey: string, now: number, bucket: number,
    guard: { invitationExpiresAt: number | null }): AdmissionResult {
    const stale = prepared.freshness(now);
    if (stale) return fail(stale);
    const { action, proofDigest } = prepared;
    const previous = this.#db.prepare(`SELECT signing_key, digest, receipt_json FROM room_lab_receipts
      WHERE actor = ? AND request_id = ?`).get(action.actor, action.requestId) as
      { signing_key: string; digest: string; receipt_json: string } | undefined;
    if (previous) {
      if (previous.signing_key !== signingKey || previous.digest !== proofDigest) return fail('request_conflict');
      return { ok: true, replayed: true, receipt: JSON.parse(previous.receipt_json) as AdmissionReceipt };
    }
    const row = this.#db.prepare('SELECT state_json FROM room_lab_rooms WHERE room_id = ?')
      .get(action.roomId) as { state_json: string } | undefined;
    const current = row ? JSON.parse(row.state_json) as RoomState : null;
    const proposal = prepared.evaluate(current, now);
    if (!proposal.ok) return proposal;
    if (action.action === 'invite') guard.invitationExpiresAt = action.payload.inviteExpiresAt;
    if (action.action === 'accept') guard.invitationExpiresAt = current!.invitation!.expiresAt;
    const next = proposal.state;
    const policy = this.#policy;
    const openRooms = this.#count("SELECT count(*) AS count FROM room_lab_rooms WHERE status = 'open'");
    if (action.action === 'create') {
      if (this.#count('SELECT count(*) AS count FROM room_lab_rooms') >= policy.maxRetainedRooms) return fail('room_capacity');
      if (openRooms >= policy.maxActiveRooms) return fail('active_room_limit');
    }
    if ((action.action === 'create' || action.action === 'accept')
        && this.#memberships(action.actor) >= policy.maxActiveRoomsPerAgent) return fail('member_room_limit');
    if (action.action === 'invite' && this.#count(`SELECT count(*) AS count FROM room_lab_rooms
        WHERE status = 'open' AND invite_recipient = ? AND invite_expires > ? AND room_id != ?`,
      action.payload.recipient, now, action.roomId) >= policy.maxPendingInvitesPerRecipient) return fail('pending_invite_limit');

    // Reserve one future close receipt for EVERY open room. Close consumes a slot
    // but releases its reservation, so unrelated admission saturation cannot lock it out.
    const openAfter = openRooms + (action.action === 'create' ? 1 : action.action === 'close' ? -1 : 0);
    if (this.#count('SELECT count(*) AS count FROM room_lab_receipts') + 1 + openAfter > policy.maxReceipts) {
      return fail('receipt_capacity');
    }
    const rateKind = action.action === 'create' || action.action === 'invite' ? action.action : null;
    const scopes = rateKind ? [
      ['hub', rateKind === 'create' ? policy.createsPerHub : policy.invitesPerHub],
      [action.actor, rateKind === 'create' ? policy.createsPerAgent : policy.invitesPerAgent],
    ] as const : [];
    for (const [scope, limit] of scopes) {
      const budget = this.#db.prepare('SELECT count FROM room_lab_budgets WHERE scope = ? AND kind = ? AND bucket = ?')
        .get(scope, rateKind!, bucket) as { count: number } | undefined;
      if ((budget?.count ?? 0) >= limit) return fail(rateKind === 'create' ? 'create_rate_limited' : 'invite_rate_limited');
    }
    if (action.action === 'create') {
      this.#db.prepare(`INSERT INTO room_lab_rooms
        (room_id, revision, status, owner_id, peer_id, invite_recipient, invite_expires, state_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(next.roomId, next.revision, next.status, next.owner.agentId,
        next.peer?.agentId ?? null, next.invitation?.recipient ?? null, next.invitation?.expiresAt ?? null,
        canonicalizeJson(next));
    } else {
      const update = this.#db.prepare(`UPDATE room_lab_rooms SET revision = ?, status = ?, peer_id = ?,
        invite_recipient = ?, invite_expires = ?, state_json = ? WHERE room_id = ? AND revision = ? AND status = 'open'`)
        .run(next.revision, next.status, next.peer?.agentId ?? null, next.invitation?.recipient ?? null,
          next.invitation?.expiresAt ?? null, canonicalizeJson(next), next.roomId, action.expectedRevision);
      if (Number(update.changes) !== 1) throw new Error('Admission CAS failed');
    }
    for (const [scope] of scopes) {
      this.#db.prepare(`INSERT INTO room_lab_budgets VALUES (?, ?, ?, 1)
        ON CONFLICT(scope, kind, bucket) DO UPDATE SET count = count + 1`).run(scope, rateKind!, bucket);
    }
    const receipt: AdmissionReceipt = {
      protocol: ROOM_CONTROL_PROTOCOL, hub: this.#hub, roomId: action.roomId, actor: action.actor,
      requestId: action.requestId, action: action.action, proofDigest,
      revision: next.revision, status: next.status, committedAt: now,
    };
    this.#db.prepare('INSERT INTO room_lab_receipts VALUES (?, ?, ?, ?, ?)')
      .run(action.actor, action.requestId, signingKey, proofDigest, canonicalizeJson(receipt));
    return { ok: true, replayed: false, receipt };
  }
}
