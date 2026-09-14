-- Public discovery only, independent of the privileged wake outbox. No backfill:
-- historical author timestamps are not evidence of relay arrival time.
CREATE TABLE public_recent_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  high_seq INTEGER NOT NULL DEFAULT 0 CHECK (high_seq BETWEEN 0 AND 9007199254740991)
);
INSERT INTO public_recent_state (id, epoch, started_at)
VALUES (1, lower(hex(randomblob(16))), CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER));

CREATE TABLE public_message_arrivals (
  arrival_seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK (arrival_seq <= 9007199254740991),
  envelope_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  stored_seq INTEGER NOT NULL,
  arrived_at INTEGER NOT NULL
);

-- Match the public reader predicates (0006). Only public arrivals advance this
-- counter; private/encrypted inserts must not reveal activity through its gaps.
CREATE TRIGGER public_message_arrival AFTER INSERT ON messages
WHEN NEW.encrypted = 0 AND NEW.type != 'e2ee_blob'
 AND NEW.nonce IS NULL AND NEW.ephemeral_public_key IS NULL AND NEW.recipient_keys_json IS NULL
 AND NEW.stored_seq BETWEEN 1 AND 9007199254740991 AND typeof(NEW.stored_seq) = 'integer'
 AND length(NEW.id) BETWEEN 1 AND 128 AND NEW.id NOT GLOB '*[^a-zA-Z0-9_:-]*' AND instr(NEW.id, char(0)) = 0
 AND EXISTS (SELECT 1 FROM channels WHERE name = NEW.channel
   AND is_private = 0 AND e2ee_required = 0 AND allowed_agents_json = '[]'
   AND length(name) BETWEEN 1 AND 128 AND name NOT GLOB '*[^a-z0-9_-]*' AND instr(name, char(0)) = 0
   AND name NOT GLOB 'dm-*' AND name NOT GLOB 'vault-*')
BEGIN
  INSERT INTO public_message_arrivals (envelope_id, channel, stored_seq, arrived_at)
  VALUES (NEW.id, NEW.channel, NEW.stored_seq, CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER));
  UPDATE public_recent_state SET high_seq = (SELECT MAX(arrival_seq) FROM public_message_arrivals) WHERE id = 1;
  -- At most 10,000 references, independent of reader traffic or a scheduler.
  -- Evict references only: never messages, identities, hooks or checkpoints.
  DELETE FROM public_message_arrivals WHERE arrival_seq <= (SELECT high_seq - 10000 FROM public_recent_state WHERE id = 1);
END;
