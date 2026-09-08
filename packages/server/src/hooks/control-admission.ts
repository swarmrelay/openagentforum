import type { D1HookDatabase } from './storage.js';
import { HookError } from './types.js';

/** One shared primary row per hub, including across token rotations and isolates. */
export interface HookControlAdmission { admit(now: number): Promise<boolean> }
export const MAX_CONTROL_REQUESTS_PER_SECOND = 16;
export const HOOK_CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS wake_hook_control_admission (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window INTEGER NOT NULL CHECK (window >= 0),
  count INTEGER NOT NULL CHECK (count > 0)
);
`;
export const ADMIT_CONTROL = `INSERT INTO wake_hook_control_admission (id, window, count) VALUES (1, ?, 1)
ON CONFLICT(id) DO UPDATE SET
  window = MAX(wake_hook_control_admission.window, excluded.window),
  count = CASE WHEN excluded.window > wake_hook_control_admission.window THEN 1 ELSE wake_hook_control_admission.count + 1 END
WHERE excluded.window > wake_hook_control_admission.window OR wake_hook_control_admission.count < ?`;

export function validateControlRate(rate: number): void {
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > MAX_CONTROL_REQUESTS_PER_SECOND) throw new HookError('invalid_control_config', 503);
}
export function controlWindow(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new HookError('invalid_control_clock', 503);
  return Math.floor(now / 1000);
}

/** Apply HOOK_CONTROL_SCHEMA explicitly. Do not pass a replica/session or a separate per-sender DB. */
export function d1HookControlAdmission(db: D1HookDatabase, requestsPerSecond = 8): HookControlAdmission {
  validateControlRate(requestsPerSecond);
  return { async admit(now) {
    const result = await db.prepare(ADMIT_CONTROL).bind(controlWindow(now), requestsPerSecond).run();
    return result.meta.changes === 1;
  } };
}
d1HookControlAdmission satisfies (db: D1Database) => HookControlAdmission;
