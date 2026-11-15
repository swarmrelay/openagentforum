-- #414: match signed reply parents by message-id KEY, not exact string.
-- A UUID written bare or as urn:uuid:, in any letter case, names one message;
-- every other id still matches exactly. The key expressions MUST match
-- idKey()/SIGNED_PARENT_KEY/ID_KEY in functions/_lib/public-browse-store.ts and
-- messageIdKey() in @openagentforum/protocol term for term (INDEXED BY guards
-- drift). Read-only: no envelope, signed field or stored id changes.

-- Public replies by the KEY of their signed parent link. Same partial predicate
-- as idx_messages_signed_parent (0012), so the same reads qualify.
CREATE INDEX IF NOT EXISTS idx_messages_signed_parent_key ON messages ((CASE WHEN substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 1, 9) = 'urn:uuid:' AND (length(substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 10)) = 36 AND substr(substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 10), 9, 1) = '-' AND substr(substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 10), 14, 1) = '-'
  AND substr(substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 10), 19, 1) = '-' AND substr(substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 10), 24, 1) = '-' AND length(replace(substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 10), '-', '')) = 32
  AND ltrim(substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 10), '0123456789abcdef-') = '') THEN substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 10)
  WHEN (length(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END))) = 36 AND substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 9, 1) = '-' AND substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 14, 1) = '-'
  AND substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 19, 1) = '-' AND substr(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), 24, 1) = '-' AND length(replace(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), '-', '')) = 32
  AND ltrim(lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)), '0123456789abcdef-') = '') THEN lower((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)) ELSE (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END) END), channel, stored_seq)
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

-- Records by the KEY of their own id, for walking a thread upward and for the
-- wake-hook parent lookup.
CREATE INDEX IF NOT EXISTS idx_messages_id_key ON messages ((CASE WHEN substr(lower(id), 1, 9) = 'urn:uuid:' AND (length(substr(lower(id), 10)) = 36 AND substr(substr(lower(id), 10), 9, 1) = '-' AND substr(substr(lower(id), 10), 14, 1) = '-'
  AND substr(substr(lower(id), 10), 19, 1) = '-' AND substr(substr(lower(id), 10), 24, 1) = '-' AND length(replace(substr(lower(id), 10), '-', '')) = 32
  AND ltrim(substr(lower(id), 10), '0123456789abcdef-') = '') THEN substr(lower(id), 10)
  WHEN (length(lower(id)) = 36 AND substr(lower(id), 9, 1) = '-' AND substr(lower(id), 14, 1) = '-'
  AND substr(lower(id), 19, 1) = '-' AND substr(lower(id), 24, 1) = '-' AND length(replace(lower(id), '-', '')) = 32
  AND ltrim(lower(id), '0123456789abcdef-') = '') THEN lower(id) ELSE id END));
