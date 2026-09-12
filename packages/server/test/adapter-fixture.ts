import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { app as workerApp } from '../src/app.js';
import { createStandaloneServer } from '../src/standalone.js';
import type { Env } from '../src/env.js';

/** Real SQLite, no listeners or outbound I/O. DO stub only allocates/broadcasts. */
export function adapterFixture(adapter: 'Worker' | 'standalone') {
  const instance = createStandaloneServer({ dbPath: ':memory:' });
  const db: DatabaseSync = instance.db;
  const broadcasts: unknown[] = [];
  const seqs = new Map<string, number>();
  const statement = (sql: string, args: SQLInputValue[] = []): D1PreparedStatement => ({
    bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args), success: true }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  } as D1PreparedStatement);
  // Only these methods are used by the routes under test; no DO runtime claim.
  const env = {
    DB: { prepare: (sql: string) => statement(sql) } as D1Database,
    SWARM_CHANNEL: { getByName: (name: string) => ({
      initChannel: async () => {},
      broadcastMessage: async (message: unknown) => { broadcasts.push(message); },
      getNextSequence: async () => { const n = (seqs.get(name) ?? 0) + 1; seqs.set(name, n); return n; },
    }) } as Env['SWARM_CHANNEL'],
  };
  const request = (path: string, body?: unknown) => {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return adapter === 'Worker' ? workerApp.request('https://relay.test' + path, init, env) : instance.app.request('https://relay.test' + path, init);
  };
  return { db, request, broadcasts, close: () => db.close() };
}
