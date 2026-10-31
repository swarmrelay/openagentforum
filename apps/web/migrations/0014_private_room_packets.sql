-- Private-room encrypted packet sessions, stored packets, usage windows and commit guard (#162).
CREATE TABLE IF NOT EXISTS room_lab_packet_meta (
  id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL,
  hub TEXT NOT NULL, protocol TEXT NOT NULL, policy TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS room_lab_packet_sessions (
  room_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
  owner_key TEXT NOT NULL, peer_key TEXT NOT NULL, created_at INTEGER NOT NULL,
  stage INTEGER NOT NULL CHECK(stage BETWEEN 1 AND 4),
  owner_next INTEGER NOT NULL CHECK(owner_next BETWEEN 1 AND 1026),
  peer_next INTEGER NOT NULL CHECK(peer_next BETWEEN 0 AND 1026),
  PRIMARY KEY(room_id, session_id)
) STRICT;

CREATE TABLE IF NOT EXISTS room_lab_packets (
  room_id TEXT NOT NULL, stored_seq INTEGER NOT NULL CHECK(stored_seq > 0),
  signing_key TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL,
  session_id TEXT NOT NULL, packet_index INTEGER NOT NULL,
  wire TEXT NOT NULL CHECK(length(CAST(wire AS BLOB)) <= 36864),
  receipt_json TEXT NOT NULL CHECK(length(CAST(receipt_json AS BLOB)) <= 2048),
  PRIMARY KEY(room_id, stored_seq), UNIQUE(signing_key, request_id),
  UNIQUE(room_id, session_id, signing_key, packet_index)
) STRICT;

CREATE TABLE IF NOT EXISTS room_lab_packet_usage (
  scope TEXT PRIMARY KEY, packets INTEGER NOT NULL CHECK(packets >= 0),
  bytes INTEGER NOT NULL CHECK(bytes >= 0), sessions INTEGER NOT NULL CHECK(sessions >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS room_lab_packet_windows (
  scope TEXT NOT NULL, bucket INTEGER NOT NULL,
  packets INTEGER NOT NULL CHECK(packets >= 0), bytes INTEGER NOT NULL CHECK(bytes >= 0),
  sessions INTEGER NOT NULL CHECK(sessions >= 0), PRIMARY KEY(scope, bucket)
) STRICT;

CREATE INDEX IF NOT EXISTS room_lab_packet_window_bucket ON room_lab_packet_windows(bucket);

CREATE TABLE IF NOT EXISTS room_lab_d1_packet_gate (
  id INTEGER PRIMARY KEY CHECK(id = 1), mode TEXT NOT NULL, at_ms INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, session_expires INTEGER, window_ms INTEGER NOT NULL, bucket INTEGER NOT NULL,
  stored_seq INTEGER NOT NULL, receipt_json TEXT NOT NULL, bytes INTEGER NOT NULL, new_session INTEGER NOT NULL,
  valid INTEGER NOT NULL DEFAULT 1 CHECK(valid = 1)
) STRICT;

INSERT INTO room_lab_packet_meta VALUES (
  1, 1, 'https://openagentforum.com', 'oaf-room-packet-v1-draft1',
  '{"agent":{"bytes":33554432,"bytesPerWindow":16777216,"packets":10000,"packetsPerWindow":2048,"sessions":200,"sessionsPerWindow":40},"hub":{"bytes":67108864,"bytesPerWindow":33554432,"packets":100000,"packetsPerWindow":20000,"sessions":5000,"sessionsPerWindow":1000},"room":{"bytes":16777216,"bytesPerWindow":8388608,"packets":2048,"packetsPerWindow":1024,"sessions":64,"sessionsPerWindow":16},"windowMs":3600000}'
);

CREATE TRIGGER IF NOT EXISTS room_lab_d1_packet_finish BEFORE DELETE ON room_lab_d1_packet_gate
WHEN OLD.mode IN ('apply', 'replay') BEGIN
  SELECT CASE WHEN max(CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER), OLD.at_ms, (SELECT clock FROM room_lab_meta WHERE id = 1)) >= OLD.expires_at
    THEN RAISE(ABORT, 'packet proof expired at commit guard') END;
  SELECT CASE WHEN OLD.mode = 'apply' AND (OLD.session_expires IS NULL OR
    max(CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER), OLD.at_ms, (SELECT clock FROM room_lab_meta WHERE id = 1)) >= OLD.session_expires)
    THEN RAISE(ABORT, 'packet session expired at commit guard') END;
  SELECT CASE WHEN OLD.mode = 'apply' AND CAST(max(CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER), OLD.at_ms,
    (SELECT clock FROM room_lab_meta WHERE id = 1)) / OLD.window_ms AS INTEGER) != OLD.bucket
    THEN RAISE(ABORT, 'packet accounting window changed') END;
  UPDATE room_lab_meta SET clock = max(clock, OLD.at_ms, CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER)) WHERE id = 1;
END;
