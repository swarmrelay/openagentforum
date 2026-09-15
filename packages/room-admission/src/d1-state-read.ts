/** Internal member-only status snapshots. No route, messages or reusable authorization. */
import type { D1Database } from '@cloudflare/workers-types';
import { canonicalizeJson } from '@openagentforum/protocol';
import { ROOM_CONTROL_PROTOCOL } from './control.js';
import { prepareRoomStateRead, roomStateView, type RoomStateReadResult } from './state-read.js';
import { policySnapshot } from './storage-contract.js';
import { D1RoomOperationScope } from './d1-scope.js';
import type { AdmissionPolicy } from './storage-types.js';

const META = 'SELECT schema_version, hub, protocol, policy, clock FROM room_lab_meta WHERE id = 1';
// Membership and status are taken from the SAME retained JSON in ONE primary SQL snapshot.
const SNAPSHOT = `SELECT m.schema_version, m.hub, m.protocol, m.policy, m.clock, r.state_json
  FROM room_lab_meta m LEFT JOIN room_lab_rooms r ON r.room_id = ? WHERE m.id = 1`;

export class D1RoomStateReader {
  readonly #db: Pick<D1Database, 'withSession'>;
  readonly #hub: string;
  readonly #policyJson: string;
  readonly #now: () => number;
  readonly #scope: D1RoomOperationScope;
  constructor(db: Pick<D1Database, 'withSession'>,
    options: { hub: string; policy: AdmissionPolicy; now: () => number; scope?: D1RoomOperationScope }) {
    const url = new URL(options.hub);
    if (url.protocol !== 'https:' || url.origin !== options.hub || options.hub.length > 256
        || typeof options.now !== 'function') throw new Error('Invalid state-read configuration');
    const policy = policySnapshot(options.policy);
    this.#db = db;
    this.#hub = options.hub;
    this.#policyJson = canonicalizeJson(policy);
    this.#now = options.now;
    this.#scope = options.scope ?? new D1RoomOperationScope(policy.maxInFlightPerConnection);
    if (this.#scope.limit !== policy.maxInFlightPerConnection) throw new Error('Mismatched operation limit');
  }
  #time(floor: number) {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid clock');
    return Math.max(now, floor);
  }
  #metadata(raw: unknown): { clock: number; state_json?: unknown } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Missing metadata');
    const row = raw as Record<string, unknown>;
    if (row.schema_version !== 1 || row.protocol !== ROOM_CONTROL_PROTOCOL || row.hub !== this.#hub
        || row.policy !== this.#policyJson || typeof row.clock !== 'number'
        || !Number.isSafeInteger(row.clock) || row.clock < 0) throw new Error('Invalid metadata');
    return { clock: row.clock, ...(Object.hasOwn(row, 'state_json') ? { state_json: row.state_json } : {}) };
  }
  /** Caller-owned lifetime; never keep this object or a snapshot in Worker globals. */
  async readState(wire: string, signingKey: string): Promise<RoomStateReadResult> {
    const denied = this.#scope.enter();
    if (denied) return { ok: false, reason: denied };
    try {
      const initial = this.#metadata(await this.#db.withSession('first-primary').prepare(META).first());
      if (this.#scope.broken) return { ok: false, reason: 'storage_error' };
      const startedAt = this.#time(initial.clock);
      const prepared = await prepareRoomStateRead(wire, signingKey, { hub: this.#hub, now: startedAt });
      if (this.#scope.broken) return { ok: false, reason: 'storage_error' };
      if (!prepared.ok) return prepared;
      const beforeRead = this.#time(startedAt);
      const stale = prepared.freshness(beforeRead);
      if (stale) return { ok: false, reason: stale };
      // First and ONLY query in a fresh first-primary session; no bookmarks or replica authority.
      const snapshot = this.#metadata(await this.#db.withSession('first-primary').prepare(SNAPSHOT)
        .bind(prepared.query.roomId).first());
      if (this.#scope.broken) return { ok: false, reason: 'storage_error' };
      if (snapshot.clock < initial.clock || !Object.hasOwn(snapshot, 'state_json')) throw new Error('Invalid snapshot');
      const observedAt = this.#time(Math.max(beforeRead, snapshot.clock));
      const expired = prepared.freshness(observedAt);
      if (expired) return { ok: false, reason: expired };
      const room = roomStateView(snapshot.state_json, prepared.query, signingKey);
      const finalExpiry = prepared.freshness(this.#time(observedAt));
      if (finalExpiry) return { ok: false, reason: finalExpiry };
      return { ok: true, queryId: prepared.query.queryId, observedAt, room };
    } catch {
      this.#scope.poison();
      return { ok: false, reason: 'storage_error' };
    } finally { this.#scope.leave(); }
  }
}
