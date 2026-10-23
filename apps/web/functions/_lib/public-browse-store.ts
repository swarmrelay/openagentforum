import { verifyEnvelope, type MessageEnvelope } from '@openagentforum/protocol';

export const DIRECTORY_LIMIT = 25;
export const MESSAGE_LIMIT = 20;
export const PAYLOAD_LIMIT = 16_384;
export const CHANNEL_NAME = /^[a-z0-9_-]{1,128}$/;
export const MESSAGE_ID = /^[a-zA-Z0-9_:-]{1,128}$/;
export const AGENT_ID = /^agent_[a-f0-9]{16}$/;
// An author-timestamp/ID position in one agent's posts (#358), not a relay position.
export const POST_CURSOR = /^[0-9a-f]{16}:[a-zA-Z0-9_:-]{1,128}$/;

// Fail closed for ambiguous policy/metadata and old public dm/vault names.
// Partial indexes in migration 0006 use precisely these predicates.
export const PUBLIC_CHANNEL = `is_private = 0 AND e2ee_required = 0 AND allowed_agents_json = '[]'
  AND length(name) BETWEEN 1 AND 128 AND name NOT GLOB '*[^a-z0-9_-]*'
  AND instr(name, char(0)) = 0
  AND name NOT GLOB 'dm-*' AND name NOT GLOB 'vault-*'`;
export const PUBLIC_MESSAGE = `encrypted = 0 AND type != 'e2ee_blob'
  AND nonce IS NULL AND ephemeral_public_key IS NULL AND recipient_keys_json IS NULL
  AND stored_seq BETWEEN 1 AND 9007199254740991
  AND typeof(stored_seq) = 'integer'
  AND length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^a-zA-Z0-9_:-]*'
  AND instr(id, char(0)) = 0`;

// Signed-parent lookups (#358, #359). These MUST match migration 0012 term for
// term; INDEXED BY makes drift a query error instead of a silent scan.
export const PUBLIC_NAME = `length(channel) BETWEEN 1 AND 128 AND channel NOT GLOB '*[^a-z0-9_-]*'
  AND instr(channel, char(0)) = 0
  AND channel NOT GLOB 'dm-*' AND channel NOT GLOB 'vault-*'`;
export const SIGNED_PARENT = `(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inReplyTo') END)`;
export const HAS_PARENT = `instr(payload_json, '"inReplyTo"') > 0`;
// The idx_messages_public_author predicate on author timestamps (migration 0012).
export const POST_TIME = `typeof(timestamp) = 'integer' AND timestamp BETWEEN 0 AND 9007199254740991`;
// Channel flags live in another table, so index predicates cannot carry them.
// New plaintext cannot enter a private/E2EE channel (ingest requires
// encryption), so rows this rejects after the seek are finite legacy records.
export const visible = (column: string) => `EXISTS (SELECT 1 FROM channels WHERE name = ${column} AND ${PUBLIC_CHANNEL})`;

export type BrowseRoute =
  | { kind: 'directory'; after?: string }
  | { kind: 'channel'; channel: string; before?: number }
  | { kind: 'message'; channel: string; id: string; after?: ReplyCursor }
  | { kind: 'recent'; after?: RecentCursor; before?: RecentCursor }
  | { kind: 'replies'; agentId: string; before?: string };
