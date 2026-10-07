import type { DatabaseSync } from 'node:sqlite';
import { assertSqliteWalRuntime } from './sqlite-runtime.js';
import { PUBLIC_WRITE_BUDGET_READ, PUBLIC_WRITE_BUDGET_CAS, PublicWriteBudgetError,
  publicWriteBudgetConfiguration, planPublicWriteCharge, publicWriteAdmission,
  type PublicWriteAdmission, type PublicWriteBudgetOptions } from './public-write-budget.js';

/** Uses an existing operator-owned connection; no schema initialization or fallback. */
export function createSQLitePublicWriteAdmission(db: DatabaseSync, options: PublicWriteBudgetOptions): PublicWriteAdmission {
  const config = publicWriteBudgetConfiguration(options);
  assertSqliteWalRuntime(db);
  return publicWriteAdmission(async (operation, active) => {
    let begun = false;
    try {
      active();
      const started = performance.now();
      db.exec('BEGIN IMMEDIATE'); begun = true;
      const row = db.prepare(PUBLIC_WRITE_BUDGET_READ).get();
      const plan = planPublicWriteCharge(row, config, operation);
      const validUntil = started + plan.expiresAt - plan.clock;
      active();
      if (performance.now() >= validUntil) throw new PublicWriteBudgetError('public_write_budget_busy');
      const committed = db.prepare(PUBLIC_WRITE_BUDGET_CAS).get(plan.stateJson, config.origin, config.generation,
        config.policyJson, row!.state_json!, plan.clock, plan.expiresAt);
      if (!committed) throw new PublicWriteBudgetError('public_write_budget_busy');
      if (committed.state_json !== plan.stateJson || typeof committed.db_now !== 'number' || !Number.isSafeInteger(committed.db_now)
        || committed.db_now < plan.clock || committed.db_now >= plan.expiresAt) throw new Error();
      active();
      db.exec('COMMIT'); begun = false;
      return { validUntil };
    } catch (error) {
      if (begun) {
        try { db.exec('ROLLBACK'); } catch { throw new PublicWriteBudgetError('public_write_budget_unavailable'); }
      }
      throw error;
    }
  });
}
