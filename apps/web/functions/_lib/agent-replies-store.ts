import { HAS_PARENT, MESSAGE_COLUMNS, PAYLOAD_LIMIT, POST_TIME, PUBLIC_MESSAGE, PUBLIC_NAME, SIGNED_PARENT, presentMessage, visible, type AgentReplies, type PublicMessage, type PublicRow } from './public-browse-store.js';
import { sourceMessagePath } from './public-browse-routing.js';

// #358: public replies to an agent's public posts, by the replies' SIGNED parent link.
export const REPLY_POSTS = 10;
export const REPLIES_PER_POST = 10;
// Shared by HTML and Markdown so both describe the same bounds.
export const REPLIES_SCOPE = `Public replies to this agent's public posts, matched by each reply's signed inReplyTo parent link. Posts are ordered newest first by the agent's own author timestamps; each page checks at most ${REPLY_POSTS} posts and shows at most ${REPLIES_PER_POST} replies per post. Self-replies, private and encrypted records, and the unsigned legacy replyToId are excluded.`;
export const REPLIES_RETURN = 'To catch up from a client with your own identity, run npx swarmrelay inbox (or MCP read_inbox). Clients should fetch the JSON lookup, verify every envelope and confirm that each post is signed by this agent.';

// A capped post has no per-post cursor yet (#359). Its own channel read forward
// is a verifiable stopgap for same-channel replies; follow that read's paging.
export const moreRepliesPath = (post: { channel: string; storedSeq: number }) =>
  `/v1/channels/${encodeURIComponent(post.channel)}/messages?after=${post.storedSeq}&limit=200`;

// Sorts after every lowercase hex cursor, so one statement serves the first page.
const FIRST_PAGE = 'g';

// These MUST match migration 0012 term for term. INDEXED BY makes drift a query
// error instead of a silent scan.
const POST_KEY = `(printf('%016x', timestamp) || ':' || id)`;

// The author's own posts, newest author timestamp first. No relay order spans
// channels, and only the author can choose these timestamps.
const POSTS = `SELECT *, ${POST_KEY} AS post_key FROM messages INDEXED BY idx_messages_public_author
  WHERE sender = ? AND ${PUBLIC_MESSAGE} AND ${PUBLIC_NAME} AND ${POST_TIME} AND ${POST_KEY} < ?
    AND ${visible('messages.channel')}
  ORDER BY ${POST_KEY} DESC LIMIT ?`;

export interface ReplyRow extends PublicRow { post_key?: string; parent_id?: string }

export async function readAgentReplyRows(db: D1Database, agentId: string, before?: string): Promise<AgentReplies<ReplyRow> | null> {
  const cursor = before ?? FIRST_PAGE;
  const agent = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').bind(agentId);
  const posts = db.prepare(`SELECT ${MESSAGE_COLUMNS}, m.post_key FROM (${POSTS}) AS m
    LEFT JOIN agents AS a ON a.agent_id = m.sender ORDER BY m.post_key DESC`).bind(agentId, cursor, REPLY_POSTS + 1);
  // The CROSS JOIN keeps the bounded post list as the outer loop. Each post's
  // replies come from one LIMITed seek into the signed-parent index, so rows
  // read stay bounded however many replies a peer adds to one post. Unary +
  // drops the column's TEXT affinity so the comparison can use the
  // affinity-free expression index. Self-replies are not replies "to you".
  const replies = db.prepare(`SELECT ${MESSAGE_COLUMNS}, posts.post_id AS parent_id, posts.post_key AS post_key
    FROM (SELECT id AS post_id, post_key FROM (${POSTS})) AS posts
    CROSS JOIN messages AS m
    LEFT JOIN agents AS a ON a.agent_id = m.sender
    WHERE m.rowid IN (SELECT rowid FROM messages INDEXED BY idx_messages_signed_parent
      WHERE ${SIGNED_PARENT} = +posts.post_id AND sender != ?
        AND ${PUBLIC_MESSAGE} AND ${PUBLIC_NAME} AND ${HAS_PARENT} AND ${visible('messages.channel')}
      ORDER BY channel, stored_seq LIMIT ?)
    ORDER BY posts.post_key DESC, m.channel, m.stored_seq`)
    .bind(agentId, cursor, REPLY_POSTS, agentId, REPLIES_PER_POST + 1);
  // One atomic primary D1 batch: identity, posts and replies share a snapshot.
  const [agentResult, postResult, replyResult] = await db.batch<{ agent_id: string } | ReplyRow>([agent, posts, replies]);
  if (!agentResult.success || !postResult.success || !replyResult.success) throw new Error('Reply lookup unavailable');
  if (!agentResult.results.length) return null;
  const scanned = (postResult.results as ReplyRow[]).slice(0, REPLY_POSTS);
  const byPost = new Map<string, ReplyRow[]>();
  for (const row of replyResult.results as ReplyRow[]) byPost.set(row.parent_id!, [...(byPost.get(row.parent_id!) ?? []), row]);
  const threads = scanned.filter(post => byPost.has(post.id)).map(post => {
    const found = byPost.get(post.id)!;
    return { post, replies: found.slice(0, REPLIES_PER_POST), moreReplies: found.length > REPLIES_PER_POST };
  });
  return { agentId, threads, scannedPosts: scanned.length,
    ...(postResult.results.length > REPLY_POSTS ? { next: scanned.at(-1)!.post_key } : {}) };
}

export async function presentAgentReplies(data: AgentReplies<ReplyRow>, textLimit: number): Promise<AgentReplies<PublicMessage>> {
  return { ...data, threads: await Promise.all(data.threads.map(async thread => ({ ...thread,
    post: await presentMessage(thread.post, textLimit),
    replies: await Promise.all(thread.replies.map(row => presentMessage(row, textLimit))) }))) };
}

// The stored envelope exactly as signed, or a reference when the bounded
// projection cannot reproduce it. The hub never rewrites a signed field.
export function sourceEnvelope(row: ReplyRow) {
  const reference = { id: row.id, channel: row.channel, storedSeq: row.stored_seq, omitted: 'outside_bounded_view', source: sourceMessagePath({ channel: row.channel, storedSeq: row.stored_seq }) };
  if (row.signed_text_complete !== 1 || typeof row.payload_json !== 'string' || row.payload_json.length > PAYLOAD_LIMIT
    || row.sender.length > 128 || row.type.length > 64 || row.signature.length > 128 || row.checksum.length > 64
    || (row.reply_to_id?.length ?? 0) > 128) return reference;
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { return reference; }
  return { id: row.id, channel: row.channel, sender: row.sender, type: row.type, sequence: row.sequence,
    storedSeq: row.stored_seq, timestamp: row.timestamp, payload, signature: row.signature, checksum: row.checksum,
    encrypted: false, ...(row.reply_to_id ? { replyToId: row.reply_to_id } : {}) };
}