export interface RecentCursor { epoch: string; position: number }
/** Exclusive (channel, relay position) cursor over one message's direct replies (#359). */
export interface ReplyCursor { channel: string; storedSeq: number }
export interface PublicChannel { name: string; title: string; topic: string }
export interface PublicRow {
  id: string; channel: string; sender: string; type: MessageEnvelope['type'];
  sequence: number; stored_seq: number; timestamp: number; payload_json: string;
  signature: string; checksum: string; reply_to_id: string | null; public_key: string | null;
  signed_text_complete: number | null; has_replies?: number | null; depth?: number;
}
export interface PublicMessage {
  id: string; channel: string; sender: string; type: string; sequence: number; storedSeq: number;
  timestamp: number; text: string; truncated: boolean; verified: boolean;
  signedParent?: string; unsignedParent?: string; hasReplies?: boolean;
  /** (#345) Hub facts about the signing key, read separately from the record. */
  senderActivity?: SenderActivity;
}
export interface SenderActivity { registeredAt: number | null; publicPosts: number; capped: boolean }
export interface ReplyThread<T> { post: T; replies: T[]; moreReplies: boolean }
export interface AgentReplies<T> { agentId: string; threads: ReplyThread<T>[]; scannedPosts: number; next?: string }
export interface BrowseData {
  channels: PublicChannel[]; channel?: PublicChannel; messages: PublicMessage[];
  nextChannel?: string; olderThan?: number;
  recent?: {
    entries: { message: PublicMessage; arrivedAt: number }[];
    next?: RecentCursor; resume: RecentCursor; startedAt: number;
  };
  replies?: AgentReplies<PublicMessage>;
  thread?: {
    /** Oldest first, ending with the direct parent. Each link is authenticated by the verified child. */
    ancestors: PublicMessage[]; ancestorsEnd: 'root' | 'limit' | 'unverified' | 'unavailable' | 'cycle';
    replies: PublicMessage[]; nextReplies?: ReplyCursor;
    /** Verified records shown on this page, per sender key, in order of first appearance. */
    participants: Array<{ sender: string; records: number }>;
  };
}
export const THREAD_ANCESTORS = 10;
export const THREAD_REPLIES = 20;
// Shared by HTML and Markdown so both describe the same bounds.
export const THREAD_SCOPE = `Replies are matched by each record's signed inReplyTo link; the unsigned legacy replyToId never counts. At most ${THREAD_REPLIES} direct replies per page, ordered by channel and then unsigned relay position. Earlier records follow verified parent links, at most ${THREAD_ANCESTORS} levels up.`;
export const THREAD_ENDS: Record<NonNullable<BrowseData['thread']>['ancestorsEnd'], string> = {
  root: '',
  limit: `Only the nearest ${THREAD_ANCESTORS} earlier records are shown. Open the oldest one to continue up the thread.`,
  unverified: 'The chain stops at a record that does not verify here, so its parent reference is not authenticated.',
  unavailable: 'The next parent is not a public record on this hub. It may be private, encrypted or absent.',
  cycle: 'The next parent is a record already shown above, so these reply links form a loop.',
};
export const PARTICIPANTS_NOTE = 'Verified records on this page, counted by signing key. This is not a ranking, endorsement or complete history of the thread.';

const CHANNEL_COLUMNS = 'name, substr(title, 1, 160) AS title, substr(topic, 1, 1000) AS topic';
// Cap database projections before buffering/parsing. A truncated signed payload
// is never verified as if it were the original record.
export const MESSAGE_COLUMNS = `m.id, m.channel, substr(m.sender, 1, 129) AS sender, substr(m.type, 1, 65) AS type,
  m.sequence, m.stored_seq, m.timestamp,
  CASE WHEN instr(m.payload_json, char(0)) = 0 THEN substr(m.payload_json, 1, ${PAYLOAD_LIMIT + 1}) ELSE NULL END AS payload_json,
  substr(m.signature, 1, 129) AS signature, substr(m.checksum, 1, 65) AS checksum,
  substr(m.reply_to_id, 1, 129) AS reply_to_id, substr(a.public_key, 1, 65) AS public_key,
  (instr(m.sender, char(0)) = 0 AND instr(m.type, char(0)) = 0 AND instr(m.signature, char(0)) = 0
    AND instr(m.checksum, char(0)) = 0 AND instr(a.public_key, char(0)) = 0) AS signed_text_complete`;

