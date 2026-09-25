/** Internal, opt-in SQLite laboratory. No public route or listener. */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { canonicalizeJson } from '@openagentforum/protocol';
import { assertSqliteWalRuntime } from './sqlite-runtime.js';
import {
  prepareRoomControl, ROOM_CONTROL_PROTOCOL,
  type PreparedRoomControl, type RoomControlError, type RoomState,
} from './control.js';
import { prepareRoomRecovery, type RoomRecoveryQuery } from './recovery.js';
import { prepareRoomStateRead, roomStateView, type RoomStateReadResult } from './state-read.js';
import { policySnapshot, recoveryReceipt } from './storage-contract.js';
import { ROOM_LAB_SCHEMA } from './storage-schema.js';
import type { AdmissionPolicy, AdmissionReceipt, AdmissionError, AdmissionResult, RecoveryResult } from './storage-types.js';
import { SQLiteRoomPacketStorage, type StoredPacketBinding } from './sqlite-packets.js';
import {
  prepareRoomPacket, prepareRoomPacketRead, prepareRoomPacketRecovery, verifyHistoricalRoomPacketSignature,
  type PreparedRoomPacket, type RoomPacketWrite, type RoomPacketRead, type RoomPacketRecovery,
  type RoomPacketProofError,
} from './packet-wire.js';
import type {
  RoomPacketPolicy, RoomPacketFailure, RoomPacketTransaction, RoomPacketWriteSuccess,
  RoomPacketReadSuccess, RoomPacketRecoverySuccess, RoomPacketWriteResult, RoomPacketReadResult, RoomPacketRecoveryResult,
} from './packet-storage-contract.js';
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
  readonly #packets?: SQLiteRoomPacketStorage;
  #inFlight = 0;
  #broken = false;

  constructor(db: DatabaseSync, options: { hub: string; policy: AdmissionPolicy; now: () => number; packets?: RoomPacketPolicy }) {
    // Caller owns this connection; reject before journal/schema/authority mutation.
    assertSqliteWalRuntime(db);
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
      if (options.packets !== undefined) this.#packets = new SQLiteRoomPacketStorage(db, this.#hub, options.packets);
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
      if (this.#broken) return fail('storage_error');
      if (!prepared.ok) return prepared;
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

  /** Opt-in only. Always accept raw wire; never accept a prepared proof or membership snapshot. */
  writePacket(wire: string): Promise<RoomPacketWriteResult> {
    return this.#packetOperation<RoomPacketWrite, RoomPacketWriteSuccess>(wire, prepareRoomPacket, true,
      (prepared, now) => this.#packets!.write(prepared, wire, now));
  }

  readPackets(wire: string): Promise<RoomPacketReadResult> {
    let keys: string[] = [];
    let bindings: StoredPacketBinding[] = [];
    return this.#packetOperation<RoomPacketRead, RoomPacketReadSuccess>(wire, prepareRoomPacketRead, false,
      (prepared, now) => {
        const snapshot = this.#packets!.read(prepared.request, now);
        keys = snapshot.signingKeys; bindings = snapshot.bindings;
        return { result: snapshot.result };
      }, async (result, query) => {
        // Verify the bounded stored page AFTER ending the snapshot: no await in SQL.
        // Membership came from that protected snapshot, never from these old signatures.
        for (const [i, record] of (result.page?.records ?? []).entries()) {
          const p = await verifyHistoricalRoomPacketSignature(record.wire, this.#hub);
          const b = bindings[i];
          if (!p.ok || p.request.roomId !== query.roomId || p.request.expectedRevision !== query.expectedRevision
              || !keys.includes(p.request.signingPublicKey) || p.request.signingPublicKey !== b.signing_key
              || p.request.requestId !== b.request_id || p.proofDigest !== b.digest
              || p.request.sessionId !== b.session_id || p.request.packetIndex !== b.packet_index) {
            throw new Error('Invalid stored packet signature or binding');
          }
        }
      });
  }

  recoverPacket(wire: string): Promise<RoomPacketRecoveryResult> {
    return this.#packetOperation<RoomPacketRecovery, RoomPacketRecoverySuccess>(wire, prepareRoomPacketRecovery, false,
      (prepared, now) => ({ result: this.#packets!.recover(prepared.request, now) }));
  }

  async #packetOperation<T extends RoomPacketWrite | RoomPacketRead | RoomPacketRecovery, R extends { ok: true }>(
    wire: string,
    prepare: (wire: string, context: { hub: string; now: number }) => Promise<PreparedRoomPacket<T> | { ok: false; reason: RoomPacketProofError }>,
    mutation: boolean, operation: (proof: PreparedRoomPacket<T>, now: number) => RoomPacketTransaction<R>,
    finish?: (result: R, query: Readonly<T>) => Promise<void>,
  ): Promise<R | RoomPacketFailure> {
    const failure = (reason: RoomPacketFailure['reason']): RoomPacketFailure => ({ ok: false, reason });
    if (this.#broken) return failure('storage_error');
    if (!this.#packets) return failure('not_configured');
    if (this.#inFlight >= this.#policy.maxInFlightPerConnection) return failure('busy');
    this.#inFlight++;
    let begun = false;
    try {
      const initial = this.#meta();
      this.#packets.checkConfiguration();
      const startedAt = this.#time(initial);
      const prepared = await prepare(wire, { hub: this.#hub, now: startedAt });
      if (this.#broken) return failure('storage_error');
      if (!prepared.ok) return prepared;
      this.#db.exec(mutation ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true;
      const meta = this.#meta();
      this.#packets.checkConfiguration();
      if (meta.clock < initial.clock) throw new Error('Clock regression');
      const now = Math.max(startedAt, this.#time(meta));
      const stale = prepared.freshness(now);
      if (stale) {
        this.#db.exec('ROLLBACK'); begun = false;
        return failure(stale);
      }
      const { result, validUntil } = operation(prepared, now);
      if (!result.ok) {
        this.#db.exec('ROLLBACK'); begun = false;
        return result;
      }
      const commitNow = Math.max(now, this.#time(meta));
      const expired = prepared.freshness(commitNow);
      const lateSession = validUntil !== undefined && commitNow >= validUntil;
      const newWrite = mutation && 'replayed' in result && result.replayed === false;
      const changedWindow = newWrite && Math.floor(commitNow / this.#packets.policy.windowMs) !== Math.floor(now / this.#packets.policy.windowMs);
      if (expired || lateSession || changedWindow) {
        this.#db.exec('ROLLBACK'); begun = false;
        return failure(expired ?? (lateSession ? 'unavailable' : 'clock_changed'));
      }
      if (mutation) this.#db.prepare('UPDATE room_lab_meta SET clock = ? WHERE id = 1').run(commitNow);
      this.#db.exec('COMMIT'); begun = false;
      if (finish) await finish(result, prepared.request);
      if (this.#broken) return failure('storage_error');
      const finalMeta = this.#meta();
      if (finalMeta.clock < (mutation ? commitNow : meta.clock)) throw new Error('Clock regression');
      const finalExpiry = prepared.freshness(Math.max(commitNow, this.#time(finalMeta)));
      if (finalExpiry) {
        // A write may ALREADY be durable. Do not signal a definitive rejected mutation.
        if (mutation) throw new Error('Packet outcome requires reconciliation');
        return failure(finalExpiry);
      }
      return result;
    } catch {
      if (begun) { try { this.#db.exec('ROLLBACK'); } catch { /* never infer absence */ } }
      this.#broken = true;
      return failure('storage_error');
    } finally { this.#inFlight--; }
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
      if (this.#broken) return fail('storage_error');
      if (!prepared.ok) return prepared;
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

  /** Minimal member-only state read. This result never authorizes a later message operation. */
  async readState(wire: string, signingKey: string): Promise<RoomStateReadResult> {
    const fail = (reason: RoomControlError | 'storage_error' | 'busy'): RoomStateReadResult => ({ ok: false, reason });
    if (this.#broken) return fail('storage_error');
    if (this.#inFlight >= this.#policy.maxInFlightPerConnection) return fail('busy');
    this.#inFlight++;
    let begun = false;
    try {
      const initial = this.#meta();
      const startedAt = this.#time(initial);
      const prepared = await prepareRoomStateRead(wire, signingKey, { hub: this.#hub, now: startedAt });
      if (this.#broken) return fail('storage_error');
      if (!prepared.ok) return prepared;
      // No await inside this read transaction. Metadata, membership and status share its snapshot.
      this.#db.exec('BEGIN');
      begun = true;
      const meta = this.#meta();
      if (meta.clock < initial.clock) throw new Error('Clock regression');
      const observedAt = Math.max(startedAt, this.#time(meta));
      const stale = prepared.freshness(observedAt);
      if (stale) {
        this.#db.exec('ROLLBACK'); begun = false;
        return fail(stale);
      }
      const row = this.#db.prepare('SELECT state_json FROM room_lab_rooms WHERE room_id = ?')
        .get(prepared.query.roomId);
      const room = roomStateView(row ? row.state_json : null, prepared.query, signingKey);
      const expired = prepared.freshness(Math.max(observedAt, this.#time(meta)));
      if (expired) {
        this.#db.exec('ROLLBACK'); begun = false;
        return fail(expired);
      }
      this.#db.exec('COMMIT'); begun = false;
      const finalExpiry = prepared.freshness(Math.max(observedAt, this.#time(meta)));
      if (finalExpiry) return fail(finalExpiry);
      return { ok: true, queryId: prepared.query.queryId, observedAt, room };
    } catch {
      if (begun) { try { this.#db.exec('ROLLBACK'); } catch { /* never infer absence */ } }
      this.#broken = true;
      return fail('storage_error');
    } finally { this.#inFlight--; }
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
