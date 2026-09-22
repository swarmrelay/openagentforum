import type { D1Database } from '@cloudflare/workers-types';
import { D1RoomAdmissionStore } from './d1-admission.js';
import { BudgetedRoomStore } from './request-gate.js';
import { REQUEST_BUDGET_SCHEMA, REQUEST_DB_NOW, initialRequestState, planRequest, requestConfiguration, requestState, requestTime,
  type BudgetedRoomOptions, type RoomRequestOptions, type RequestCharge, type RequestBudget, type Reservation } from './request-budget.js';

/** Explicit disposable-binding initialization, never a production migration or request-time refill. */
export async function initializeD1RoomRequestBudget(db: D1Database, options: RoomRequestOptions): Promise<void> {
  const config = requestConfiguration(options);
  try {
    const table = await db.withSession('first-primary').prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'room_lab_request_budget'").first();
    if (!table) {
      const session = db.withSession('first-primary');
      await session.batch([session.prepare(REQUEST_BUDGET_SCHEMA),
        session.prepare('INSERT INTO room_lab_request_budget VALUES (1, 1, ?, ?, ?)')
          .bind(config.hub, config.policyJson, initialRequestState())]);
    }
    requestState(await db.withSession('first-primary').prepare('SELECT * FROM room_lab_request_budget WHERE id = 1').first(), config);
  } catch { throw new Error('Request budget initialization failed'); }
}

class D1RequestBudget implements RequestBudget {
  readonly config;
  constructor(readonly db: D1Database, options: RoomRequestOptions) { this.config = requestConfiguration(options); }
  async reserve(charge: RequestCharge): Promise<Reservation> {
    try {
      const before = requestTime(this.config.now());
      const row = await this.db.withSession('first-primary')
        .prepare(`SELECT *, ${REQUEST_DB_NOW} AS db_now FROM room_lab_request_budget WHERE id = 1`).first();
      const plan = planRequest(row, this.config, charge, Math.max(before, requestTime(this.config.now()), requestTime(row?.db_now)));
      if (!plan.ok) return plan;
      const session = this.db.withSession('first-primary');
      const result = await session.batch([session.prepare(`UPDATE room_lab_request_budget SET state_json = ?1
        WHERE id = 1 AND schema_version = 1 AND hub = ?2 AND policy = ?3 AND state_json = ?4
          AND ${REQUEST_DB_NOW} < ?5 RETURNING state_json`)
        .bind(plan.stateJson, this.config.hub, this.config.policyJson, row!.state_json, plan.expiresAt)]);
      if (result.length !== 1 || !result[0].success) throw new Error('Invalid budget commit');
      // A concurrent charge/config change/window rollover wins: no retry and no work.
      if (result[0].results.length === 0) return { ok: false, reason: 'busy' };
      const returned = result[0].results[0];
      if (result[0].results.length !== 1 || !returned || typeof returned !== 'object'
          || !('state_json' in returned) || returned.state_json !== plan.stateJson) throw new Error('Invalid budget acknowledgment');
      if (requestTime(this.config.now()) >= plan.expiresAt) return { ok: false, reason: 'busy' };
      return { ok: true, expiresAt: plan.expiresAt };
    } catch { return { ok: false, reason: 'storage_error' }; }
  }
}

/** No constructor I/O. Operator configuration only; do not expose unbudgeted readers beside this wrapper. */
export function createBudgetedD1RoomStore(db: D1Database, options: BudgetedRoomOptions): BudgetedRoomStore {
  const budget = new D1RequestBudget(db, options);
  return new BudgetedRoomStore(new D1RoomAdmissionStore(db, options), budget, budget.config.now, options.policy.maxInFlightPerConnection);
}
