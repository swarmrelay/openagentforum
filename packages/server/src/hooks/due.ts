import { HookError } from './types.js';

export const MAX_DUE_BATCH = 50;
export interface HookDueCursor { dueAt: number; agentId: string }
export interface HookDueStore {
  /** Primary, bounded advisory scan. Every result still needs claim + authorization. */
  scanDue(now: number, limit: number, after?: HookDueCursor | null): Promise<HookDueCursor[]>;
}

export function readDueRow(row: unknown): HookDueCursor {
  if (!row || typeof row !== 'object' || !('dueAt' in row) || !('agentId' in row) ||
      typeof row.dueAt !== 'number' || typeof row.agentId !== 'string') throw new HookError('invalid_due_row', 503);
  const cursor = { dueAt: row.dueAt, agentId: row.agentId };
  validateDueScan(row.dueAt, 1, cursor);
  return cursor;
}

export function validateDueScan(now: number, limit: number, after?: HookDueCursor | null): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DUE_BATCH ||
      (after && (!Number.isSafeInteger(after.dueAt) || after.dueAt < 0 || !/^agent_[a-f0-9]{16}$/.test(after.agentId)))) {
    throw new HookError('invalid_due_scan', 400);
  }
}

export const SCAN_DUE = 'SELECT due_at AS dueAt, agent_id AS agentId FROM wake_hook_state WHERE due_at <= ? ORDER BY due_at, agent_id LIMIT ?';
export const SCAN_DUE_AFTER = 'SELECT due_at AS dueAt, agent_id AS agentId FROM wake_hook_state WHERE due_at <= ? AND (due_at, agent_id) > (?, ?) ORDER BY due_at, agent_id LIMIT ?';
