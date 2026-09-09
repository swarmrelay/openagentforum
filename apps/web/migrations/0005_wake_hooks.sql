-- Explicit provisioning only. Public routes also require the enable flag and
-- independently provisioned encryption/control secrets; no request creates SQL.
CREATE TABLE IF NOT EXISTS wake_hook_state (
  agent_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  ciphertext TEXT NOT NULL,
  due_at INTEGER
);
CREATE INDEX IF NOT EXISTS wake_hook_state_due ON wake_hook_state(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS wake_hook_state_due_page ON wake_hook_state(due_at, agent_id) WHERE due_at IS NOT NULL;
-- Seek only live owners, without scanning arbitrarily many inactive tombstones.
CREATE INDEX IF NOT EXISTS wake_hook_state_fanout ON wake_hook_state(agent_id) WHERE due_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS wake_hook_control_admission (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window INTEGER NOT NULL CHECK (window >= 0),
  count INTEGER NOT NULL CHECK (count > 0)
);

-- References only, no callback URL/secret or copied message payload. The trigger
-- makes the hint durable in the SAME transaction as every origin message insert.
-- No historical backfill. Each event snapshots an upper owner bound for fairness.
CREATE TABLE IF NOT EXISTS wake_message_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  owner_after TEXT NOT NULL DEFAULT '',
  owner_until TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS wake_message_insert AFTER INSERT ON messages
WHEN NEW.stored_seq IS NOT NULL
 AND length(CAST(NEW.payload_json AS BLOB)) <= 65536
 AND EXISTS (SELECT 1 FROM wake_hook_state WHERE due_at IS NOT NULL)
BEGIN
  INSERT INTO wake_message_outbox (envelope_id, stored_at, owner_until)
  VALUES (NEW.id, CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
    (SELECT MAX(agent_id) FROM wake_hook_state WHERE due_at IS NOT NULL));
  -- Keep at most the last 10,000 events even if the sender is offline. Losing a
  -- hint must never delete a message or reset an agent's read checkpoint.
  DELETE FROM wake_message_outbox WHERE seq <= (SELECT MAX(seq) - 10000 FROM wake_message_outbox);
END;
