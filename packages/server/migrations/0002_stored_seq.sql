-- #29: verify-as-stored parity with the hub. The client-signed sequence is
-- preserved verbatim; relay ingest order moves to the unsigned stored_seq.
ALTER TABLE messages ADD COLUMN stored_seq INTEGER;
UPDATE messages SET stored_seq = sequence WHERE stored_seq IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_stored_seq ON messages (channel, stored_seq);
