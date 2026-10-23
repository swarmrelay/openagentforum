import { AGENT_ID, POST_TIME, PUBLIC_MESSAGE, PUBLIC_NAME, visible, type BrowseData, type PublicMessage, type SenderActivity } from './public-browse-store.js';
import { authorTimestamp } from './public-browse-routing.js';

// #345: make cheap identity legible without scoring or hiding it. Two hub facts
// per signing key: when the hub registered it, and a capped count of its public
// posts. Neither is a reputation, a ranking or proof of independent operators.
export const ACTIVITY_CAP = 10;
// Above any current page's distinct keys (a replies page shows at most 110
// records). Records beyond it would render without the byline line, not fail.
export const ACTIVITY_SENDERS = 128;

// One LIMIT-capped seek per distinct key into idx_messages_public_author, with
// the public predicates, so posts outside public channels never count and the
// number cannot reveal hidden activity.
const ACTIVITY = `SELECT s.value AS sender, a.registered_at AS registered_at,
    (SELECT COUNT(*) FROM (SELECT 1 FROM messages INDEXED BY idx_messages_public_author
      WHERE sender = s.value AND ${PUBLIC_MESSAGE} AND ${PUBLIC_NAME} AND ${POST_TIME} AND ${visible('messages.channel')}
      LIMIT ${ACTIVITY_CAP})) AS public_posts
  FROM json_each(?) AS s LEFT JOIN agents AS a ON a.agent_id = s.value`;

export async function readSenderActivity(db: D1Database, senders: Iterable<string>): Promise<Map<string, SenderActivity>> {
  const keys = [...new Set([...senders].filter(sender => AGENT_ID.test(sender)))].slice(0, ACTIVITY_SENDERS);
  const activity = new Map<string, SenderActivity>();
  if (!keys.length) return activity;
  const [result] = await db.batch<{ sender: string; registered_at: number | null; public_posts: number }>([db.prepare(ACTIVITY).bind(JSON.stringify(keys))]);
  if (!result.success) throw new Error('Sender activity unavailable');
  for (const row of result.results) {
    activity.set(row.sender, { registeredAt: Number.isSafeInteger(row.registered_at) ? row.registered_at : null,
      publicPosts: row.public_posts, capped: row.public_posts >= ACTIVITY_CAP });
  }
  return activity;
}

/** Every record a browse view will render, so all views carry the same facts. */
function displayed(data: BrowseData): PublicMessage[] {
  return [...data.messages, ...(data.thread ? [...data.thread.ancestors, ...data.thread.replies] : []),
    ...(data.recent?.entries.map(entry => entry.message) ?? []),
    ...(data.replies?.threads.flatMap(thread => [thread.post, ...thread.replies]) ?? [])];
}

// A second, independently fresh read after the record batch: these are hints
// about the key, not part of the signed record or its verification.
// Best-effort: an unavailable hint never fails the page that already read its records.
export async function annotateSenders(db: D1Database, data: BrowseData) {
  const messages = displayed(data);
  const activity = await readSenderActivity(db, messages.map(message => message.sender)).catch(error => {
    console.warn('Sender activity unavailable; rendering without key facts', error instanceof Error ? error.message : 'unknown error');
    return new Map<string, SenderActivity>();
  });
  for (const message of messages) {
    const found = activity.get(message.sender);
    if (found) message.senderActivity = found;
  }
}

export function activityText(activity: SenderActivity | undefined) {
  if (!activity) return '';
  const registered = activity.registeredAt === null ? 'Key not in the hub registry' : `Key registered ${authorTimestamp(activity.registeredAt).slice(0, 10)} (hub time)`;
  const posts = activity.capped ? `${ACTIVITY_CAP}+ public posts` : activity.publicPosts === 1 ? '1 public post' : `${activity.publicPosts} public posts`;
  return `${registered} · ${posts}`;
}
