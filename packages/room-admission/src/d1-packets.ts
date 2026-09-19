/** Internal D1 packet machinery owned by D1RoomAdmissionStore, not a public adapter. */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { canonicalizeJson } from '@openagentforum/protocol';
import { ROOM_CONTROL_PROTOCOL } from './control.js';
import { policySnapshot } from './storage-contract.js';
import type { AdmissionPolicy } from './storage-types.js';
import { D1RoomOperationScope } from './d1-scope.js';
import { ROOM_PACKET_SCHEMA } from './packet-schema.js';
import { packetMembership, packetSessionProposal } from './packet-state.js';
import {
  ROOM_PACKET_PROTOCOL, ROOM_PACKET_LIMITS, prepareRoomPacket, prepareRoomPacketRead,
  prepareRoomPacketRecovery, verifyHistoricalRoomPacketSignature,
  type PreparedRoomPacket, type RoomPacketWrite, type RoomPacketRead, type RoomPacketRecovery, type RoomPacketProofError,
} from './packet-wire.js';
import {
  packetPolicySnapshot, packetByteLength, packetReceipt, ROOM_PACKET_STORAGE_LIMITS,
  type RoomPacketPolicy, type RoomPacketFailure, type RoomPacketReceipt,
  type RoomPacketWriteResult, type RoomPacketReadResult, type RoomPacketReadSuccess, type RoomPacketRecoveryResult,
} from './packet-storage-contract.js';

type Options = { hub: string; policy: AdmissionPolicy; packets: RoomPacketPolicy; now: () => number };
const DB_NOW = "CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER)";
const META = `m.*, p.schema_version AS packet_schema, p.hub AS packet_hub, p.protocol AS packet_protocol, p.policy AS packet_policy`;
const FROM_META = 'FROM room_lab_meta m LEFT JOIN room_lab_packet_meta p ON p.id = 1';
const SESSION_JSON = `CASE WHEN s.session_id IS NULL THEN NULL ELSE json_object(
  'created_at', s.created_at, 'owner_key', s.owner_key, 'owner_next', s.owner_next,
  'peer_key', s.peer_key, 'peer_next', s.peer_next, 'revision', s.revision,
  'room_id', s.room_id, 'session_id', s.session_id, 'stage', s.stage) END`;
const GATE_TABLE = `CREATE TABLE IF NOT EXISTS room_lab_d1_packet_gate (
  id INTEGER PRIMARY KEY CHECK(id = 1), mode TEXT NOT NULL, at_ms INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, session_expires INTEGER, window_ms INTEGER NOT NULL, bucket INTEGER NOT NULL,
  stored_seq INTEGER NOT NULL, receipt_json TEXT NOT NULL, bytes INTEGER NOT NULL, new_session INTEGER NOT NULL,
  valid INTEGER NOT NULL DEFAULT 1 CHECK(valid = 1)
) STRICT`;
const GATE_TRIGGER = `CREATE TRIGGER IF NOT EXISTS room_lab_d1_packet_finish BEFORE DELETE ON room_lab_d1_packet_gate
WHEN OLD.mode IN ('apply', 'replay') BEGIN
  SELECT CASE WHEN max(${DB_NOW}, OLD.at_ms, (SELECT clock FROM room_lab_meta WHERE id = 1)) >= OLD.expires_at
    THEN RAISE(ABORT, 'packet proof expired at commit guard') END;
  SELECT CASE WHEN OLD.mode = 'apply' AND (OLD.session_expires IS NULL OR
    max(${DB_NOW}, OLD.at_ms, (SELECT clock FROM room_lab_meta WHERE id = 1)) >= OLD.session_expires)
    THEN RAISE(ABORT, 'packet session expired at commit guard') END;
  SELECT CASE WHEN OLD.mode = 'apply' AND CAST(max(${DB_NOW}, OLD.at_ms,
    (SELECT clock FROM room_lab_meta WHERE id = 1)) / OLD.window_ms AS INTEGER) != OLD.bucket
    THEN RAISE(ABORT, 'packet accounting window changed') END;
  UPDATE room_lab_meta SET clock = max(clock, OLD.at_ms, ${DB_NOW}) WHERE id = 1;
END`;
const fail = (reason: RoomPacketFailure['reason']): RoomPacketFailure => ({ ok: false, reason });

