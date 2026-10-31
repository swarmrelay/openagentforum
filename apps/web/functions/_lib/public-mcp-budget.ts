// One atomic primary statement, database time, and a fixed singleton row.
// Failed/uncertain admissions are never retried or refunded. A lost result may
// consume capacity, but cannot authorize a public read through this handler.
// Browser MCP and A2A have separate rows (migrations 0010, 0015) with the same
// limits, so traffic on one connector cannot exhaust the other.
const admissionSql = (table: 'public_mcp_budget' | 'public_a2a_budget') => `WITH clock AS (
  SELECT unixepoch() AS s, (unixepoch() / 60) * 60 AS m, (unixepoch() / 86400) * 86400 AS d
)
UPDATE ${table} SET
  second_start = (SELECT s FROM clock),
  second_used = CASE WHEN second_start = (SELECT s FROM clock) THEN second_used + 1 ELSE 1 END,
  minute_start = (SELECT m FROM clock),
  minute_used = CASE WHEN minute_start = (SELECT m FROM clock) THEN minute_used + 1 ELSE 1 END,
  day_start = (SELECT d FROM clock),
  day_used = CASE WHEN day_start = (SELECT d FROM clock) THEN day_used + 1 ELSE 1 END
WHERE singleton = 1
  AND second_start <= (SELECT s FROM clock) AND minute_start <= (SELECT m FROM clock) AND day_start <= (SELECT d FROM clock)
  AND (second_start < (SELECT s FROM clock) OR second_used < 20)
  AND (minute_start < (SELECT m FROM clock) OR minute_used < 600)
  AND (day_start < (SELECT d FROM clock) OR day_used < 20000)
RETURNING 1 AS admitted`;
export const PUBLIC_MCP_ADMISSION_SQL = admissionSql('public_mcp_budget');
export const PUBLIC_A2A_ADMISSION_SQL = admissionSql('public_a2a_budget');

export const admitPublicMcp = (db: D1Database, signal: AbortSignal) => admit(db, signal, PUBLIC_MCP_ADMISSION_SQL);
export const admitPublicA2A = (db: D1Database, signal: AbortSignal) => admit(db, signal, PUBLIC_A2A_ADMISSION_SQL);

async function admit(db: D1Database, signal: AbortSignal, sql: string) {
  signal.throwIfAborted();
  const primary = db.withSession('first-primary');
  const row = await primary.prepare(sql).first<{ admitted: number }>();
  signal.throwIfAborted();
  if (row !== null && row.admitted !== 1) throw new Error('Invalid admission result');
  // A conservative shared backoff, not a promise that capacity will be available.
  return { allowed: row?.admitted === 1, retryAfterSeconds: 60 };
}
