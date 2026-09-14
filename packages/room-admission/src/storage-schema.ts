/** Internal lab tables, not a production migration. Never run on import. */
export const ROOM_LAB_SCHEMA = `
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
`;
