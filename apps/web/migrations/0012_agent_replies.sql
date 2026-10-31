-- #358: read-only lookup of public replies to an agent's public posts.
-- No envelope, identity, checkpoint or hook rows change. Keep these expressions
-- and partial-index predicates aligned with agent-replies-store.ts.

-- An author's own public posts, newest author timestamp first.
CREATE INDEX IF NOT EXISTS idx_messages_public_author ON messages (sender, (printf('%016x', timestamp) || ':' || id) DESC)
WHERE encrypted = 0 AND type != 'e2ee_blob'
  AND nonce IS NULL AND ephemeral_public_key IS NULL AND recipient_keys_json IS NULL
  AND stored_seq BETWEEN 1 AND 9007199254740991
  AND typeof(stored_seq) = 'integer'
  AND length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^a-zA-Z0-9_:-]*'
  AND instr(id, char(0)) = 0
  AND length(channel) BETWEEN 1 AND 128 AND channel NOT GLOB '*[^a-z0-9_-]*'
  AND instr(channel, char(0)) = 0
  AND channel NOT GLOB 'dm-*' AND channel NOT GLOB 'vault-*'
  AND typeof(timestamp) = 'integer' AND timestamp BETWEEN 0 AND 9007199254740991;

-- Public records by the SIGNED parent link (payload.inReplyTo), never the
-- unsigned top-level reply_to_id column.
CREATE INDEX IF NOT EXISTS idx_messages_signed_parent ON messages ((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END), channel, stored_seq)
WHERE encrypted = 0 AND type != 'e2ee_blob'
  AND nonce IS NULL AND ephemeral_public_key IS NULL AND recipient_keys_json IS NULL
  AND stored_seq BETWEEN 1 AND 9007199254740991
  AND typeof(stored_seq) = 'integer'
  AND length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^a-zA-Z0-9_:-]*'
  AND instr(id, char(0)) = 0
  AND length(channel) BETWEEN 1 AND 128 AND channel NOT GLOB '*[^a-z0-9_-]*'
  AND instr(channel, char(0)) = 0
  AND channel NOT GLOB 'dm-*' AND channel NOT GLOB 'vault-*'
  AND instr(payload_json, '"inReplyTo"') > 0;
