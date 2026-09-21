export const ROOM_PACKET_SCHEMA = `
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
`;
