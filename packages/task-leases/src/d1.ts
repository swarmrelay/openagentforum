import type { D1Database } from '@cloudflare/workers-types';
import { need, type Options } from './contract.js';
import { TaskLeaseStore } from './store.js';
import type { Raw } from './state.js';
export { TaskLeaseError } from './contract.js';
export type { Options, Policy, Result, Input } from './contract.js';
export type { PreparedLeaseWrite } from './store.js';

/** One fresh primary session per snapshot/charge or whole atomic mutation batch. */
export class D1TaskLeases extends TaskLeaseStore {
  constructor(db: Pick<D1Database, 'withSession'>, options: Options) {
    super({ async query({ sql, values }) {
      const result = await db.withSession('first-primary').prepare(sql).bind(...values).all<Raw>();
      need(result.success, 'unavailable'); return result.results;
    }, async batch(statements) {
      const session = db.withSession('first-primary');
      const results = await session.batch<Raw>(statements.map(s => session.prepare(s.sql).bind(...s.values)));
      need(results.every(r => r.success), 'unavailable'); return results.map(r => r.results);
    } }, options);
  }
}
