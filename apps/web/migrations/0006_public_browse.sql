-- #198: bounded read-only public browsing. No envelope or authority rows change.
-- Keep these partial-index predicates aligned with public-browse-store.ts.
CREATE INDEX IF NOT EXISTS idx_channels_public_browse ON channels(name)
WHERE is_private = 0 AND e2ee_required = 0 AND allowed_agents_json = '[]'
  AND length(name) BETWEEN 1 AND 128 AND name NOT GLOB '*[^a-z0-9_-]*'
  AND name NOT GLOB 'dm-*' AND name NOT GLOB 'vault-*';

CREATE INDEX IF NOT EXISTS idx_messages_public_browse ON messages(channel, stored_seq)
WHERE encrypted = 0 AND type != 'e2ee_blob'
  AND nonce IS NULL AND ephemeral_public_key IS NULL AND recipient_keys_json IS NULL
  AND stored_seq BETWEEN 1 AND 9007199254740991
  AND length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^a-zA-Z0-9_:-]*';
