import type { DatabaseSync } from 'node:sqlite';
import { assertSqliteWalRuntime } from '../../server/dist/sqlite-runtime.js';
import { need, integer, TaskLeaseError, type Options } from './contract.js';
import { TaskLeaseStore } from './store.js';
export { TaskLeaseError } from './contract.js';
export type { Options, Policy, Result, Input } from './contract.js';
export type { PreparedLeaseWrite } from './store.js';

/** Existing, operator-owned dedicated primary connection. No DDL or policy seed. */
export class SQLiteTaskLeases extends TaskLeaseStore {
  constructor(db: DatabaseSync, options: Options) {
    assertSqliteWalRuntime(db);
    const check = () => {
      need(db.prepare('PRAGMA journal_mode').get()?.journal_mode === 'wal'
        && db.prepare('PRAGMA synchronous').get()?.synchronous === 2
        && db.prepare('PRAGMA foreign_keys').get()?.foreign_keys === 1
        && db.prepare('PRAGMA recursive_triggers').get()?.recursive_triggers === 1
        && db.prepare('PRAGMA ignore_check_constraints').get()?.ignore_check_constraints === 0, 'authority');
      const timeout = db.prepare('PRAGMA busy_timeout').get()?.timeout;
      need(integer(timeout) && timeout <= 1000 && !db.prepare('SELECT 1 FROM sqlite_temp_schema LIMIT 1').get(), 'authority');
      const databases = db.prepare('PRAGMA database_list').all();
      need(databases.length <= 2 && databases.every(d => d.name === 'main' || d.name === 'temp'), 'authority');
    };
    const isBusy = (error: unknown) =>
      typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === 5;
    super({ async query({ sql, values }) {
        try {
          check(); return db.prepare(sql).all(...values);
        } catch (error) {
          if (isBusy(error)) throw new TaskLeaseError('busy');
          throw error;
        }
      },
      async batch(statements) {
        let begun = false, committing = false;
        try {
          db.exec('BEGIN IMMEDIATE'); begun = true; check();
          const results = statements.map(s => db.prepare(s.sql).all(...s.values));
          committing = true; db.exec('COMMIT'); begun = false; return results;
        } catch (error) {
          if (begun) { try { db.exec('ROLLBACK'); } catch { throw new TaskLeaseError('unavailable'); } }
          if (!begun && !committing && isBusy(error)) {
            throw new TaskLeaseError('busy');
          }
          throw error;
        }
      } }, options);
  }
}
