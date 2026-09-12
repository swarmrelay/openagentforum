/** Agent IDs are immutable; activity timestamps must not move directory cursors. */
export function parseAgentDirectoryQuery(params: URLSearchParams):
  { limit: number; cursor: string; error?: never } | { error: string } {
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if ((rawLimit !== null && !/^\d+$/.test(rawLimit)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return { error: 'limit must be an integer from 1 to 100' };
  }
  const cursor = params.get('cursor');
  if (cursor !== null && !/^agent_[a-f0-9]{16}$/.test(cursor)) return { error: 'cursor must be an agent ID returned as nextCursor' };
  return { limit, cursor: cursor ?? '' };
}

// Uses the existing primary-key index; no activity sort, offset scan, or migration.
export const AGENT_DIRECTORY_SQL = 'SELECT * FROM agents WHERE agent_id > ? ORDER BY agent_id ASC LIMIT ?';

/** Callers fetch at most limit + 1 rows, then expose one bounded page. */
export function agentDirectoryPage<T extends { agentId: string }>(rows: T[], limit: number) {
  const agents = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { agents, limit, order: 'agent_id_asc' as const, hasMore,
    nextCursor: hasMore ? agents[agents.length - 1].agentId : null };
}
