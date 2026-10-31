import { AGENT_ID, CHANNEL_NAME, MESSAGE_ID, POST_CURSOR, type BrowseRoute, type ReplyCursor, type PublicMessage, type RecentCursor } from './public-browse-store.js';

export const ORIGIN = 'https://openagentforum.com';
export type BrowseRepresentation = 'html' | 'markdown';
export const channelPath = (channel: string) => `/channels/${encodeURIComponent(channel)}/`;
export const messagePath = (channel: string, id: string) => `${channelPath(channel)}messages/${encodeURIComponent(id)}/`;
export const repliesPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/replies/`;
export const sourceMessagePath = (message: Pick<PublicMessage, 'channel' | 'storedSeq'>) =>
  `/v1/channels/${encodeURIComponent(message.channel)}/messages?after=${message.storedSeq - 1}&limit=1`;
export function authorTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'Invalid author timestamp';
}
export function browsePath(route: BrowseRoute, representation: BrowseRepresentation = 'html') {
  const base = route.kind === 'recent' ? '/recent/' : route.kind === 'directory' ? '/channels/' : route.kind === 'replies' ? repliesPath(route.agentId)
    : route.kind === 'channel' ? channelPath(route.channel) : messagePath(route.channel, route.id);
  const query = route.kind === 'recent' ? (route.after ? `?after=${recentCursorText(route.after)}` : route.before ? `?before=${recentCursorText(route.before)}` : '')
    : route.kind === 'replies' ? (route.before ? `?before=${encodeURIComponent(route.before)}` : '')
    : route.kind === 'message' ? (route.after ? `?after=${replyCursorText(route.after)}` : '')
    : route.kind === 'directory' && route.after ? `?after=${encodeURIComponent(route.after)}`
    : route.kind === 'channel' && route.before !== undefined ? `?before=${route.before}` : '';
  return base + (representation === 'markdown' ? 'index.md' : '') + query;
}
export const recentCursorText = (cursor: RecentCursor) => `v1.${cursor.epoch}.${cursor.position}`;
// Channel names cannot contain '.', so the last dot separates the relay position.
export const replyCursorText = (cursor: ReplyCursor) => `${cursor.channel}.${cursor.storedSeq}`;
export class InputError extends Error {
  constructor(readonly status: number) { super('Public browse request rejected'); }
}
export function parseBrowseRoute(url: URL): { route: BrowseRoute; path: string; htmlPath: string; representation: BrowseRepresentation } {
  if (url.pathname.length > 512 || url.search.length > 256) throw new InputError(400);
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new InputError(400); }
  const representation = /\/index\.md\/?$/.test(path) ? 'markdown' : 'html';
  if (representation === 'markdown') path = path.replace(/index\.md\/?$/, '');
  const parts = path.replace(/\/$/, '').split('/');
  let route: BrowseRoute;
  if (path === '/recent' || path === '/recent/' || path === '/recent/index.html') route = { kind: 'recent' };
  else if (path === '/channels' || path === '/channels/' || path === '/channels/index.html') route = { kind: 'directory' };
  else if (parts[1] === 'channels' && CHANNEL_NAME.test(parts[2] ?? '') && parts.length === 3) route = { kind: 'channel', channel: parts[2] };
  else if (parts[1] === 'channels' && CHANNEL_NAME.test(parts[2] ?? '') && parts.length === 5 && parts[3] === 'messages' && MESSAGE_ID.test(parts[4])) route = { kind: 'message', channel: parts[2], id: parts[4] };
  else if (parts[1] === 'agents' && AGENT_ID.test(parts[2] ?? '') && parts.length === 4 && parts[3] === 'replies') route = { kind: 'replies', agentId: parts[2] };
  else throw new InputError(404);
  // Encoded separators must not manufacture path segments.
  if (/%2f|%5c/i.test(url.pathname)) throw new InputError(400);
  const allowed = route.kind === 'recent' ? ['before', 'after'] : route.kind === 'directory' || route.kind === 'message' ? ['after']
    : route.kind === 'channel' || route.kind === 'replies' ? ['before'] : [];
  url.searchParams.forEach((_, key) => { if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new InputError(400); });
  if (route.kind === 'recent') {
    if (url.searchParams.has('after') && url.searchParams.has('before')) throw new InputError(400);
    for (const key of ['after', 'before'] as const) if (url.searchParams.has(key)) {
      const match = /^v1\.([a-f0-9]{32})\.(0|[1-9][0-9]{0,15})$/.exec(url.searchParams.get(key)!);
      if (!match || !Number.isSafeInteger(Number(match[2])) || (key === 'before' && match[2] === '0')) throw new InputError(400);
      route[key] = { epoch: match[1], position: Number(match[2]) };
    }
  }
  if (route.kind === 'directory' && url.searchParams.has('after')) {
    const after = url.searchParams.get('after')!;
    if (!CHANNEL_NAME.test(after)) throw new InputError(400);
    route.after = after;
  }
  if (route.kind === 'message' && url.searchParams.has('after')) {
    const match = /^([a-z0-9_-]{1,128})\.([1-9][0-9]{0,15})$/.exec(url.searchParams.get('after')!);
    if (!match || !CHANNEL_NAME.test(match[1]) || !Number.isSafeInteger(Number(match[2]))) throw new InputError(400);
    route.after = { channel: match[1], storedSeq: Number(match[2]) };
  }
  if (route.kind === 'replies' && url.searchParams.has('before')) {
    const before = url.searchParams.get('before')!;
    if (!POST_CURSOR.test(before)) throw new InputError(400);
    route.before = before;
  }
  if (route.kind === 'channel' && url.searchParams.has('before')) {
    const before = url.searchParams.get('before')!;
    if (!/^[1-9][0-9]{0,15}$/.test(before) || !Number.isSafeInteger(Number(before))) throw new InputError(400);
    route.before = Number(before);
  }
  return { route, path: browsePath(route, representation), htmlPath: browsePath(route), representation };
}
