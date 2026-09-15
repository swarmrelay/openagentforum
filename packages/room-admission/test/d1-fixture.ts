import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/** Real SQLite statements and rollback, with injectable D1 transport boundaries. */
export class TestD1 implements D1Database {
  beforeBatch: (sql: string[]) => Promise<void> = async () => {};
  afterCommit: () => Promise<void> = async () => {};
  beforeStatement: (sql: string) => void = () => {};
  beforeRead: (sql: string) => Promise<void> = async () => {};
  afterRead: (sql: string) => Promise<void> = async () => {};
  calls: string[] = [];
  sessions: string[][] = [];
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(sql: string) { return new Statement(this, sql); }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const inputs = statements.map(s => { if (!(s instanceof Statement) || s.owner !== this) throw new Error('Wrong binding'); return s; });
    await this.beforeBatch(inputs.map(s => s.sql));
    this.sqlite.exec('BEGIN IMMEDIATE');
    let results: D1Result<T>[];
    try {
      results = inputs.map(s => { this.beforeStatement(s.sql); return s.execute<T>(); });
      this.sqlite.exec('COMMIT');
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    await this.afterCommit();
    return results;
  }
  withSession(constraint?: string) {
    if (constraint !== 'first-primary') throw new Error('Not primary');
    const queries: string[] = [];
    this.sessions.push(queries);
    return { prepare: (sql: string) => { queries.push(sql); return this.prepare(sql); },
      batch: <T = unknown>(s: D1PreparedStatement[]) => this.batch<T>(s), getBookmark: () => null };
  }
  async exec(): Promise<never> { throw new Error('No raw exec'); }
  async dump(): Promise<never> { throw new Error('No dump'); }
}
class Statement implements D1PreparedStatement {
  #args: SQLInputValue[] = [];
  constructor(readonly owner: TestD1, readonly sql: string) {}
  bind(...args: unknown[]) {
    this.#args = args.map(value => {
      if (value === null || typeof value === 'string' || typeof value === 'number') return value;
      throw new Error('Invalid fixture binding');
    });
    return this;
  }
  execute<T>(): D1Result<T> {
    this.owner.calls.push(this.sql);
    const stmt = this.owner.sqlite.prepare(this.sql);
    const results = (/\?\d+/.test(this.sql)
      ? stmt.all(Object.fromEntries(this.#args.map((value, i) => [`?${i + 1}`, value])))
      : stmt.all(...this.#args)) as T[];
    return { success: true, results, meta: { duration: 0, size_after: 0, rows_read: results.length,
      rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 } };
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    await this.owner.beforeRead(this.sql);
    const result = this.execute<T>().results[0] ?? null;
    await this.owner.afterRead(this.sql);
    return result;
  }
  async all<T = Record<string, unknown>>() { return this.execute<T>(); }
  async run<T = Record<string, unknown>>() { return this.execute<T>(); }
  async raw(): Promise<never> { throw new Error('No raw reads'); }
}
