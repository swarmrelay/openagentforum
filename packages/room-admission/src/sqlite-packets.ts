/**
 * Synchronous internals of RoomAdmissionStore, NEVER a standalone admission API.
 * All operations require the enclosing store's primary transaction and raw-proof
 * verification. No connection, transaction, clock or listener is owned here.
 */
import type { DatabaseSync } from 'node:sqlite';
import { canonicalizeJson } from '@openagentforum/protocol';
import type { RoomState } from './control.js';
import {
  ROOM_PACKET_LIMITS, ROOM_PACKET_PROTOCOL,
  type PreparedRoomPacket, type RoomPacketWrite, type RoomPacketRead, type RoomPacketRecovery,
} from './packet-wire.js';
import {
  packetByteLength, packetPolicySnapshot, packetReceipt, ROOM_PACKET_STORAGE_LIMITS,
  type RoomPacketPolicy, type RoomPacketReceipt, type RoomPacketWriteSuccess,
  type RoomPacketReadSuccess, type RoomPacketRecoverySuccess, type RoomPacketTransaction,
} from './packet-storage-contract.js';

import { ROOM_PACKET_SCHEMA } from './packet-schema.js';
import { packetMembership, packetSessionProposal } from './packet-state.js';
type Usage = { packets: number; bytes: number; sessions: number };
export type StoredPacketBinding = { signing_key: string; request_id: string; digest: string; session_id: string; packet_index: number };
const unavailable = (): { ok: false; reason: 'unavailable' } => ({ ok: false, reason: 'unavailable' });

