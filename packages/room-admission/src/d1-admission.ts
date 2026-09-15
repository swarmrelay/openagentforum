/** Internal opt-in D1 admission lab. No public endpoint or production migration. */
import type { D1Database } from '@cloudflare/workers-types';
import { canonicalizeJson } from '@openagentforum/protocol';
import { prepareRoomControl, ROOM_CONTROL_PROTOCOL, type RoomState, type RoomControlError } from './control.js';
import { policySnapshot, recoveryReceipt } from './storage-contract.js';
import { ROOM_LAB_SCHEMA } from './storage-schema.js';
import { D1RoomReceiptReader } from './d1-recovery.js';
import { D1RoomStateReader } from './d1-state-read.js';
import { D1RoomOperationScope } from './d1-scope.js';
import type { AdmissionPolicy, AdmissionResult, AdmissionError } from './storage-types.js';

// SQLite samples 'now' per sqlite3_step, not once in the calling JS request.
const DB_NOW = "CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER)";
const GATE_TABLE = `CREATE TABLE IF NOT EXISTS room_lab_d1_gate (
  id INTEGER PRIMARY KEY CHECK(id = 1), at_ms INTEGER NOT NULL, mode TEXT NOT NULL,
  expires_at INTEGER NOT NULL, invite_expires INTEGER, window_ms INTEGER NOT NULL,
  bucket INTEGER NOT NULL, rate_limited INTEGER NOT NULL CHECK(rate_limited IN (0, 1)),
  valid INTEGER NOT NULL DEFAULT 1 CHECK(valid = 1)
) STRICT`;
// This DELETE is the LAST batch statement. An expired guard aborts the ENTIRE
// batch, including receipts/quotas/state/clock. Driver errors remain uncertain
// to callers: never parse a thrown exception into a definitive absence claim.
const GATE_TRIGGER = `CREATE TRIGGER IF NOT EXISTS room_lab_d1_finish BEFORE DELETE ON room_lab_d1_gate
WHEN OLD.mode IN ('apply', 'replay') BEGIN
  SELECT CASE WHEN max(${DB_NOW}, OLD.at_ms, (SELECT clock FROM room_lab_meta WHERE id = 1)) >= OLD.expires_at
    THEN RAISE(ABORT, 'room proof expired at commit guard') END;
  SELECT CASE WHEN OLD.mode = 'apply' AND OLD.invite_expires IS NOT NULL
    AND max(${DB_NOW}, OLD.at_ms, (SELECT clock FROM room_lab_meta WHERE id = 1)) >= OLD.invite_expires
    THEN RAISE(ABORT, 'room invitation expired at commit guard') END;
  SELECT CASE WHEN OLD.mode = 'apply' AND OLD.rate_limited = 1
    AND CAST(max(${DB_NOW}, OLD.at_ms, (SELECT clock FROM room_lab_meta WHERE id = 1)) / OLD.window_ms AS INTEGER) != OLD.bucket
    THEN RAISE(ABORT, 'room accounting window changed') END;
  UPDATE room_lab_meta SET clock = max(clock, OLD.at_ms, ${DB_NOW}) WHERE id = 1;
END`;

type Options = { hub: string; policy: AdmissionPolicy; now: () => number };
function validateOptions(options: Options) {
  const url = new URL(options.hub);
  if (url.protocol !== 'https:' || url.origin !== options.hub || options.hub.length > 256
      || typeof options.now !== 'function') throw new Error('Invalid admission configuration');
  return policySnapshot(options.policy);
}
function metadata(value: unknown, hub: string, policy: string): Record<string, unknown> & { clock: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing metadata');
  const row = value as Record<string, unknown>;
  if (row.schema_version !== 1 || row.hub !== hub || row.protocol !== ROOM_CONTROL_PROTOCOL || row.policy !== policy
      || typeof row.clock !== 'number' || !Number.isSafeInteger(row.clock) || row.clock < 0) throw new Error('Invalid metadata');
  return { ...row, clock: row.clock };
}

/** Explicit laboratory setup only; caller supplies a dedicated disposable/test D1 binding. */
export async function initializeD1RoomAdmission(db: D1Database, options: Options): Promise<void> {
  const policy = canonicalizeJson(validateOptions(options));
  const session = db.withSession('first-primary');
  try {
    await session.batch([
      ...ROOM_LAB_SCHEMA.split(';').map(s => s.trim()).filter(Boolean).map(sql => session.prepare(sql)),
      session.prepare(GATE_TABLE), session.prepare(GATE_TRIGGER),
      session.prepare('INSERT OR IGNORE INTO room_lab_meta VALUES (1, 1, ?, ?, ?, 0)')
        .bind(options.hub, ROOM_CONTROL_PROTOCOL, policy),
    ]);
    metadata(await db.withSession('first-primary').prepare('SELECT * FROM room_lab_meta WHERE id = 1').first(), options.hub, policy);
  } catch { throw new Error('D1 admission initialization failed'); }
}

