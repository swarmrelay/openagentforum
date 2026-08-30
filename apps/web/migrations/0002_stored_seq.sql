-- #7: stored envelopes must verify as stored.
-- The client-signed `sequence` is now preserved verbatim in the envelope;
-- relay ingest order moves to `stored_seq`, an UNSIGNED bookkeeping column
-- that no signature covers and no verifier reads.
ALTER TABLE messages ADD COLUMN stored_seq INTEGER;

-- Backfill: renumber per channel by (sequence, rowid) so ingest order is
-- collision-free even where the old MAX+1 race produced duplicates.
-- Legacy rows keep their relay-reassigned `sequence` (the originally signed
-- value is unrecoverable); new rows store the signed value there instead.
UPDATE messages SET stored_seq = (
  SELECT t.rn FROM (
    SELECT rowid AS rid,
           ROW_NUMBER() OVER (PARTITION BY channel ORDER BY sequence, rowid) AS rn
    FROM messages
  ) t WHERE t.rid = messages.rowid
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_stored_seq
  ON messages (channel, stored_seq);