export async function readPublicBrowse(db: D1Database, route: Exclude<BrowseRoute, { kind: 'recent' | 'replies' }>): Promise<BrowseData | null> {
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
  // (#359) One LIMIT-1 seek per listed message: an ordinary link, never a count.
  const hasReplies = route.kind === 'channel' ? `, EXISTS (SELECT 1 FROM messages AS r INDEXED BY idx_messages_signed_parent
      WHERE ${SIGNED_PARENT} = +m.id AND ${PUBLIC_MESSAGE} AND ${PUBLIC_NAME} AND ${HAS_PARENT} AND ${visible('r.channel')}) AS has_replies` : '';
  const messages = db.prepare(`SELECT ${MESSAGE_COLUMNS}${hasReplies}
    FROM (SELECT name FROM channels WHERE name = ? AND ${PUBLIC_CHANNEL}) AS visible
    CROSS JOIN (SELECT * FROM messages ${route.kind === 'channel' ? 'INDEXED BY idx_messages_public_browse' : ''}
      WHERE channel = ? AND ${PUBLIC_MESSAGE}) AS m
    LEFT JOIN agents AS a ON a.agent_id = m.sender
    WHERE ${condition} AND m.channel = visible.name
    ORDER BY m.stored_seq DESC LIMIT ?`)
    .bind(route.channel, route.channel, route.kind === 'message' ? route.id : (route.before ?? Number.MAX_SAFE_INTEGER), route.kind === 'message' ? 1 : MESSAGE_LIMIT + 1);
  // CROSS JOIN keeps the singleton policy lookup outside the message loop.
  // EXISTS (even uncorrelated) can filter after traversing hidden history.
  // https://www.sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join
  // Both visibility and contents come from one atomic primary D1 batch. No
  // session replica, process cache, memory fallback, mutations or COUNT scans.
  const statements = [channel, messages];
  if (route.kind === 'message') {
    // (#359) Ancestors by signed parent: one primary-key step per level, at most
    // THREAD_ANCESTORS, and a hidden record ends the walk rather than being crossed.
    statements.push(db.prepare(`SELECT ${MESSAGE_COLUMNS}, chain.depth AS depth FROM (
        WITH RECURSIVE chain(parent_id, depth) AS (
          SELECT ${SIGNED_PARENT}, 1 FROM messages WHERE id = ? AND channel = ? AND ${PUBLIC_MESSAGE} AND ${HAS_PARENT}
          UNION ALL
          SELECT ${SIGNED_PARENT}, chain.depth + 1 FROM chain JOIN messages ON messages.id = chain.parent_id
            WHERE chain.depth < ? AND ${PUBLIC_MESSAGE} AND ${PUBLIC_NAME} AND ${HAS_PARENT} AND ${visible('messages.channel')}
        ) SELECT parent_id, depth FROM chain WHERE parent_id IS NOT NULL
      ) AS chain CROSS JOIN messages AS m LEFT JOIN agents AS a ON a.agent_id = m.sender
      WHERE m.id = chain.parent_id AND ${PUBLIC_MESSAGE} AND ${PUBLIC_NAME} AND ${visible('m.channel')}`)
      .bind(route.id, route.channel, THREAD_ANCESTORS));
    // Direct replies: one seek into the signed-parent index, in its own order,
    // continuing after an exclusive (channel, relay position) cursor.
    statements.push(db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages AS m INDEXED BY idx_messages_signed_parent
      LEFT JOIN agents AS a ON a.agent_id = m.sender
      WHERE ${SIGNED_PARENT} = ? AND ${PUBLIC_MESSAGE} AND ${PUBLIC_NAME} AND ${HAS_PARENT}
        AND (m.channel, m.stored_seq) > (?, ?) AND ${visible('m.channel')}
      ORDER BY m.channel, m.stored_seq LIMIT ?`)
      .bind(route.id, route.after?.channel ?? '', route.after?.storedSeq ?? 0, THREAD_REPLIES + 1));
  }
  const [channelResult, messageResult, ancestorResult, replyResult] = await db.batch<PublicChannel | PublicRow>(statements);
  if (!channelResult.success || !messageResult.success || (route.kind === 'message' && (!ancestorResult.success || !replyResult.success))) throw new Error('Public record read unavailable');
  if (!channelResult.results.length) return null;
  const selected = channelResult.results[0] as PublicChannel;
  const rows = messageResult.results as PublicRow[];
  if (route.kind === 'message' && !rows.length) return null;
  const page = rows.slice(0, MESSAGE_LIMIT);
  const presented = await Promise.all(page.reverse().map(async row => {
    const message = await presentMessage(row, route.kind === 'message' ? 6000 : 1500);
    return row.has_replies ? { ...message, hasReplies: true } : message;
  }));
  return {
    channels: [], channel: selected, messages: presented,
    ...(rows.length > MESSAGE_LIMIT ? { olderThan: page[0].stored_seq } : {}),
    ...(route.kind === 'message' ? { thread: await presentThread(presented[0], ancestorResult.results as PublicRow[], replyResult.results as PublicRow[]) } : {}),
  };
}

async function presentThread(target: PublicMessage, ancestorRows: PublicRow[], replyRows: PublicRow[]): Promise<NonNullable<BrowseData['thread']>> {
  // A parent link is authenticated only by its verified child, so the walk
  // stops at the first unverified record, a missing level or a repeated ID.
  const byDepth = new Map(ancestorRows.map(row => [row.depth!, row]));
  const ancestors: PublicMessage[] = [];
  const seen = new Set([target.id]);
  let child = target;
  let ancestorsEnd: NonNullable<BrowseData['thread']>['ancestorsEnd'] = 'root';
  while (child.signedParent) {
    if (!child.verified) { ancestorsEnd = 'unverified'; break; }
    if (ancestors.length >= THREAD_ANCESTORS) { ancestorsEnd = 'limit'; break; }
    if (seen.has(child.signedParent)) { ancestorsEnd = 'cycle'; break; }
    const row = byDepth.get(ancestors.length + 1);
    if (!row || row.id !== child.signedParent) { ancestorsEnd = 'unavailable'; break; }
    seen.add(row.id);
    child = await presentMessage(row, 1500);
    ancestors.push(child);
  }
  const page = replyRows.slice(0, THREAD_REPLIES);
  const replies = await Promise.all(page.map(row => presentMessage(row, 1500)));
  const counts = new Map<string, number>();
  for (const message of [...ancestors.slice().reverse(), target, ...replies]) {
    if (message.verified) counts.set(message.sender, (counts.get(message.sender) ?? 0) + 1);
  }
  return { ancestors: ancestors.reverse(), ancestorsEnd, replies,
    participants: [...counts].map(([sender, records]) => ({ sender, records })),
    ...(replyRows.length > THREAD_REPLIES ? { nextReplies: { channel: page.at(-1)!.channel, storedSeq: page.at(-1)!.stored_seq } } : {}) };
}

export async function presentMessage(row: PublicRow, textLimit: number): Promise<PublicMessage> {
  const base = { id: row.id, channel: row.channel, sender: row.sender, type: row.type,
    sequence: row.sequence, storedSeq: row.stored_seq, timestamp: row.timestamp };
  const omitted = { ...base, text: 'Payload omitted from this bounded view. Fetch the source record and verify it independently.', truncated: true, verified: false };
  if (typeof row.payload_json !== 'string' || row.payload_json.length > PAYLOAD_LIMIT) return omitted;
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { return omitted; }
  const envelope = { id: row.id, channel: row.channel, sender: row.sender, type: row.type,
    sequence: row.sequence, timestamp: row.timestamp, payload, signature: row.signature, checksum: row.checksum };
  const verified = Boolean(row.signed_text_complete === 1 && row.type.length <= 64 && row.public_key && /^[a-fA-F0-9]{64}$/.test(row.public_key)
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
