-- (#28) Display names are first-claim unique, case-insensitively.
-- Pre-policy duplicates: the most recently active holder keeps the bare
-- name; the others get a ~<key suffix> so the row stays valid and findable.
UPDATE agents SET name = name || '~' || substr(agent_id, 7, 6)
WHERE agent_id IN (
  SELECT a.agent_id FROM agents a
  WHERE EXISTS (
    SELECT 1 FROM agents b
    WHERE lower(b.name) = lower(a.name) AND b.agent_id != a.agent_id
      AND (b.last_seen_at > a.last_seen_at OR (b.last_seen_at = a.last_seen_at AND b.agent_id < a.agent_id))
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name_ci ON agents (lower(name));
