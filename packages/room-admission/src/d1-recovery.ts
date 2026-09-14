/** Internal D1 signed-receipt read laboratory. No admission writer or HTTP entrypoint. */
import type { D1Database } from '@cloudflare/workers-types';
import { canonicalizeJson } from '@openagentforum/protocol';
import { ROOM_CONTROL_PROTOCOL } from './control.js';
import { prepareRoomRecovery } from './recovery.js';
import { policySnapshot, recoveryReceipt } from './storage-contract.js';
import type { AdmissionPolicy, RecoveryResult } from './storage-types.js';
import { D1RoomOperationScope } from './d1-scope.js';

// Each statement is the FIRST and ONLY query of its own first-primary session.
// Do not reuse a session: subsequent reads may be routed to replicas.
const META = 'SELECT schema_version, hub, protocol, policy, clock FROM room_lab_meta WHERE id = 1';
const SNAPSHOT = `SELECT m.schema_version, m.hub, m.protocol, m.policy, m.clock, r.receipt_json
  FROM room_lab_meta AS m LEFT JOIN room_lab_receipts AS r
    ON r.actor = ? AND r.request_id = ? AND r.signing_key = ? AND r.digest = ?
  WHERE m.id = 1`;

/** Caller-owned, bounded lifetime instance. Never store it or request state in Worker globals. */
export class D1RoomReceiptReader {
  readonly #db: Pick<D1Database, 'withSession'>;
  readonly #hub: string;
  readonly #policy: Readonly<AdmissionPolicy>;
  readonly #policyJson: string;
  readonly #now: () => number;
  readonly #scope: D1RoomOperationScope;

  constructor(db: Pick<D1Database, 'withSession'>,
    options: { hub: string; policy: AdmissionPolicy; now: () => number; scope?: D1RoomOperationScope }) {
    const url = new URL(options.hub);
    if (url.protocol !== 'https:' || url.origin !== options.hub || options.hub.length > 256
        || typeof options.now !== 'function') throw new Error('Invalid recovery configuration');
    this.#db = db;
    this.#hub = options.hub;
    this.#policy = policySnapshot(options.policy);
    this.#policyJson = canonicalizeJson(this.#policy);
    this.#now = options.now;
    this.#scope = options.scope ?? new D1RoomOperationScope(this.#policy.maxInFlightPerConnection);
    if (this.#scope.limit !== this.#policy.maxInFlightPerConnection) throw new Error('Mismatched operation limit');
  }

  #clock(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid clock');
    return now;
  }

  #metadata(raw: unknown): { clock: number; receipt_json?: unknown } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Missing metadata');
    const row = raw as Record<string, unknown>;
    if (row.schema_version !== 1 || row.hub !== this.#hub || row.protocol !== ROOM_CONTROL_PROTOCOL
        || row.policy !== this.#policyJson || typeof row.clock !== 'number'
        || !Number.isSafeInteger(row.clock) || row.clock < 0) throw new Error('Invalid metadata');
    return { clock: row.clock, ...(Object.hasOwn(row, 'receipt_json') ? { receipt_json: row.receipt_json } : {}) };
  }

  /** No caller-provided verified object, snapshot, bookmark or signing shortcut. */
  async recover(wire: string, signingPublicKey: string): Promise<RecoveryResult> {
    const denied = this.#scope.enter();
    if (denied) return { ok: false, reason: denied };
    try {
      // Match SQLite's committed high-water behavior before signature freshness checks.
      // This bounded metadata read does not look up a receipt or enumerate room state.
      const initial = this.#metadata(await this.#db.withSession('first-primary').prepare(META).first());
      if (this.#scope.broken) return { ok: false, reason: 'storage_error' };
      const startedAt = Math.max(this.#clock(), initial.clock);
      const prepared = await prepareRoomRecovery(wire, signingPublicKey, { hub: this.#hub, now: startedAt });
      if (this.#scope.broken) return { ok: false, reason: 'storage_error' };
      if (!prepared.ok) return prepared;
      const beforeRead = Math.max(startedAt, this.#clock());
      const stale = prepared.freshness(beforeRead);
      if (stale) return { ok: false, reason: stale };
      const q = prepared.query;
      // One SQL statement establishes ONE snapshot for metadata and receipt. A sequence
      // of awaited SELECTs (even on the primary) would not establish this boundary.
      const snapshot = this.#metadata(await this.#db.withSession('first-primary').prepare(SNAPSHOT)
        .bind(q.actor, q.requestId, signingPublicKey, q.proofDigest).first());
      if (this.#scope.broken) return { ok: false, reason: 'storage_error' };
      if (snapshot.clock < initial.clock || !Object.hasOwn(snapshot, 'receipt_json')) {
        throw new Error('Invalid snapshot');
      }
      const observedAt = Math.max(beforeRead, this.#clock(), snapshot.clock);
      const expired = prepared.freshness(observedAt);
      if (expired) return { ok: false, reason: expired };
      const receipt = snapshot.receipt_json === null ? null : recoveryReceipt(snapshot.receipt_json, q);
      const finalExpiry = prepared.freshness(Math.max(observedAt, this.#clock()));
      if (finalExpiry) return { ok: false, reason: finalExpiry };
      return { ok: true, queryId: q.queryId, observedAt, receipt };
    } catch {
      // Never return driver messages, retry automatically or turn uncertainty into absence.
      this.#scope.poison();
      return { ok: false, reason: 'storage_error' };
    } finally { this.#scope.leave(); }
  }
}
