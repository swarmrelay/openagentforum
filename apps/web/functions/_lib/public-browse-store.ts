import { verifyEnvelope, type MessageEnvelope } from '@openagentforum/protocol';

export const DIRECTORY_LIMIT = 25;
export const MESSAGE_LIMIT = 20;
export const PAYLOAD_LIMIT = 16_384;
export const CHANNEL_NAME = /^[a-z0-9_-]{1,128}$/;
export const MESSAGE_ID = /^[a-zA-Z0-9_:-]{1,128}$/;

// Fail closed for ambiguous policy/metadata and old public dm/vault names.
// Partial indexes in migration 0006 use precisely these predicates.
export const PUBLIC_CHANNEL = `is_private = 0 AND e2ee_required = 0 AND allowed_agents_json = '[]'
  AND length(name) BETWEEN 1 AND 128 AND name NOT GLOB '*[^a-z0-9_-]*'
  AND name NOT GLOB 'dm-*' AND name NOT GLOB 'vault-*'`;
export const PUBLIC_MESSAGE = `encrypted = 0 AND type != 'e2ee_blob'
  AND nonce IS NULL AND ephemeral_public_key IS NULL AND recipient_keys_json IS NULL
  AND stored_seq BETWEEN 1 AND 9007199254740991
  AND length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^a-zA-Z0-9_:-]*'`;

export type BrowseRoute =
  | { kind: 'directory'; after?: string }
  | { kind: 'channel'; channel: string; before?: number }
  | { kind: 'message'; channel: string; id: string };
export interface PublicChannel { name: string; title: string; topic: string }
interface PublicRow {
  id: string; channel: string; sender: string; type: MessageEnvelope['type'];
  sequence: number; stored_seq: number; timestamp: number; payload_json: string;
  signature: string; checksum: string; reply_to_id: string | null; public_key: string | null;
}
export interface PublicMessage {
  id: string; channel: string; sender: string; type: string; sequence: number; storedSeq: number;
  timestamp: number; text: string; truncated: boolean; verified: boolean;
  signedParent?: string; unsignedParent?: string;
}
export interface BrowseData {
  channels: PublicChannel[]; channel?: PublicChannel; messages: PublicMessage[];
  nextChannel?: string; olderThan?: number;
}

const CHANNEL_COLUMNS = 'name, substr(title, 1, 160) AS title, substr(topic, 1, 1000) AS topic';
// Cap database projections before buffering/parsing. A truncated signed payload
// is never verified as if it were the original record.
const MESSAGE_COLUMNS = `m.id, m.channel, substr(m.sender, 1, 129) AS sender, substr(m.type, 1, 65) AS type,
  m.sequence, m.stored_seq, m.timestamp, substr(m.payload_json, 1, ${PAYLOAD_LIMIT + 1}) AS payload_json,
  substr(m.signature, 1, 129) AS signature, substr(m.checksum, 1, 65) AS checksum,
  substr(m.reply_to_id, 1, 129) AS reply_to_id, substr(a.public_key, 1, 65) AS public_key`;

export async function readPublicBrowse(db: D1Database, route: BrowseRoute): Promise<BrowseData | null> {
  if (route.kind === 'directory') {
    const result = await db.prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels INDEXED BY idx_channels_public_browse
      WHERE ${PUBLIC_CHANNEL} AND name > ? ORDER BY name ASC LIMIT ?`)
      .bind(route.after ?? '', DIRECTORY_LIMIT + 1).all<PublicChannel>();
    if (!result.success) throw new Error('Public directory read unavailable');
    const channels = result.results.slice(0, DIRECTORY_LIMIT);
    return { channels, messages: [], ...(result.results.length > DIRECTORY_LIMIT ? { nextChannel: channels.at(-1)!.name } : {}) };
  }
  const channel = db.prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE name = ? AND ${PUBLIC_CHANNEL}`).bind(route.channel);
  const condition = route.kind === 'message' ? 'm.id = ?' : `m.stored_seq ${route.before === undefined ? '<=' : '<'} ?`;
  const messages = db.prepare(`SELECT ${MESSAGE_COLUMNS}
    FROM (SELECT * FROM messages ${route.kind === 'channel' ? 'INDEXED BY idx_messages_public_browse' : ''}
      WHERE channel = ? AND ${PUBLIC_MESSAGE}) AS m
    LEFT JOIN agents AS a ON a.agent_id = m.sender
    WHERE ${condition} AND EXISTS (SELECT 1 FROM channels WHERE name = m.channel AND ${PUBLIC_CHANNEL})
    ORDER BY m.stored_seq DESC LIMIT ?`)
    .bind(route.channel, route.kind === 'message' ? route.id : (route.before ?? Number.MAX_SAFE_INTEGER), route.kind === 'message' ? 1 : MESSAGE_LIMIT + 1);
  // Both visibility and contents come from one atomic primary D1 batch. No
  // session replica, process cache, memory fallback, mutations or COUNT scans.
  const [channelResult, messageResult] = await db.batch<PublicChannel | PublicRow>([channel, messages]);
  if (!channelResult.success || !messageResult.success) throw new Error('Public record read unavailable');
  if (!channelResult.results.length) return null;
  const selected = channelResult.results[0] as PublicChannel;
  const rows = messageResult.results as PublicRow[];
  if (route.kind === 'message' && !rows.length) return null;
  const page = rows.slice(0, MESSAGE_LIMIT);
  return {
    channels: [], channel: selected,
    messages: await Promise.all(page.reverse().map(row => presentMessage(row, route.kind === 'message' ? 6000 : 1500))),
    ...(rows.length > MESSAGE_LIMIT ? { olderThan: page[0].stored_seq } : {}),
  };
}

async function presentMessage(row: PublicRow, textLimit: number): Promise<PublicMessage> {
  const base = { id: row.id, channel: row.channel, sender: row.sender, type: row.type,
    sequence: row.sequence, storedSeq: row.stored_seq, timestamp: row.timestamp };
  const omitted = { ...base, text: 'Payload omitted from this bounded view. Fetch the source record and verify it independently.', truncated: true, verified: false };
  if (typeof row.payload_json !== 'string' || row.payload_json.length > PAYLOAD_LIMIT) return omitted;
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { return omitted; }
  const envelope = { id: row.id, channel: row.channel, sender: row.sender, type: row.type,
    sequence: row.sequence, timestamp: row.timestamp, payload, signature: row.signature, checksum: row.checksum };
  const verified = Boolean(row.type.length <= 64 && row.public_key && /^[a-fA-F0-9]{64}$/.test(row.public_key)
    && /^[a-fA-F0-9]{128}$/.test(row.signature) && /^[a-fA-F0-9]{64}$/.test(row.checksum)
    && (await verifyEnvelope(envelope, row.public_key)).valid);
  const object = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  let content: string;
  try {
    content = typeof payload === 'string' ? payload
      : typeof object?.message === 'string' ? object.message : JSON.stringify(payload);
  } catch { return omitted; }
  const parent = object?.inReplyTo;
  return { ...base, text: content.slice(0, textLimit), truncated: content.length > textLimit, verified,
    ...(typeof parent === 'string' && MESSAGE_ID.test(parent) ? { signedParent: parent } : {}),
    ...(row.reply_to_id && MESSAGE_ID.test(row.reply_to_id) ? { unsignedParent: row.reply_to_id } : {}) };
}
