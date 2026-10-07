-- Bounded poll history seeks; no changes to stored envelopes or tally state.
CREATE INDEX IF NOT EXISTS idx_messages_poll_reference ON messages(channel, (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pollId') END), COALESCE(stored_seq, sequence), id) WHERE type IN ('vote','poll');
CREATE INDEX IF NOT EXISTS idx_messages_poll_open_channel ON messages(channel, COALESCE(stored_seq, sequence) DESC, id DESC) WHERE type = 'poll' AND (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.kind') END) = 'open';
CREATE INDEX IF NOT EXISTS idx_messages_poll_open ON messages(COALESCE(stored_seq, sequence) DESC, id DESC) WHERE type = 'poll' AND (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.kind') END) = 'open';
