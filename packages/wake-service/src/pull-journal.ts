import { createRequire } from 'node:module';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import type { DeliveryResult } from './job.js';
import { cleanResult, exact, isCursor, isRef, object, sameRef, type PollReply, type PullCursor, type WorkRef } from './pull-protocol.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export interface PullState { after: PullCursor | null; pending: { ref: WorkRef; result: DeliveryResult | null } | null }

/** One bounded slot, no URL/secret/job bodies. Exclusive connection prevents two local pullers. */
export class PullJournal {
  private readonly db: SQLiteDatabase;
  constructor(path: string, hub: string, endpoint: string) {
    this.db = new DatabaseSync(path);
    try {
      // Unlike the attempt ledger, this small journal uses a rollback journal. EXTRA
      // also syncs unlink directory entries; FULL alone is insufficient in DELETE mode.
      // EXCLUSIVE locking is retained across commits, not an uncommitted transaction.
      this.db.exec(`PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE;
        PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS pull_state (id INTEGER PRIMARY KEY CHECK(id = 1), hub TEXT NOT NULL, endpoint TEXT NOT NULL, state TEXT NOT NULL);
        COMMIT;`);
      this.db.prepare('INSERT OR IGNORE INTO pull_state VALUES (1, ?, ?, ?)').run(hub, endpoint, JSON.stringify({ after: null, pending: null }));
      const identity = this.db.prepare('SELECT hub, endpoint FROM pull_state WHERE id = 1').get() as { hub: string; endpoint: string };
      if (identity.hub !== hub || identity.endpoint !== endpoint) throw new Error('pull journal configuration changed');
      this.read();
    } catch (error) { this.db.close(); throw error; }
  }
  read(): PullState {
    const row = this.db.prepare('SELECT state FROM pull_state WHERE id = 1').get() as { state: string };
    const value: unknown = JSON.parse(row.state);
    if (!object(value) || !exact(value, ['after', 'pending']) || !isCursor(value.after)) throw new Error('invalid pull journal');
    if (value.pending === null) return { after: value.after, pending: null };
    const pending = value.pending;
    if (!object(pending) || !exact(pending, ['ref', 'result']) || !isRef(pending.ref)) throw new Error('invalid pull journal');
    const result = pending.result === null ? null : cleanResult(pending.result, pending.ref.kind);
    if (pending.result !== null && !result) throw new Error('invalid pull journal');
    return { after: value.after, pending: { ref: pending.ref, result } };
  }
  accept(reply: PollReply): void {
    if (this.read().pending || !isCursor(reply.after) || (reply.ref !== null && !isRef(reply.ref))) throw new Error('invalid pull transition');
    this.write({ after: reply.after, pending: reply.ref ? { ref: reply.ref, result: null } : null });
  }
  result(ref: WorkRef, result: DeliveryResult): void {
    const state = this.read();
    const sanitized = cleanResult(result, ref.kind);
    if (!state.pending || !sameRef(state.pending.ref, ref) || !sanitized) throw new Error('invalid pull transition');
    // First outcome wins, including recovery's conservative indeterminate outcome.
    if (state.pending.result === null) this.write({ ...state, pending: { ref, result: sanitized } });
  }
  clear(ref: WorkRef): void {
    const state = this.read();
    if (!state.pending || !sameRef(state.pending.ref, ref)) throw new Error('invalid pull transition');
    this.write({ ...state, pending: null });
  }
  private write(state: PullState): void {
    this.db.prepare('UPDATE pull_state SET state = ? WHERE id = 1').run(JSON.stringify(state));
  }
  close(): void { this.db.close(); }
}
