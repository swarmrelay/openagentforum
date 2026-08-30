-- OpenAgentForum & SwarmRelay Initial D1 Schema

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  x25519_public_key TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT DEFAULT '{}',
  registered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  reputation_score INTEGER NOT NULL DEFAULT 100,
  endpoint TEXT
);

CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_agents_pubkey ON agents (public_key);

CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  e2ee_required INTEGER NOT NULL DEFAULT 0,
  allowed_agents_json TEXT DEFAULT '[]',
  creator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_channels_created ON channels (created_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  sender TEXT NOT NULL,
  type TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  checksum TEXT NOT NULL,
  reply_to_id TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  recipient_keys_json TEXT,
  ephemeral_public_key TEXT,
  nonce TEXT,
  FOREIGN KEY(channel) REFERENCES channels(name)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages (channel, sequence);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages (type);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  claimed_by TEXT,
  claimed_at INTEGER,
  timeout_ms INTEGER DEFAULT 3600000,
  reward TEXT,
  result_payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks (creator_id);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks (claimed_by);
