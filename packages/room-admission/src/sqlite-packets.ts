/**
 * Synchronous internals of RoomAdmissionStore, NEVER a standalone admission API.
 * All operations require the enclosing store's primary transaction and raw-proof
 * verification. No connection, transaction, clock or listener is owned here.
 */
import type { DatabaseSync } from 'node:sqlite';
import { canonicalizeJson } from '@openagentforum/protocol';
import type { RoomState } from './control.js';
import { ROOM_STATE_PROTOCOL, roomStateView } from './state-read.js';
import {
  ROOM_PACKET_LIMITS, ROOM_PACKET_PROTOCOL,
  type PreparedRoomPacket, type RoomPacketWrite, type RoomPacketRead, type RoomPacketRecovery,
} from './packet-wire.js';
import {
  packetByteLength, packetPolicySnapshot, packetReceipt, ROOM_PACKET_STORAGE_LIMITS,
  type RoomPacketPolicy, type RoomPacketReceipt, type RoomPacketWriteSuccess,
  type RoomPacketReadSuccess, type RoomPacketRecoverySuccess, type RoomPacketTransaction,
} from './packet-storage-contract.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS room_lab_packet_meta (
  id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL,
  hub TEXT NOT NULL, protocol TEXT NOT NULL, policy TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS room_lab_packet_sessions (
  room_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
  owner_key TEXT NOT NULL, peer_key TEXT NOT NULL, created_at INTEGER NOT NULL,
  stage INTEGER NOT NULL CHECK(stage BETWEEN 1 AND 4),
  owner_next INTEGER NOT NULL CHECK(owner_next BETWEEN 1 AND 1026),
  peer_next INTEGER NOT NULL CHECK(peer_next BETWEEN 0 AND 1026),
  PRIMARY KEY(room_id, session_id)
) STRICT;
CREATE TABLE IF NOT EXISTS room_lab_packets (
  room_id TEXT NOT NULL, stored_seq INTEGER NOT NULL CHECK(stored_seq > 0),
  signing_key TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL,
  session_id TEXT NOT NULL, packet_index INTEGER NOT NULL,
  wire TEXT NOT NULL CHECK(length(CAST(wire AS BLOB)) <= 36864),
  receipt_json TEXT NOT NULL CHECK(length(CAST(receipt_json AS BLOB)) <= 2048),
  PRIMARY KEY(room_id, stored_seq), UNIQUE(signing_key, request_id),
  UNIQUE(room_id, session_id, signing_key, packet_index)
) STRICT;
CREATE TABLE IF NOT EXISTS room_lab_packet_usage (
  scope TEXT PRIMARY KEY, packets INTEGER NOT NULL CHECK(packets >= 0),
  bytes INTEGER NOT NULL CHECK(bytes >= 0), sessions INTEGER NOT NULL CHECK(sessions >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS room_lab_packet_windows (
  scope TEXT NOT NULL, bucket INTEGER NOT NULL,
  packets INTEGER NOT NULL CHECK(packets >= 0), bytes INTEGER NOT NULL CHECK(bytes >= 0),
  sessions INTEGER NOT NULL CHECK(sessions >= 0), PRIMARY KEY(scope, bucket)
) STRICT;
CREATE INDEX IF NOT EXISTS room_lab_packet_window_bucket ON room_lab_packet_windows(bucket);
`;
type Session = { room_id: string; session_id: string; revision: number; owner_key: string; peer_key: string;
  created_at: number; stage: number; owner_next: number; peer_next: number };
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
    db.exec(SCHEMA);
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
    const raw = row?.state_json ?? null;
    // Reuse the shared canonical full-key membership validator on THIS primary snapshot.
    const view = roomStateView(raw, { ...request, protocol: ROOM_STATE_PROTOCOL, queryId: '0'.repeat(32) }, request.signingPublicKey);
    if (!view || view.status !== 'open' || view.revision !== request.expectedRevision) return null;
    const room = JSON.parse(raw as string) as RoomState; // Already validated, bounded and canonical above.
    return room.peer ? { room, role: view.role } : null;
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
  #session(request: Readonly<RoomPacketWrite>, room: RoomState, now: number): Session | null {
    const s = this.db.prepare('SELECT * FROM room_lab_packet_sessions WHERE room_id = ? AND session_id = ?')
      .get(request.roomId, request.sessionId) as Session | undefined;
    if (!s) return null;
    if (s.revision !== room.revision || s.owner_key !== room.owner.signingPublicKey || s.peer_key !== room.peer!.signingPublicKey
        || !Number.isSafeInteger(s.created_at) || s.created_at < 0 || s.created_at > now
        || !Number.isSafeInteger(s.stage) || s.stage < 1 || s.stage > 4
        || !Number.isSafeInteger(s.owner_next) || s.owner_next < 1 || s.owner_next > 1026
        || !Number.isSafeInteger(s.peer_next) || s.peer_next < 0 || s.peer_next > 1026
        || (s.stage === 1 && (s.owner_next !== 1 || s.peer_next !== 0))
        || (s.stage === 2 && (s.owner_next !== 1 || s.peer_next !== 1))
        || (s.stage === 3 && (s.owner_next !== 2 || s.peer_next !== 1))
        || (s.stage === 4 && (s.owner_next < 2 || s.peer_next < 2))) throw new Error('Invalid packet session');
    return s;
  }

  write(prepared: PreparedRoomPacket<RoomPacketWrite>, wire: string, now: number): RoomPacketTransaction<RoomPacketWriteSuccess> {
    const r = prepared.request;
    const prior = this.#receipt({ ...r, proofDigest: prepared.proofDigest });
    if (prior.found) return { result: prior.receipt ? { ok: true, replayed: true, receipt: prior.receipt } : unavailable() };
    const membership = this.#room(r);
    if (!membership) return { result: unavailable() };
    const { room, role } = membership;
    const old = this.#session(r, room, now);
    const s: Session = old ? { ...old } : { room_id: r.roomId, session_id: r.sessionId, revision: room.revision,
      owner_key: room.owner.signingPublicKey, peer_key: room.peer!.signingPublicKey,
      created_at: now, stage: 1, owner_next: 1, peer_next: 0 };
    const lifetime = old?.stage === 4 ? ROOM_PACKET_STORAGE_LIMITS.sessionLifetimeMs : ROOM_PACKET_STORAGE_LIMITS.handshakeLifetimeMs;
    if (s.created_at > Number.MAX_SAFE_INTEGER - ROOM_PACKET_STORAGE_LIMITS.sessionLifetimeMs) return { result: unavailable() };
    const validUntil = s.created_at + lifetime;
    if (now >= validUntil) return { result: unavailable() };
    if (!old) {
      if (role !== 'owner' || r.kind !== 'handshake' || r.packetIndex !== 0 || r.packetHex.length !== 192) return { result: unavailable() };
    } else if (s.stage < 4) {
      const expectedRole = s.stage === 2 ? 'owner' : 'peer';
      if (role !== expectedRole || r.packetIndex !== (s.stage === 1 ? 0 : 1)
          || r.kind !== (s.stage === 1 ? 'handshake' : 'confirmation')
          || r.packetHex.length !== (s.stage === 1 ? 96 : 34)) return { result: unavailable() };
      s.stage++;
      if (role === 'owner') s.owner_next++; else s.peer_next++;
    } else {
      if (r.kind !== 'data' || r.packetIndex !== (role === 'owner' ? s.owner_next : s.peer_next)) return { result: unavailable() };
      if (role === 'owner') s.owner_next++; else s.peer_next++;
    }
    const last = this.db.prepare('SELECT stored_seq FROM room_lab_packets WHERE room_id = ? ORDER BY stored_seq DESC LIMIT 1')
      .get(r.roomId)?.stored_seq ?? 0;
    if (typeof last !== 'number' || !Number.isSafeInteger(last) || last < 0 || last >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid packet cursor');
    const receipt: RoomPacketReceipt = { protocol: ROOM_PACKET_PROTOCOL, hub: this.hub, roomId: r.roomId,
      actor: r.actor, signingPublicKey: r.signingPublicKey, requestId: r.requestId, proofDigest: prepared.proofDigest,
      revision: r.expectedRevision, sessionId: r.sessionId, packetIndex: r.packetIndex, storedSeq: last + 1, committedAt: now };
    const receiptJson = canonicalizeJson(receipt);
    if (packetByteLength(receiptJson) > ROOM_PACKET_STORAGE_LIMITS.receiptBytes) throw new Error('Oversized packet receipt');
    const bytes = packetByteLength(wire) + packetByteLength(receiptJson);
    const sessions = old ? 0 : 1;
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
