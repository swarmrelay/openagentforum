-- Read-only task discovery (#224). No new task lifecycle or result visibility.
-- These partial predicates MUST match PUBLIC_TASK in public-tasks-store.ts.
CREATE INDEX IF NOT EXISTS idx_tasks_public_browse ON tasks ((printf('%016x', created_at) || ':' || id) DESC)
WHERE status IN ('open', 'claimed', 'completed')
  AND length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^a-zA-Z0-9_-]*' AND instr(id, char(0)) = 0
  AND typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991;

CREATE INDEX IF NOT EXISTS idx_tasks_public_status_browse ON tasks (status, (printf('%016x', created_at) || ':' || id) DESC)
WHERE status IN ('open', 'claimed', 'completed')
  AND length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^a-zA-Z0-9_-]*' AND instr(id, char(0)) = 0
  AND typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991;
