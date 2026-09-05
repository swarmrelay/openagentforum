import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { canonicalizeJson, HOOK_LIMITS } from '@openagentforum/protocol';
import type { DeliveryJob, DeliveryResult } from './job.js';

const HOUR = 3600_000;
const RETENTION_MS = 24 * HOUR;
// Vite 5 predates node:sqlite. Load the builtin through Node, as the standalone
// relay does, while retaining its actual TypeScript types.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type Reservation = { kind: 'reserved' } | { kind: 'duplicate'; result: DeliveryResult } |
  { kind: 'conflict' } | { kind: 'limited'; retryAfter: number };

/** Commit before dialing. An interrupted attempt is indeterminate, never automatically resent. */
export class AttemptLedger {
  private readonly db: SQLiteDatabase;
  constructor(path: string, private readonly globalPerHour = 1000, private readonly maxAttempts = 50_000) {
    if (!Number.isSafeInteger(globalPerHour) || globalPerHour < 1 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('invalid ledger limits');
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS attempts (job_id TEXT PRIMARY KEY, digest TEXT NOT NULL, created_at INTEGER NOT NULL, result TEXT);
      CREATE INDEX IF NOT EXISTS attempts_created ON attempts(created_at);
      CREATE TABLE IF NOT EXISTS budgets (scope TEXT NOT NULL, hour INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(scope, hour));
      CREATE TABLE IF NOT EXISTS clock (id INTEGER PRIMARY KEY CHECK(id = 1), now INTEGER NOT NULL);
      INSERT OR IGNORE INTO clock VALUES (1, 0);
    `);
  }

  reserve(job: DeliveryJob, time: number): Reservation {
    const digest = createHash('sha256').update(canonicalizeJson(job)).digest('hex');
    return this.transaction((): Reservation => {
      // Clock rollback cannot reopen an already consumed hour or erase fresh reservations.
      const clock = this.db.prepare('SELECT now FROM clock WHERE id = 1').get() as { now: number };
      const now = Math.max(time, clock.now);
      this.db.prepare('UPDATE clock SET now = ? WHERE id = 1').run(now);
      const hour = Math.floor(now / HOUR);
      this.db.prepare('DELETE FROM attempts WHERE created_at <= ?').run(now - RETENTION_MS);
      this.db.prepare('DELETE FROM budgets WHERE hour < ?').run(hour);
      const previous = this.db.prepare('SELECT digest, result FROM attempts WHERE job_id = ?').get(job.jobId) as { digest: string; result: string | null } | undefined;
      if (previous) {
        if (previous.digest !== digest) return { kind: 'conflict' };
        return { kind: 'duplicate', result: previous.result ? JSON.parse(previous.result) : { ok: false, code: 'indeterminate', retryable: false } };
      }
      const count = (this.db.prepare('SELECT count(*) AS count FROM attempts').get() as { count: number }).count;
      if (count >= this.maxAttempts) return { kind: 'limited', retryAfter: 60 };
      const scopes = [['global', this.globalPerHour], [`hook:${job.body.hookId}`, HOOK_LIMITS.budgetPerHour]] as const;
      for (const [scope, limit] of scopes) {
        const budget = this.db.prepare('SELECT count FROM budgets WHERE scope = ? AND hour = ?').get(scope, hour) as { count: number } | undefined;
        if ((budget?.count ?? 0) >= limit) return { kind: 'limited', retryAfter: Math.max(1, Math.ceil(((hour + 1) * HOUR - now) / 1000)) };
      }
      this.db.prepare('INSERT INTO attempts (job_id, digest, created_at) VALUES (?, ?, ?)').run(job.jobId, digest, now);
      for (const [scope] of scopes) {
        this.db.prepare('INSERT INTO budgets VALUES (?, ?, 1) ON CONFLICT(scope, hour) DO UPDATE SET count = count + 1').run(scope, hour);
      }
      return { kind: 'reserved' };
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  complete(jobId: string, result: DeliveryResult): void {
    this.db.prepare('UPDATE attempts SET result = ? WHERE job_id = ? AND result IS NULL').run(JSON.stringify(result), jobId);
  }

  close(): void { this.db.close(); }
}