const SQL_ERRORS: readonly AdmissionError[] = ['storage_error', 'expired_proof', 'future_proof',
  'request_conflict', 'revision_conflict', 'invitation_expired', 'room_capacity', 'active_room_limit',
  'member_room_limit', 'pending_invite_limit', 'receipt_capacity', 'create_rate_limited', 'invite_rate_limited'];
function isDenial(value: unknown, proposedError: RoomControlError | null): value is AdmissionError {
  return typeof value === 'string' && (value === proposedError || SQL_ERRORS.some(code => code === value));
}

/** Request-lifetime object; never keep in Worker globals or accept client-prepared state. */
export class D1RoomAdmissionStore {
  readonly #db: D1Database;
  readonly #hub: string;
  readonly #policy: Readonly<AdmissionPolicy>;
  readonly #policyJson: string;
  readonly #now: () => number;
  readonly #scope: D1RoomOperationScope;
  readonly #reader: D1RoomReceiptReader;
  readonly #stateReader: D1RoomStateReader;

  constructor(db: D1Database, options: Options) {
    this.#policy = validateOptions(options);
    this.#policyJson = canonicalizeJson(this.#policy);
    this.#hub = options.hub;
    this.#now = options.now;
    this.#db = db;
    this.#scope = new D1RoomOperationScope(this.#policy.maxInFlightPerConnection);
    this.#reader = new D1RoomReceiptReader(db, { ...options, policy: this.#policy, scope: this.#scope });
    this.#stateReader = new D1RoomStateReader(db, { ...options, policy: this.#policy, scope: this.#scope });
  }
  #time(floor: number) {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid clock');
    return Math.max(floor, now);
  }
  recover(wire: string, signingKey: string) { return this.#reader.recover(wire, signingKey); }
  readState(wire: string, signingKey: string) { return this.#stateReader.readState(wire, signingKey); }

  async submit(wire: string, signingKey: string): Promise<AdmissionResult> {
    const denied = this.#scope.enter();
    if (denied) return { ok: false, reason: denied };
    try {
      const initial = metadata(await this.#db.withSession('first-primary')
        .prepare('SELECT * FROM room_lab_meta WHERE id = 1').first(), this.#hub, this.#policyJson);
      if (this.#scope.broken) return { ok: false, reason: 'storage_error' };
      const prepared = await prepareRoomControl(wire, signingKey, { hub: this.#hub, now: this.#time(initial.clock) });
      if (this.#scope.broken) return { ok: false, reason: 'storage_error' };
      if (!prepared.ok) return prepared;
      const action = prepared.action;
      const snapshot = metadata(await this.#db.withSession('first-primary').prepare(`SELECT m.*, r.state_json
        FROM room_lab_meta m LEFT JOIN room_lab_rooms r ON r.room_id = ? WHERE m.id = 1`)
        .bind(action.roomId).first(), this.#hub, this.#policyJson);
      if (this.#scope.broken) return { ok: false, reason: 'storage_error' };
      if (snapshot.clock < initial.clock || (snapshot.state_json !== null && typeof snapshot.state_json !== 'string')) {
        throw new Error('Invalid snapshot');
      }
      const now = this.#time(snapshot.clock);
      const stale = prepared.freshness(now);
      if (stale) return { ok: false, reason: stale };
      const current = snapshot.state_json === null ? null : JSON.parse(snapshot.state_json as string) as RoomState;
      const proposal = prepared.evaluate(current, now);
      const next = proposal.ok ? proposal.state : null;
      const proposedError = proposal.ok ? null : proposal.reason;
      const inviteExpires = action.action === 'invite' ? action.payload.inviteExpiresAt
        : action.action === 'accept' && proposal.ok ? current!.invitation!.expiresAt : null;
      const p = this.#policy;
      const kind = action.action === 'create' || action.action === 'invite' ? action.action : null;
      const openDelta = action.action === 'create' ? 1 : action.action === 'close' ? -1 : 0;
      const session = this.#db.withSession('first-primary');
      // Numbered bindings are allocated here, never interpolated from signed input.
      const args: (string | number | null)[] = [];
      const arg = (value: string | number | null) => { args.push(value); return `?${args.length}`; };
      const actor = arg(action.actor), request = arg(action.requestId), key = arg(signingKey), digest = arg(prepared.proofDigest);
      const room = arg(action.roomId), expected = arg(snapshot.state_json as string | null);
      const stage = `WITH timing AS (SELECT *, max(${DB_NOW}, clock, ${arg(now)}) AS at_ms FROM room_lab_meta WHERE id = 1)
        INSERT INTO room_lab_d1_gate (id, at_ms, mode, expires_at, invite_expires, window_ms, bucket, rate_limited)
        SELECT 1, m.at_ms, CASE
          WHEN m.schema_version != 1 OR m.hub != ${arg(this.#hub)} OR m.protocol != ${arg(ROOM_CONTROL_PROTOCOL)}
            OR m.policy != ${arg(this.#policyJson)} OR m.clock < ${arg(snapshot.clock)} THEN 'storage_error'
          WHEN NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'room_lab_d1_finish'
            AND sql = ${arg(GATE_TRIGGER.replace(' IF NOT EXISTS', ''))}) THEN 'storage_error'
          WHEN m.at_ms >= ${arg(action.expiresAt)} THEN 'expired_proof'
          WHEN ${arg(action.issuedAt)} > m.at_ms + 30000 THEN 'future_proof'
          WHEN old.request_id IS NOT NULL THEN CASE WHEN old.signing_key = ${key} AND old.digest = ${digest}
            THEN 'replay' ELSE 'request_conflict' END
          WHEN ${arg(proposedError)} IS NOT NULL THEN ${arg(proposedError)}
          WHEN NOT ((SELECT state_json FROM room_lab_rooms WHERE room_id = ${room}) IS ${expected}) THEN 'revision_conflict'
          WHEN ${arg(inviteExpires)} IS NOT NULL AND m.at_ms >= ${arg(inviteExpires)} THEN 'invitation_expired'
          WHEN ${arg(action.action)} = 'create' AND (SELECT count(*) FROM room_lab_rooms) >= ${arg(p.maxRetainedRooms)} THEN 'room_capacity'
          WHEN ${arg(action.action)} = 'create' AND (SELECT count(*) FROM room_lab_rooms WHERE status = 'open') >= ${arg(p.maxActiveRooms)} THEN 'active_room_limit'
          WHEN ${arg(action.action)} IN ('create', 'accept') AND (SELECT count(*) FROM room_lab_rooms
            WHERE status = 'open' AND (owner_id = ${actor} OR peer_id = ${actor})) >= ${arg(p.maxActiveRoomsPerAgent)} THEN 'member_room_limit'
          WHEN ${arg(action.action)} = 'invite' AND (SELECT count(*) FROM room_lab_rooms WHERE status = 'open'
            AND invite_recipient = ${arg(action.action === 'invite' ? action.payload.recipient : null)}
            AND invite_expires > m.at_ms AND room_id != ${room}) >= ${arg(p.maxPendingInvitesPerRecipient)} THEN 'pending_invite_limit'
          WHEN (SELECT count(*) FROM room_lab_receipts) + 1 + (SELECT count(*) FROM room_lab_rooms WHERE status = 'open')
            + ${arg(openDelta)} > ${arg(p.maxReceipts)} THEN 'receipt_capacity'
          ${kind ? `WHEN coalesce((SELECT count FROM room_lab_budgets WHERE scope = 'hub' AND kind = ${arg(kind)}
            AND bucket = CAST(m.at_ms / ${arg(p.windowMs)} AS INTEGER)), 0) >= ${arg(kind === 'create' ? p.createsPerHub : p.invitesPerHub)} THEN '${kind}_rate_limited'
          WHEN coalesce((SELECT count FROM room_lab_budgets WHERE scope = ${actor} AND kind = ${arg(kind)}
            AND bucket = CAST(m.at_ms / ${arg(p.windowMs)} AS INTEGER)), 0) >= ${arg(kind === 'create' ? p.createsPerAgent : p.invitesPerAgent)} THEN '${kind}_rate_limited'` : ''}
          ELSE 'apply' END, ${arg(action.expiresAt)}, ${arg(inviteExpires)}, ${arg(p.windowMs)},
          CAST(m.at_ms / ${arg(p.windowMs)} AS INTEGER), ${arg(kind ? 1 : 0)}
        FROM timing m LEFT JOIN room_lab_receipts old ON old.actor = ${actor} AND old.request_id = ${request}`;
      const statements = [session.prepare(stage).bind(...args),
        session.prepare("UPDATE room_lab_meta SET clock = (SELECT at_ms FROM room_lab_d1_gate) WHERE id = 1 AND EXISTS (SELECT 1 FROM room_lab_d1_gate WHERE mode != 'storage_error')"),
        session.prepare("DELETE FROM room_lab_budgets WHERE bucket < (SELECT bucket FROM room_lab_d1_gate WHERE mode != 'storage_error')")];
      const apply = "EXISTS (SELECT 1 FROM room_lab_d1_gate WHERE mode = 'apply')";
      if (next) {
        const stateJson = canonicalizeJson(next);
        if (action.action === 'create') statements.push(session.prepare(`INSERT INTO room_lab_rooms
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${apply}`).bind(next.roomId, next.revision, next.status,
          next.owner.agentId, next.peer?.agentId ?? null, next.invitation?.recipient ?? null,
          next.invitation?.expiresAt ?? null, stateJson));
        else statements.push(session.prepare(`UPDATE room_lab_rooms SET revision = ?, status = ?, peer_id = ?,
          invite_recipient = ?, invite_expires = ?, state_json = ? WHERE room_id = ? AND state_json = ? AND ${apply}`)
          .bind(next.revision, next.status, next.peer?.agentId ?? null, next.invitation?.recipient ?? null,
            next.invitation?.expiresAt ?? null, stateJson, next.roomId, snapshot.state_json));
        if (kind) for (const scope of ['hub', action.actor]) statements.push(session.prepare(`INSERT INTO room_lab_budgets
          SELECT ?, ?, bucket, 1 FROM room_lab_d1_gate WHERE mode = 'apply'
          ON CONFLICT(scope, kind, bucket) DO UPDATE SET count = count + 1`).bind(scope, kind));
        const receipt = canonicalizeJson({ protocol: ROOM_CONTROL_PROTOCOL, hub: this.#hub, roomId: action.roomId,
          actor: action.actor, requestId: action.requestId, action: action.action, proofDigest: prepared.proofDigest,
          revision: next.revision, status: next.status, committedAt: 0 });
        statements.push(session.prepare(`INSERT INTO room_lab_receipts SELECT ?, ?, ?, ?, json_set(?, '$.committedAt', at_ms)
          FROM room_lab_d1_gate WHERE mode = 'apply'`).bind(action.actor, action.requestId, signingKey, prepared.proofDigest, receipt));
        // A silently skipped state/receipt write must not become a successful commit.
        statements.push(session.prepare(`UPDATE room_lab_d1_gate SET valid = CASE WHEN mode != 'apply' OR
          (EXISTS (SELECT 1 FROM room_lab_rooms WHERE room_id = ? AND state_json = ?)
          AND EXISTS (SELECT 1 FROM room_lab_receipts WHERE actor = ? AND request_id = ? AND signing_key = ? AND digest = ?))
          THEN 1 ELSE 0 END`).bind(next.roomId, stateJson, action.actor, action.requestId, signingKey, prepared.proofDigest));
      }
      const resultIndex = statements.length;
      statements.push(session.prepare(`SELECT g.mode, r.receipt_json FROM room_lab_d1_gate g LEFT JOIN room_lab_receipts r
        ON r.actor = ? AND r.request_id = ? AND r.signing_key = ? AND r.digest = ?`).bind(action.actor, action.requestId, signingKey, prepared.proofDigest));
      statements.push(session.prepare('DELETE FROM room_lab_d1_gate')); // MUST remain last (commit-time trigger).
      const results = await session.batch(statements);
      if (this.#scope.broken) return { ok: false, reason: 'storage_error' };
      if (results.length !== statements.length || results.some(r => !r.success)) throw new Error('Invalid batch response');
      const rows = results[resultIndex].results;
      if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') throw new Error('Missing batch result');
      const row = rows[0] as Record<string, unknown>;
      if (row.mode === 'apply' || row.mode === 'replay') {
        const receipt = recoveryReceipt(row.receipt_json, { ...action, proofDigest: prepared.proofDigest });
        if (!receipt) throw new Error('Invalid receipt binding');
        // A delayed acknowledgment is history, NOT a fresh admission credential.
        return { ok: true, replayed: row.mode === 'replay', receipt };
      }
      if (!isDenial(row.mode, proposedError)) throw new Error('Invalid decision');
      if (row.mode === 'storage_error') this.#scope.poison();
      return { ok: false, reason: row.mode };
    } catch {
      this.#scope.poison();
      return { ok: false, reason: 'storage_error' };
    } finally { this.#scope.leave(); }
  }
}
