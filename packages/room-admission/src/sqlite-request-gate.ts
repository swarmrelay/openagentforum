import type { DatabaseSync } from 'node:sqlite';
import { RoomAdmissionStore } from './sqlite.js';
import { BudgetedRoomStore } from './request-gate.js';
import { REQUEST_BUDGET_SCHEMA, initialRequestState, planRequest, requestConfiguration, requestState, requestTime,
  type BudgetedRoomOptions, type RoomRequestOptions, type RequestCharge, type RequestBudget, type Reservation } from './request-budget.js';

class SQLiteRequestBudget implements RequestBudget {
  readonly config;
  constructor(readonly db: DatabaseSync, options: RoomRequestOptions) { this.config = requestConfiguration(options); }
  async reserve(charge: RequestCharge): Promise<Reservation> {
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); begun = true;
      const row = this.db.prepare('SELECT * FROM room_lab_request_budget WHERE id = 1').get();
      const plan = planRequest(row, this.config, charge, requestTime(this.config.now()));
      if (!plan.ok) { this.db.exec('ROLLBACK'); begun = false; return plan; }
      const written = this.db.prepare('UPDATE room_lab_request_budget SET state_json = ? WHERE id = 1 AND state_json = ?')
        .run(plan.stateJson, row!.state_json!);
      if (written.changes !== 1) throw new Error('Missing request charge');
      if (requestTime(this.config.now()) >= plan.expiresAt) { this.db.exec('ROLLBACK'); begun = false; return { ok: false, reason: 'busy' }; }
      this.db.exec('COMMIT'); begun = false;
      return { ok: true, expiresAt: plan.expiresAt };
    } catch {
      if (begun) { try { this.db.exec('ROLLBACK'); } catch { /* uncertain charge is never permission */ } }
      return { ok: false, reason: 'storage_error' };
    }
  }
}

/** Explicit dedicated-lab setup only, never called implicitly by a request or factory. */
export function initializeSQLiteRoomRequestBudget(db: DatabaseSync, options: RoomRequestOptions): void {
  const config = requestConfiguration(options);
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE'); begun = true;
    const installed = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'room_lab_request_budget'").get();
    if (!installed) {
      db.exec(REQUEST_BUDGET_SCHEMA);
      db.prepare('INSERT INTO room_lab_request_budget VALUES (1, 1, ?, ?, ?)')
        .run(config.hub, config.policyJson, initialRequestState());
    }
    // Never refill a missing row in an existing table (authority loss/corruption).
    requestState(db.prepare('SELECT * FROM room_lab_request_budget WHERE id = 1').get(), config);
    db.exec('COMMIT'); begun = false;
  } catch {
    if (begun) { try { db.exec('ROLLBACK'); } catch { /* no reset */ } }
    throw new Error('Request budget initialization failed');
  }
}

/** Existing protected reads stay unchanged. This factory never creates/refills request budgets. */
export function createBudgetedSQLiteRoomStore(db: DatabaseSync, options: BudgetedRoomOptions): BudgetedRoomStore {
  const budget = new SQLiteRequestBudget(db, options);
  return new BudgetedRoomStore(new RoomAdmissionStore(db, options), budget, budget.config.now, options.policy.maxInFlightPerConnection);
}