export class SQLiteRoomPacketStorage {
  readonly policy: Readonly<RoomPacketPolicy>;
  readonly #policyJson: string;
  constructor(readonly db: DatabaseSync, readonly hub: string, policy: RoomPacketPolicy) {
    this.policy = packetPolicySnapshot(policy);
    this.#policyJson = canonicalizeJson(this.policy);
    // Called only in the enclosing store's initialization transaction, when opted in.
    const installed = db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN
      ('room_lab_packet_meta', 'room_lab_packet_sessions', 'room_lab_packets', 'room_lab_packet_usage', 'room_lab_packet_windows')`).all();
    if (installed.length !== 0 && installed.length !== 5) throw new Error('Incomplete packet schema');
    db.exec(ROOM_PACKET_SCHEMA);
    db.prepare('INSERT OR IGNORE INTO room_lab_packet_meta VALUES (1, 1, ?, ?, ?)')
      .run(hub, ROOM_PACKET_PROTOCOL, this.#policyJson);
    this.checkConfiguration();
  }
  checkConfiguration(): void {
    const meta = this.db.prepare('SELECT * FROM room_lab_packet_meta WHERE id = 1').get();
    if (!meta || meta.schema_version !== 1 || meta.hub !== this.hub || meta.protocol !== ROOM_PACKET_PROTOCOL
        || meta.policy !== this.#policyJson) throw new Error('Invalid packet configuration');
  }

  #room(request: Readonly<RoomPacketWrite | RoomPacketRead>): { room: RoomState; role: 'owner' | 'peer' } | null {
    const row = this.db.prepare('SELECT state_json FROM room_lab_rooms WHERE room_id = ?').get(request.roomId);
    return packetMembership(row?.state_json ?? null, request);
  }
  #receipt(query: Pick<RoomPacketRecovery, 'hub' | 'roomId' | 'actor' | 'signingPublicKey' | 'requestId' | 'proofDigest'>) {
    const row = this.db.prepare(`SELECT digest, receipt_json FROM room_lab_packets WHERE signing_key = ? AND request_id = ?`)
      .get(query.signingPublicKey, query.requestId);
    if (!row) return { found: false, receipt: null };
    return { found: true, receipt: row.digest === query.proofDigest ? packetReceipt(row.receipt_json, query) : null };
  }
  #usage(table: 'room_lab_packet_usage' | 'room_lab_packet_windows', scope: string, bucket?: number): Usage {
    const row = bucket === undefined
      ? this.db.prepare(`SELECT packets, bytes, sessions FROM ${table} WHERE scope = ?`).get(scope)
      : this.db.prepare(`SELECT packets, bytes, sessions FROM ${table} WHERE scope = ? AND bucket = ?`).get(scope, bucket);
    if (!row) return { packets: 0, bytes: 0, sessions: 0 };
    for (const name of ['packets', 'bytes', 'sessions']) {
      if (typeof row[name] !== 'number' || !Number.isSafeInteger(row[name]) || row[name] < 0) throw new Error('Invalid packet accounting');
    }
    return row as Usage;
  }

  write(prepared: PreparedRoomPacket<RoomPacketWrite>, wire: string, now: number): RoomPacketTransaction<RoomPacketWriteSuccess> {
    const r = prepared.request;
    const prior = this.#receipt({ ...r, proofDigest: prepared.proofDigest });
    if (prior.found) return { result: prior.receipt ? { ok: true, replayed: true, receipt: prior.receipt } : unavailable() };
    const rawRoom = this.db.prepare('SELECT state_json FROM room_lab_rooms WHERE room_id = ?').get(r.roomId)?.state_json ?? null;
    const rawSession = this.db.prepare('SELECT * FROM room_lab_packet_sessions WHERE room_id = ? AND session_id = ?').get(r.roomId, r.sessionId);
    const proposal = packetSessionProposal(r, rawRoom, rawSession ? canonicalizeJson(rawSession) : null, now);
    if (!proposal) return { result: unavailable() };
    const { next: s, validUntil, newSession } = proposal;
    const last = this.db.prepare('SELECT stored_seq FROM room_lab_packets WHERE room_id = ? ORDER BY stored_seq DESC LIMIT 1')
      .get(r.roomId)?.stored_seq ?? 0;
    if (typeof last !== 'number' || !Number.isSafeInteger(last) || last < 0 || last >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid packet cursor');
    const receipt: RoomPacketReceipt = { protocol: ROOM_PACKET_PROTOCOL, hub: this.hub, roomId: r.roomId,
      actor: r.actor, signingPublicKey: r.signingPublicKey, requestId: r.requestId, proofDigest: prepared.proofDigest,
      revision: r.expectedRevision, sessionId: r.sessionId, packetIndex: r.packetIndex, storedSeq: last + 1, committedAt: now };
    const receiptJson = canonicalizeJson(receipt);
    if (packetByteLength(receiptJson) > ROOM_PACKET_STORAGE_LIMITS.receiptBytes) throw new Error('Oversized packet receipt');
    const bytes = packetByteLength(wire) + packetByteLength(receiptJson);
    const sessions = newSession ? 1 : 0;
    const bucket = Math.floor(now / this.policy.windowMs);
    const scopes = [['hub', this.policy.hub], [`room:${r.roomId}`, this.policy.room],
      [`key:${r.signingPublicKey}`, this.policy.agent]] as const;
    for (const [scope, limits] of scopes) {
      const used = this.#usage('room_lab_packet_usage', scope);
      const window = this.#usage('room_lab_packet_windows', scope, bucket);
      if (used.packets + 1 > limits.packets || used.bytes + bytes > limits.bytes || used.sessions + sessions > limits.sessions
          || window.packets + 1 > limits.packetsPerWindow || window.bytes + bytes > limits.bytesPerWindow
          || window.sessions + sessions > limits.sessionsPerWindow) return { result: unavailable() };
    }
    // These writes are committed together with the exact wire, receipt, cursor and high-water.
    this.db.prepare('DELETE FROM room_lab_packet_windows WHERE bucket < ?').run(bucket);
    this.db.prepare(`INSERT INTO room_lab_packet_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, session_id) DO UPDATE SET stage = excluded.stage, owner_next = excluded.owner_next, peer_next = excluded.peer_next`)
      .run(s.room_id, s.session_id, s.revision, s.owner_key, s.peer_key, s.created_at, s.stage, s.owner_next, s.peer_next);
    this.db.prepare('INSERT INTO room_lab_packets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.roomId, last + 1, r.signingPublicKey, r.requestId, prepared.proofDigest, r.sessionId, r.packetIndex, wire, receiptJson);
    for (const [scope] of scopes) {
      this.db.prepare(`INSERT INTO room_lab_packet_usage VALUES (?, 1, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET packets = packets + 1, bytes = bytes + excluded.bytes, sessions = sessions + excluded.sessions`)
        .run(scope, bytes, sessions);
      this.db.prepare(`INSERT INTO room_lab_packet_windows VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(scope, bucket) DO UPDATE SET packets = packets + 1, bytes = bytes + excluded.bytes, sessions = sessions + excluded.sessions`)
        .run(scope, bucket, bytes, sessions);
    }
    return { result: { ok: true, replayed: false, receipt }, validUntil };
  }

  read(query: Readonly<RoomPacketRead>, now: number): { result: RoomPacketReadSuccess; signingKeys: string[]; bindings: StoredPacketBinding[] } {
    const result: RoomPacketReadSuccess = { ok: true, queryId: query.queryId, observedAt: now, page: null };
    const bindings: StoredPacketBinding[] = [];
    const membership = this.#room(query);
    if (!membership) return { result, signingKeys: [], bindings };
    const rows = this.db.prepare(`SELECT stored_seq, wire, signing_key, request_id, digest, session_id, packet_index FROM room_lab_packets
      WHERE room_id = ? AND stored_seq > ? ORDER BY stored_seq LIMIT ?`)
      .all(query.roomId, query.afterStoredSeq, query.limit);
    result.page = { records: [], nextStoredSeq: null };
    let previous = query.afterStoredSeq;
    for (const row of rows) {
      if (typeof row.stored_seq !== 'number' || !Number.isSafeInteger(row.stored_seq) || row.stored_seq <= previous
          || typeof row.wire !== 'string' || packetByteLength(row.wire) > ROOM_PACKET_LIMITS.wireBytes) throw new Error('Invalid stored packet');
      const next: RoomPacketReadSuccess = { ...result, page: { records: [...result.page.records, { storedSeq: row.stored_seq, wire: row.wire }],
        nextStoredSeq: row.stored_seq } };
      if (packetByteLength(canonicalizeJson(next)) > ROOM_PACKET_LIMITS.responseBytes) break;
      result.page = next.page!;
      bindings.push(row as unknown as StoredPacketBinding);
      previous = row.stored_seq;
    }
    return { result, bindings, signingKeys: [membership.room.owner.signingPublicKey, membership.room.peer!.signingPublicKey] };
  }
  recover(query: Readonly<RoomPacketRecovery>, now: number): RoomPacketRecoverySuccess {
    return { ok: true, queryId: query.queryId, observedAt: now, receipt: this.#receipt(query).receipt };
  }
}
