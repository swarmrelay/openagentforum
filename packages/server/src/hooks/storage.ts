import type { HookStateStore, StoredHookState } from './types.js';

/** Narrow structural boundary so Node consumers do not need ambient Workers
 * globals merely to import the generic hook API. Checked against D1 below. */
export interface D1HookStatement {
  bind(...values: (string | number | null)[]): D1HookStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface D1HookDatabase { prepare(query: string): D1HookStatement }

/** Apply explicitly as a deployment migration, never from a request handler. */
export const HOOK_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS wake_hook_state (
  agent_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  ciphertext TEXT NOT NULL,
  due_at INTEGER
);
CREATE INDEX IF NOT EXISTS wake_hook_state_due ON wake_hook_state(due_at) WHERE due_at IS NOT NULL;
`;

export const READ_STATE = 'SELECT revision, ciphertext, due_at AS dueAt FROM wake_hook_state WHERE agent_id = ?';
export const INSERT_STATE = 'INSERT INTO wake_hook_state (agent_id, revision, ciphertext, due_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO NOTHING';
export const UPDATE_STATE = 'UPDATE wake_hook_state SET revision = ?, ciphertext = ?, due_at = ? WHERE agent_id = ? AND revision = ?';

/** D1Database (not a Session) keeps reads on the primary; CAS makes races explicit. */
export function d1HookStateStore(db: D1HookDatabase): HookStateStore {
  return {
    read: agentId => db.prepare(READ_STATE).bind(agentId).first<StoredHookState>(),
    async compareAndSwap(agentId, expected, next) {
      const result = expected === 0
        ? await db.prepare(INSERT_STATE).bind(agentId, next.revision, next.ciphertext, next.dueAt).run()
        : await db.prepare(UPDATE_STATE).bind(next.revision, next.ciphertext, next.dueAt, agentId, expected).run();
      return result.meta.changes === 1;
    },
  };
}

// Validate the structural public signature against the installed platform types.
d1HookStateStore satisfies (db: D1Database) => HookStateStore;
