import { type TaskRoute, type TaskCursor, TASK_CAPABILITY } from './public-tasks-routing.js';

export const TASK_PAGE_LIMIT = 20;
export const TASK_SCAN_LIMIT = 100;
// Fixed-width hexadecimal preserves nonnegative safe-integer time ordering;
// ASCII IDs break ties. One scalar seek avoids SQLite choosing a timestamp-only
// range for a row-value cursor and rescanning an arbitrarily long timestamp tie.
export const TASK_ORDER = "(printf('%016x', created_at) || ':' || id)";
// Tasks currently have NO private-room/channel ACL or encrypted result profile.
// Match migration 0008 exactly; unknown lifecycle states fail closed. Do not
// invent a private branch, infer a channel from peer text or publish results.
export const PUBLIC_TASK = `status IN ('open', 'claimed', 'completed')
  AND length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^a-zA-Z0-9_-]*' AND instr(id, char(0)) = 0
  AND typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991`;
interface TaskRow {
  id: string; status: 'open' | 'claimed' | 'completed'; created_at: number;
  title: string | null; description: string | null; creator: string | null;
  claimant: string | null; reward: string | null; capabilities: string | null;
}
export interface PublicTask {
  id: string; status: TaskRow['status']; createdAt: number;
  title: string; description: string; creator: string; claimant: string; reward: string;
  capabilities: string[]; truncated: boolean;
}
export interface TaskData { tasks: PublicTask[]; next?: TaskCursor }
const boundedColumn = (column: string, alias: string, limit: number) =>
  `CASE WHEN typeof(${column}) = 'text' AND instr(${column}, char(0)) = 0 THEN substr(${column}, 1, ${limit + 1}) ELSE NULL END AS ${alias}`;
const clipped = (value: string | null, limit: number) => value === null ? '[not provided or omitted]' : value.slice(0, limit);
function present(row: TaskRow, limit: number): PublicTask {
  let capabilities: string[] = [], complete = false;
  try {
    const value: unknown = row.capabilities !== null && row.capabilities.length <= 4096 ? JSON.parse(row.capabilities) : null;
    if (Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string' && TASK_CAPABILITY.test(item))) {
      capabilities = [...new Set(value)]; complete = true;
    }
  } catch { /* Malformed/oversized capability metadata is omitted, never guessed. */ }
  return { id: row.id, status: row.status, createdAt: row.created_at,
    title: clipped(row.title, 160), description: clipped(row.description, limit), creator: clipped(row.creator, 128),
    claimant: clipped(row.claimant, 128), reward: clipped(row.reward, 512), capabilities,
    truncated: !complete || row.title === null || row.description === null || row.creator === null
      || [row.title !== null && row.title.length > 160, row.description !== null && row.description.length > limit,
        row.creator !== null && row.creator.length > 128, row.claimant !== null && row.claimant.length > 128,
        row.reward !== null && row.reward.length > 512].some(Boolean) };
}
export async function readPublicTasks(db: D1Database, route: TaskRoute): Promise<TaskData | null> {
  const detail = route.kind === 'task';
  const textLimit = detail ? 6000 : 1000;
  const columns = ['id', 'status', 'created_at', boundedColumn('title', 'title', 160),
    boundedColumn('description', 'description', textLimit), boundedColumn('creator_id', 'creator', 128),
    boundedColumn('claimed_by', 'claimant', 128), boundedColumn('reward', 'reward', 512),
    boundedColumn('required_capabilities_json', 'capabilities', 4096)].join(', ');
  const filterStatus = route.kind === 'tasks' && route.status !== 'all';
  const index = detail ? '' : `INDEXED BY ${filterStatus ? 'idx_tasks_public_status_browse' : 'idx_tasks_public_browse'}`;
  const conditions = [PUBLIC_TASK];
  const args: (string | number)[] = [];
  if (detail) { conditions.push('id = ?'); args.push(route.id); }
  else {
    if (filterStatus) { conditions.push('status = ?'); args.push(route.status); }
    if (route.before) { conditions.push(`${TASK_ORDER} < ?`); args.push(route.before.createdAt.toString(16).padStart(16, '0') + ':' + route.before.id); }
  }
  // Apply capability matching AFTER a hard indexed candidate bound. JSON
  // predicates in WHERE would scan arbitrary history for sparse matches.
  args.push(detail ? 1 : TASK_SCAN_LIMIT + 1);
  const [result] = await db.batch<TaskRow>([db.prepare(`SELECT ${columns} FROM tasks ${index}
    WHERE ${conditions.join(' AND ')} ${detail ? '' : `ORDER BY ${TASK_ORDER} DESC`} LIMIT ?`).bind(...args)]);
  if (!result.success) throw new Error('Task reader unavailable');
  if (detail && !result.results.length) return null;
  const tasks: PublicTask[] = [];
  let consumed = 0;
  for (const row of result.results.slice(0, TASK_SCAN_LIMIT)) {
    consumed++;
    const task = present(row, textLimit);
    if (route.kind === 'task' || !route.capability || task.capabilities.includes(route.capability)) tasks.push(task);
    if (tasks.length === TASK_PAGE_LIMIT) break;
  }
  const last = result.results[consumed - 1];
  return { tasks, ...(last && result.results.length > consumed ? { next: { createdAt: last.created_at, id: last.id } } : {}) };
}
