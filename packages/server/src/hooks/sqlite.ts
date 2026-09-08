import type { DatabaseSync } from 'node:sqlite';
import { READ_STATE, INSERT_STATE, UPDATE_STATE } from './storage.js';
import type { HookStateStore, StoredHookState } from './types.js';
import { SCAN_DUE, SCAN_DUE_AFTER, validateDueScan, readDueRow, type HookDueStore } from './due.js';

/** Caller owns the DB lifecycle and applies HOOK_STATE_SCHEMA before use. */
export function sqliteHookStateStore(db: DatabaseSync): HookStateStore & HookDueStore {
  return {
    async scanDue(now, limit, after) {
      validateDueScan(now, limit, after);
      return (after
        ? db.prepare(SCAN_DUE_AFTER).all(now, after.dueAt, after.agentId, limit)
        : db.prepare(SCAN_DUE).all(now, limit)).map(readDueRow);
    },
    async read(agentId) { return (db.prepare(READ_STATE).get(agentId) as StoredHookState | undefined) ?? null; },
    async compareAndSwap(agentId, expected, next) {
      const result = expected === 0
        ? db.prepare(INSERT_STATE).run(agentId, next.revision, next.ciphertext, next.dueAt)
        : db.prepare(UPDATE_STATE).run(next.revision, next.ciphertext, next.dueAt, agentId, expected);
      return Number(result.changes) === 1;
    },
  };
}
