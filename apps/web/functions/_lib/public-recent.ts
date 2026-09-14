import { MESSAGE_COLUMNS, PUBLIC_CHANNEL, PUBLIC_MESSAGE, presentMessage, type BrowseData, type BrowseRoute, type PublicRow } from './public-browse-store.js';
import { InputError } from './public-browse-routing.js';

export const RECENT_SCAN_LIMIT = 100;
export const RECENT_RETENTION = 10000;

interface RecentState { epoch: string; high_seq: number; started_at: number }
type ArrivalRow = PublicRow & { arrival_seq: number; arrived_at: number };

export async function readPublicRecent(db: D1Database, route: Extract<BrowseRoute, { kind: 'recent' }>): Promise<BrowseData> {
  const forward = Boolean(route.after);
  const cursor = route.after ?? route.before;
  const order = forward ? 'ASC' : 'DESC';
  const stateQuery = db.prepare('SELECT epoch, high_seq, started_at FROM public_recent_state WHERE id = ?').bind(1);
  // LIMIT in the inner, non-flattenable ordered subquery bounds work BEFORE
  // current visibility filtering. Hidden histories must not cause a wide scan.
  // LEFT JOIN preserves a scan boundary even when every candidate is hidden.
  const rowsQuery = db.prepare(`SELECT e.arrival_seq, e.arrived_at, ${MESSAGE_COLUMNS}
    FROM (SELECT arrival_seq, envelope_id, channel, stored_seq, arrived_at FROM public_message_arrivals
      WHERE arrival_seq ${forward ? '>' : cursor ? '<' : '<='} ? AND arrival_seq <= (SELECT high_seq FROM public_recent_state WHERE id = 1)
      ORDER BY arrival_seq ${order} LIMIT ${RECENT_SCAN_LIMIT}) AS e
    LEFT JOIN messages AS m ON m.id = e.envelope_id AND m.channel = e.channel AND m.stored_seq = e.stored_seq
      AND m.id IN (SELECT id FROM messages WHERE id = e.envelope_id AND ${PUBLIC_MESSAGE})
      AND EXISTS (SELECT 1 FROM channels WHERE name = e.channel AND ${PUBLIC_CHANNEL})
    LEFT JOIN agents AS a ON a.agent_id = m.sender
    ORDER BY e.arrival_seq ${order}`).bind(cursor?.position ?? Number.MAX_SAFE_INTEGER);
  const [stateResult, rowsResult] = await db.batch<RecentState | ArrivalRow>([stateQuery, rowsQuery]);
  if (!stateResult.success || !rowsResult.success || stateResult.results.length !== 1) throw new Error('Recent view unavailable');
  const state = stateResult.results[0] as RecentState;
  if (!/^[a-f0-9]{32}$/.test(state.epoch) || !Number.isSafeInteger(state.high_seq) || state.high_seq < 0 || !Number.isSafeInteger(state.started_at)) throw new Error('Invalid recent state');
  const floor = Math.max(0, state.high_seq - RECENT_RETENTION);
  if (cursor && (cursor.epoch !== state.epoch || cursor.position < floor || (route.before && cursor.position <= floor + 1))) throw new InputError(410);
  if (cursor && cursor.position > state.high_seq) throw new InputError(400);
  const rows = rowsResult.results as ArrivalRow[];
  const selected: ArrivalRow[] = [];
  let boundary = cursor?.position ?? state.high_seq;
  let processed = 0;
  for (const row of rows) {
    boundary = row.arrival_seq; processed++;
    if (row.id !== null) selected.push(row);
    if (selected.length === 20) break;
  }
  // If the bounded scan exhausted the range, advance across deleted references
  // too. Otherwise continue from the last SCANNED row, not the last visible one.
  const exhausted = processed === rows.length && rows.length < RECENT_SCAN_LIMIT;
  if (exhausted) boundary = forward ? state.high_seq : floor + 1;
  const more = forward ? boundary < state.high_seq : boundary > floor + 1;
  const entries = await Promise.all(selected.map(async row => ({ message: await presentMessage(row, 1500), arrivedAt: row.arrived_at })));
  return { channels: [], messages: entries.map(entry => entry.message), recent: { entries, startedAt: state.started_at,
    ...(more ? { next: { epoch: state.epoch, position: boundary } } : {}),
    // Descending pages intentionally start future catch-up from the observed
    // high-water mark; their Older links are the way to inspect earlier records.
    resume: { epoch: state.epoch, position: forward ? boundary : state.high_seq },
  } };
}