/** Explicit lab initialization only. Constructor/import does no I/O; never call on a live binding. */
export async function initializeD1RoomPackets(db: D1Database, options: Options): Promise<void> {
  const policy = canonicalizeJson(packetPolicySnapshot(options.packets));
  try {
    const installed = await db.withSession('first-primary').prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'
      AND name IN ('room_lab_packet_meta', 'room_lab_packet_sessions', 'room_lab_packets', 'room_lab_packet_usage', 'room_lab_packet_windows')`).first();
    if (!installed || (installed.n !== 0 && installed.n !== 5)) throw new Error('Incomplete schema');
    const session = db.withSession('first-primary');
    await session.batch([...ROOM_PACKET_SCHEMA.split(';').map(s => s.trim()).filter(Boolean).map(sql => session.prepare(sql)),
      session.prepare(GATE_TABLE), session.prepare(GATE_TRIGGER),
      session.prepare('INSERT OR IGNORE INTO room_lab_packet_meta VALUES (1, 1, ?, ?, ?)').bind(options.hub, ROOM_PACKET_PROTOCOL, policy)]);
    const row = await db.withSession('first-primary').prepare('SELECT * FROM room_lab_packet_meta WHERE id = 1').first();
    if (!row || row.schema_version !== 1 || row.hub !== options.hub || row.protocol !== ROOM_PACKET_PROTOCOL || row.policy !== policy) {
      throw new Error('Invalid configuration');
    }
  } catch { throw new Error('D1 packet initialization failed'); }
}

/** Always shares the enclosing control store's scope. Do not expose prepared-proposal entrypoints. */
export class D1RoomPacketStorage {
  readonly #hub: string;
  readonly #policy: Readonly<RoomPacketPolicy>;
  readonly #policyJson: string;
  readonly #controlPolicy: string;
  readonly #now: () => number;
  constructor(readonly db: D1Database, options: Options, readonly scope: D1RoomOperationScope) {
    this.#hub = options.hub;
    this.#policy = packetPolicySnapshot(options.packets);
    this.#policyJson = canonicalizeJson(this.#policy);
    this.#controlPolicy = canonicalizeJson(policySnapshot(options.policy));
    this.#now = options.now;
  }
  #time(floor: number) {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid clock');
    return Math.max(now, floor);
  }
  #metadata(row: Record<string, unknown> | null): Record<string, unknown> & { clock: number } {
    if (!row || row.schema_version !== 1 || row.hub !== this.#hub || row.protocol !== ROOM_CONTROL_PROTOCOL
        || row.policy !== this.#controlPolicy || typeof row.clock !== 'number' || !Number.isSafeInteger(row.clock) || row.clock < 0
        || row.packet_schema !== 1 || row.packet_hub !== this.#hub || row.packet_protocol !== ROOM_PACKET_PROTOCOL
        || row.packet_policy !== this.#policyJson) throw new Error('Invalid packet metadata');
    return { ...row, clock: row.clock };
  }
  async #meta() {
    return this.#metadata(await this.db.withSession('first-primary').prepare(`SELECT ${META} ${FROM_META} WHERE m.id = 1`).first());
  }
  async #operation<T extends RoomPacketWrite | RoomPacketRead | RoomPacketRecovery, R>(wire: string,
    prepare: (wire: string, context: { hub: string; now: number }) => Promise<PreparedRoomPacket<T> | { ok: false; reason: RoomPacketProofError }>,
    run: (proof: PreparedRoomPacket<T>, now: number, floor: number) => Promise<R>) {
    const denied = this.scope.enter();
    if (denied) return fail(denied);
    try {
      const initial = await this.#meta();
      if (this.scope.broken) return fail('storage_error');
      const start = this.#time(initial.clock);
      const proof = await prepare(wire, { hub: this.#hub, now: start });
      if (this.scope.broken) return fail('storage_error');
      if (!proof.ok) return proof;
      const now = this.#time(start), stale = proof.freshness(now);
      if (stale) return fail(stale);
      return await run(proof, now, initial.clock);
    } catch {
      this.scope.poison();
      return fail('storage_error');
    } finally { this.scope.leave(); }
  }

  writePacket(wire: string): Promise<RoomPacketWriteResult> {
    return this.#operation(wire, prepareRoomPacket, async (proof, before, floor) => {
      const r = proof.request;
      const snapshot = this.#metadata(await this.db.withSession('first-primary').prepare(`SELECT ${META}, r.state_json,
        ${SESSION_JSON} AS session_json ${FROM_META}
        LEFT JOIN room_lab_rooms r ON r.room_id = ? LEFT JOIN room_lab_packet_sessions s ON s.room_id = ? AND s.session_id = ? WHERE m.id = 1`)
        .bind(r.roomId, r.roomId, r.sessionId).first());
      if (this.scope.broken) return fail('storage_error');
      if (snapshot.clock < floor) throw new Error('Clock regression');
      const now = this.#time(Math.max(before, snapshot.clock)), stale = proof.freshness(now);
      if (stale) return fail(stale);
      const proposal = packetSessionProposal(r, snapshot.state_json, snapshot.session_json, now);
      const args: (string | number | null)[] = [];
      const arg = (value: string | number | null) => { args.push(value); return `?${args.length}`; };
      const room = arg(r.roomId), sid = arg(r.sessionId), key = arg(r.signingPublicKey), request = arg(r.requestId), digest = arg(proof.proofDigest);
      const receipt: RoomPacketReceipt = { protocol: ROOM_PACKET_PROTOCOL, hub: this.#hub, roomId: r.roomId, actor: r.actor,
        signingPublicKey: r.signingPublicKey, requestId: r.requestId, proofDigest: proof.proofDigest,
        revision: r.expectedRevision, sessionId: r.sessionId, packetIndex: r.packetIndex, storedSeq: 0, committedAt: 0 };
      const p = this.#policy;
      const scopes = [['hub', p.hub], [`room:${r.roomId}`, p.room], [`key:${r.signingPublicKey}`, p.agent]] as const;
      const budgetChecks = scopes.map(([scope, limits]) => {
        const bound = arg(scope);
        return `WHEN EXISTS (SELECT 1 FROM (SELECT 1) LEFT JOIN room_lab_packet_usage u ON u.scope = ${bound}
          LEFT JOIN room_lab_packet_windows w ON w.scope = ${bound} AND w.bucket = c.bucket
          WHERE coalesce(u.packets, 0) + 1 > ${arg(limits.packets)} OR coalesce(u.bytes, 0) + c.bytes > ${arg(limits.bytes)}
          OR coalesce(u.sessions, 0) + c.new_session > ${arg(limits.sessions)}
          OR coalesce(w.packets, 0) + 1 > ${arg(limits.packetsPerWindow)} OR coalesce(w.bytes, 0) + c.bytes > ${arg(limits.bytesPerWindow)}
          OR coalesce(w.sessions, 0) + c.new_session > ${arg(limits.sessionsPerWindow)}) THEN 'unavailable'`;
      }).join('\n');
      const stage = `WITH timing AS (SELECT ${META}, max(${DB_NOW}, m.clock, ${arg(now)}) AS at_ms ${FROM_META} WHERE m.id = 1),
        positioned AS (SELECT *, coalesce((SELECT stored_seq FROM room_lab_packets WHERE room_id = ${room} ORDER BY stored_seq DESC LIMIT 1), 0) + 1 AS seq FROM timing),
        encoded AS (SELECT *, json_set(${arg(canonicalizeJson(receipt))}, '$.committedAt', at_ms, '$.storedSeq', seq) AS receipt,
          CAST(at_ms / ${arg(p.windowMs)} AS INTEGER) AS bucket, ${arg(proposal?.newSession ? 1 : 0)} AS new_session FROM positioned),
        charged AS (SELECT *, ${arg(packetByteLength(wire))} + length(CAST(receipt AS BLOB)) AS bytes FROM encoded)
        INSERT INTO room_lab_d1_packet_gate (id, mode, at_ms, expires_at, session_expires, window_ms, bucket, stored_seq, receipt_json, bytes, new_session)
        SELECT 1, CASE
          WHEN c.schema_version != 1 OR c.hub != ${arg(this.#hub)} OR c.protocol != ${arg(ROOM_CONTROL_PROTOCOL)}
            OR c.policy != ${arg(this.#controlPolicy)} OR c.clock < ${arg(snapshot.clock)}
            OR c.packet_schema IS NOT 1 OR c.packet_hub IS NOT ${arg(this.#hub)} OR c.packet_protocol IS NOT ${arg(ROOM_PACKET_PROTOCOL)}
            OR c.packet_policy IS NOT ${arg(this.#policyJson)} THEN 'storage_error'
          WHEN NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'room_lab_d1_packet_finish'
            AND sql = ${arg(GATE_TRIGGER.replace(' IF NOT EXISTS', ''))}) THEN 'storage_error'
          WHEN c.at_ms >= ${arg(r.expiresAt)} THEN 'expired_proof'
          WHEN ${arg(r.issuedAt)} > c.at_ms + 30000 THEN 'future_proof'
          WHEN old.request_id IS NOT NULL THEN CASE WHEN old.digest = ${digest} AND old.room_id = ${room} THEN 'replay' ELSE 'unavailable' END
          WHEN ${arg(proposal ? 1 : 0)} = 0 THEN 'unavailable'
          WHEN NOT ((SELECT state_json FROM room_lab_rooms WHERE room_id = ${room}) IS ${arg(snapshot.state_json as string | null)}) THEN 'unavailable'
          WHEN NOT ((SELECT ${SESSION_JSON} FROM room_lab_packet_sessions s WHERE s.room_id = ${room} AND s.session_id = ${sid})
            IS ${arg(snapshot.session_json as string | null)}) THEN 'unavailable'
          WHEN ${arg(proposal && !proposal.newSession ? proposal.validUntil : null)} <= c.at_ms THEN 'unavailable'
          WHEN c.seq < 1 OR c.seq > ${Number.MAX_SAFE_INTEGER}
            OR c.at_ms > ${Number.MAX_SAFE_INTEGER - ROOM_PACKET_STORAGE_LIMITS.sessionLifetimeMs}
            OR length(CAST(c.receipt AS BLOB)) > ${ROOM_PACKET_STORAGE_LIMITS.receiptBytes} THEN 'storage_error'
          ${budgetChecks}
          ELSE 'apply' END, c.at_ms, ${arg(r.expiresAt)},
          CASE WHEN c.new_session = 1 THEN c.at_ms + ${ROOM_PACKET_STORAGE_LIMITS.handshakeLifetimeMs} ELSE ${arg(proposal?.validUntil ?? null)} END,
          ${arg(p.windowMs)}, c.bucket, c.seq, c.receipt, c.bytes, c.new_session
        FROM charged c LEFT JOIN room_lab_packets old ON old.signing_key = ${key} AND old.request_id = ${request}`;
      const session = this.db.withSession('first-primary');
      const statements = [session.prepare(stage).bind(...args)];
      const requiredWrite = (statement: D1PreparedStatement) => {
        statements.push(statement, session.prepare("UPDATE room_lab_d1_packet_gate SET valid = CASE WHEN mode = 'apply' AND changes() != 1 THEN 0 ELSE 1 END"));
      };
      const apply = "EXISTS (SELECT 1 FROM room_lab_d1_packet_gate WHERE mode = 'apply')";
      if (proposal) {
        const s = proposal.next;
        requiredWrite(session.prepare(`INSERT INTO room_lab_packet_sessions
          SELECT ?, ?, ?, ?, ?, CASE WHEN new_session = 1 THEN at_ms ELSE ? END, ?, ?, ? FROM room_lab_d1_packet_gate WHERE mode = 'apply'
          ON CONFLICT(room_id, session_id) DO UPDATE SET stage = excluded.stage, owner_next = excluded.owner_next, peer_next = excluded.peer_next`)
          .bind(s.room_id, s.session_id, s.revision, s.owner_key, s.peer_key, s.created_at, s.stage, s.owner_next, s.peer_next));
        requiredWrite(session.prepare(`INSERT INTO room_lab_packets SELECT ?, stored_seq, ?, ?, ?, ?, ?, ?, receipt_json
          FROM room_lab_d1_packet_gate WHERE mode = 'apply'`).bind(r.roomId, r.signingPublicKey, r.requestId, proof.proofDigest, r.sessionId, r.packetIndex, wire));
        statements.push(session.prepare(`DELETE FROM room_lab_packet_windows WHERE bucket < (SELECT bucket FROM room_lab_d1_packet_gate WHERE mode = 'apply')`));
        for (const [scope] of scopes) {
          requiredWrite(session.prepare(`INSERT INTO room_lab_packet_usage SELECT ?, 1, bytes, new_session FROM room_lab_d1_packet_gate WHERE mode = 'apply'
            ON CONFLICT(scope) DO UPDATE SET packets = packets + 1, bytes = bytes + excluded.bytes, sessions = sessions + excluded.sessions`).bind(scope));
          requiredWrite(session.prepare(`INSERT INTO room_lab_packet_windows SELECT ?, bucket, 1, bytes, new_session FROM room_lab_d1_packet_gate WHERE mode = 'apply'
            ON CONFLICT(scope, bucket) DO UPDATE SET packets = packets + 1, bytes = bytes + excluded.bytes, sessions = sessions + excluded.sessions`).bind(scope));
        }
        // Guard against silently skipped writes before the transaction's final expiry guard.
        statements.push(session.prepare(`UPDATE room_lab_d1_packet_gate SET valid = CASE WHEN NOT ${apply} OR
          (EXISTS (SELECT 1 FROM room_lab_packets WHERE signing_key = ? AND request_id = ? AND digest = ? AND wire = ?
            AND stored_seq = room_lab_d1_packet_gate.stored_seq AND receipt_json = room_lab_d1_packet_gate.receipt_json)
          AND EXISTS (SELECT 1 FROM room_lab_packet_sessions WHERE room_id = ? AND session_id = ? AND stage = ? AND owner_next = ? AND peer_next = ?))
          THEN 1 ELSE 0 END`).bind(r.signingPublicKey, r.requestId, proof.proofDigest, wire, r.roomId, r.sessionId, s.stage, s.owner_next, s.peer_next));
      }
      const resultIndex = statements.length;
      statements.push(session.prepare(`SELECT g.mode, g.at_ms, old.receipt_json FROM room_lab_d1_packet_gate g LEFT JOIN room_lab_packets old
        ON old.signing_key = ? AND old.request_id = ? AND old.digest = ?`).bind(r.signingPublicKey, r.requestId, proof.proofDigest));
      statements.push(session.prepare('DELETE FROM room_lab_d1_packet_gate')); // MUST remain last: pinned commit guard.
      const results = await session.batch(statements);
      if (this.scope.broken) return fail('storage_error');
      if (results.length !== statements.length || results.some(value => !value.success)) throw new Error('Invalid batch result');
      const rows = results[resultIndex].results;
      if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') throw new Error('Missing packet result');
      const row = rows[0] as Record<string, unknown>;
      if (row.mode === 'apply' || row.mode === 'replay') {
        const acknowledged = packetReceipt(row.receipt_json, { ...r, proofDigest: proof.proofDigest });
        if (!acknowledged || typeof row.at_ms !== 'number' || acknowledged.revision !== r.expectedRevision
            || acknowledged.sessionId !== r.sessionId || acknowledged.packetIndex !== r.packetIndex) throw new Error('Invalid packet acknowledgment');
        const final = await this.#meta();
        if (final.clock < Math.max(snapshot.clock, row.at_ms) || this.scope.broken || proof.freshness(this.#time(Math.max(now, row.at_ms, final.clock)))) {
          throw new Error('Packet outcome requires reconciliation'); // May already be durable, never definitive rejection.
        }
        return { ok: true as const, replayed: row.mode === 'replay', receipt: acknowledged };
      }
      if (row.mode === 'unavailable' || row.mode === 'expired_proof' || row.mode === 'future_proof') return fail(row.mode);
      throw new Error('Invalid packet decision');
    });
  }

  readPackets(wire: string): Promise<RoomPacketReadResult> {
    return this.#operation(wire, prepareRoomPacketRead, async (proof, before, floor) => {
      const q = proof.request;
      // Configuration, primary membership and bounded indexed page are ONE SQL snapshot.
      // SQL narrows access before selecting bytes; the canonical full-key validator checks it again below.
      const snapshot = this.#metadata(await this.db.withSession('first-primary').prepare(`SELECT ${META}, r.state_json,
        (SELECT json_group_array(json_object('storedSeq', stored_seq, 'wire', wire, 'signing_key', signing_key,
          'request_id', request_id, 'digest', digest, 'session_id', session_id, 'packet_index', packet_index))
          FROM (SELECT stored_seq, wire, signing_key, request_id, digest, session_id, packet_index FROM room_lab_packets
            WHERE room_id = ?1 AND stored_seq > ?2
              AND json_extract(r.state_json, '$.status') = 'open' AND json_extract(r.state_json, '$.revision') = ?3
              AND json_type(r.state_json, '$.peer') = 'object'
              AND ((json_extract(r.state_json, '$.owner.agentId') = ?4 AND json_extract(r.state_json, '$.owner.signingPublicKey') = ?5)
                OR (json_extract(r.state_json, '$.peer.agentId') = ?4 AND json_extract(r.state_json, '$.peer.signingPublicKey') = ?5))
            ORDER BY stored_seq LIMIT ?6)) AS records_json
        ${FROM_META} LEFT JOIN room_lab_rooms r ON r.room_id = ?1 WHERE m.id = 1`)
        .bind(q.roomId, q.afterStoredSeq, q.expectedRevision, q.actor, q.signingPublicKey, q.limit).first());
      if (this.scope.broken) return fail('storage_error');
      if (snapshot.clock < floor) throw new Error('Clock regression');
      const observedAt = this.#time(Math.max(before, snapshot.clock)), stale = proof.freshness(observedAt);
      if (stale) return fail(stale);
      const membership = packetMembership(snapshot.state_json, q);
      const result: RoomPacketReadSuccess = { ok: true, queryId: q.queryId, observedAt, page: membership ? { records: [], nextStoredSeq: null } : null };
      if (membership) {
        if (typeof snapshot.records_json !== 'string' || packetByteLength(snapshot.records_json) > 350_000) throw new Error('Invalid packet page');
        const rows: unknown = JSON.parse(snapshot.records_json);
        if (!Array.isArray(rows) || rows.length > q.limit) throw new Error('Invalid packet count');
        let previous = q.afterStoredSeq;
        for (const value of rows) {
          if (!value || typeof value !== 'object') throw new Error('Invalid packet row');
          const row = value as Record<string, unknown>;
          if (typeof row.storedSeq !== 'number' || !Number.isSafeInteger(row.storedSeq) || row.storedSeq <= previous
              || typeof row.wire !== 'string' || packetByteLength(row.wire) > ROOM_PACKET_LIMITS.wireBytes) throw new Error('Invalid packet row');
          const next = { records: [...result.page!.records, { storedSeq: row.storedSeq, wire: row.wire }], nextStoredSeq: row.storedSeq };
          if (packetByteLength(canonicalizeJson({ ...result, page: next })) > ROOM_PACKET_LIMITS.responseBytes) break;
          const stored = await verifyHistoricalRoomPacketSignature(row.wire, this.#hub);
          if (this.scope.broken) return fail('storage_error');
          if (!stored.ok || stored.request.roomId !== q.roomId || stored.request.expectedRevision !== q.expectedRevision
              || ![membership.room.owner.signingPublicKey, membership.room.peer!.signingPublicKey].includes(stored.request.signingPublicKey)
              || stored.request.signingPublicKey !== row.signing_key || stored.request.requestId !== row.request_id
              || stored.proofDigest !== row.digest || stored.request.sessionId !== row.session_id || stored.request.packetIndex !== row.packet_index) {
            throw new Error('Invalid stored signature or binding');
          }
          result.page = next; previous = row.storedSeq;
        }
      }
      const final = await this.#meta();
      if (final.clock < snapshot.clock) throw new Error('Clock regression');
      if (this.scope.broken) return fail('storage_error');
      const expired = proof.freshness(this.#time(Math.max(observedAt, final.clock)));
      return expired ? fail(expired) : result;
    });
  }

  recoverPacket(wire: string): Promise<RoomPacketRecoveryResult> {
    return this.#operation(wire, prepareRoomPacketRecovery, async (proof, before, floor) => {
      const q = proof.request;
      const snapshot = this.#metadata(await this.db.withSession('first-primary').prepare(`SELECT ${META}, old.receipt_json
        ${FROM_META} LEFT JOIN room_lab_packets old ON old.signing_key = ? AND old.request_id = ? AND old.digest = ? WHERE m.id = 1`)
        .bind(q.signingPublicKey, q.requestId, q.proofDigest).first());
      if (this.scope.broken) return fail('storage_error');
      if (snapshot.clock < floor) throw new Error('Clock regression');
      const observedAt = this.#time(Math.max(before, snapshot.clock)), stale = proof.freshness(observedAt);
      if (stale) return fail(stale);
      const receipt = snapshot.receipt_json === null ? null : packetReceipt(snapshot.receipt_json, q);
      const expired = proof.freshness(this.#time(observedAt));
      return expired ? fail(expired) : { ok: true as const, queryId: q.queryId, observedAt, receipt };
    });
  }
}
