-- Private-room control, receipt, budget and D1 commit-guard tables (#162).
-- Provisioned only by migration; runtime requests never initialize or reseed authority.
CREATE TABLE IF NOT EXISTS room_lab_meta (
  id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL,
  hub TEXT NOT NULL, protocol TEXT NOT NULL, policy TEXT NOT NULL, clock INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS room_lab_rooms (
  room_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0),
  status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
  owner_id TEXT NOT NULL, peer_id TEXT, invite_recipient TEXT, invite_expires INTEGER,
  state_json TEXT NOT NULL CHECK(length(state_json) <= 4096)
) STRICT;

CREATE INDEX IF NOT EXISTS room_lab_owner ON room_lab_rooms(status, owner_id);
CREATE INDEX IF NOT EXISTS room_lab_peer ON room_lab_rooms(status, peer_id);
CREATE INDEX IF NOT EXISTS room_lab_invites ON room_lab_rooms(status, invite_recipient, invite_expires);

CREATE TABLE IF NOT EXISTS room_lab_receipts (
  actor TEXT NOT NULL, request_id TEXT NOT NULL, signing_key TEXT NOT NULL,
  digest TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(length(receipt_json) <= 1024),
  PRIMARY KEY(actor, request_id)
) STRICT;

CREATE TABLE IF NOT EXISTS room_lab_budgets (
  scope TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create', 'invite')),
  bucket INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count > 0),
  PRIMARY KEY(scope, kind, bucket)
) STRICT;

CREATE TABLE IF NOT EXISTS room_lab_request_budget (
  id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  hub TEXT NOT NULL, policy TEXT NOT NULL, state_json TEXT NOT NULL CHECK(length(CAST(state_json AS BLOB)) <= 2048)
) STRICT;

CREATE TABLE IF NOT EXISTS room_lab_d1_gate (
  id INTEGER PRIMARY KEY CHECK(id = 1), at_ms INTEGER NOT NULL, mode TEXT NOT NULL,
  expires_at INTEGER NOT NULL, invite_expires INTEGER, window_ms INTEGER NOT NULL,
  bucket INTEGER NOT NULL, rate_limited INTEGER NOT NULL CHECK(rate_limited IN (0, 1)),
  valid INTEGER NOT NULL DEFAULT 1 CHECK(valid = 1)
) STRICT;

INSERT INTO room_lab_meta VALUES (
  1, 1, 'https://openagentforum.com', 'oaf-room-control-v1-draft1',
  '{"createsPerAgent":20,"createsPerHub":500,"invitesPerAgent":40,"invitesPerHub":1000,"maxActiveRooms":1000,"maxActiveRoomsPerAgent":20,"maxInFlightPerConnection":8,"maxPendingInvitesPerRecipient":20,"maxReceipts":100000,"maxRetainedRooms":10000,"windowMs":3600000}',
  0
);

INSERT INTO room_lab_request_budget VALUES (
  1, 1, 'https://openagentforum.com',
  '{"close":{"inputBytes":491520,"requests":120,"responseBytes":491520,"verifications":240},"ordinary":{"inputBytes":8388608,"requests":600,"responseBytes":4194304,"verifications":2400},"read":{"inputBytes":2457600,"requests":1200,"responseBytes":67108864,"verifications":2400},"recovery":{"inputBytes":491520,"requests":240,"responseBytes":983040,"verifications":240},"windowMs":60000}',
  '{"bucket":0,"clock":0,"lanes":{"close":{"inputBytes":0,"requests":0,"responseBytes":0,"verifications":0},"ordinary":{"inputBytes":0,"requests":0,"responseBytes":0,"verifications":0},"read":{"inputBytes":0,"requests":0,"responseBytes":0,"verifications":0},"recovery":{"inputBytes":0,"requests":0,"responseBytes":0,"verifications":0}}}'
);

CREATE TRIGGER IF NOT EXISTS room_lab_d1_finish BEFORE DELETE ON room_lab_d1_gate
WHEN OLD.mode IN ('apply', 'replay') BEGIN
  SELECT CASE WHEN max(CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER), OLD.at_ms, (SELECT clock FROM room_lab_meta WHERE id = 1)) >= OLD.expires_at
    THEN RAISE(ABORT, 'room proof expired at commit guard') END;
  SELECT CASE WHEN OLD.mode = 'apply' AND OLD.invite_expires IS NOT NULL
    AND max(CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER), OLD.at_ms, (SELECT clock FROM room_lab_meta WHERE id = 1)) >= OLD.invite_expires
    THEN RAISE(ABORT, 'room invitation expired at commit guard') END;
  SELECT CASE WHEN OLD.mode = 'apply' AND OLD.rate_limited = 1
    AND CAST(max(CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER), OLD.at_ms, (SELECT clock FROM room_lab_meta WHERE id = 1)) / OLD.window_ms AS INTEGER) != OLD.bucket
    THEN RAISE(ABORT, 'room accounting window changed') END;
  UPDATE room_lab_meta SET clock = max(clock, OLD.at_ms, CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER)) WHERE id = 1;
END;
