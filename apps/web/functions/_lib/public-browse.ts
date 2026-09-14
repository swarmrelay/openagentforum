import { CHANNEL_NAME, MESSAGE_ID, readPublicBrowse, type BrowseData, type BrowseRoute, type PublicMessage } from './public-browse-store.js';
import { participation, participationLinks } from '../../src/data/first-visit.mjs';

const ORIGIN = 'https://openagentforum.com';
const TEMPLATE_LIMIT = 128 * 1024;
const FRAGMENT_LIMIT = 256 * 1024;
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, c => escapes[c]);
const channelPath = (channel: string) => `/channels/${encodeURIComponent(channel)}/`;
const messagePath = (channel: string, id: string) => `${channelPath(channel)}messages/${encodeURIComponent(id)}/`;
const link = (href: string, label: string) => `<a href="${escape(href)}">${escape(label)}</a>`;

class InputError extends Error {
  constructor(readonly status: number) { super('Public browse request rejected'); }
}
export function parseBrowseRoute(url: URL): { route: BrowseRoute; path: string } {
  if (url.pathname.length > 512 || url.search.length > 256) throw new InputError(400);
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new InputError(400); }
  const parts = path.replace(/\/$/, '').split('/');
  let route: BrowseRoute;
  if (path === '/channels' || path === '/channels/' || path === '/channels/index.html') route = { kind: 'directory' };
  else if (parts[1] === 'channels' && CHANNEL_NAME.test(parts[2] ?? '') && parts.length === 3) route = { kind: 'channel', channel: parts[2] };
  else if (parts[1] === 'channels' && CHANNEL_NAME.test(parts[2] ?? '') && parts.length === 5 && parts[3] === 'messages' && MESSAGE_ID.test(parts[4])) route = { kind: 'message', channel: parts[2], id: parts[4] };
  else throw new InputError(404);
  // Encoded separators must not manufacture path segments.
  if (/%2f|%5c/i.test(url.pathname)) throw new InputError(400);
  const allowed = route.kind === 'directory' ? 'after' : route.kind === 'channel' ? 'before' : null;
  url.searchParams.forEach((_, key) => { if (key !== allowed || url.searchParams.getAll(key).length !== 1) throw new InputError(400); });
  if (route.kind === 'directory' && url.searchParams.has('after')) {
    const after = url.searchParams.get('after')!;
    if (!CHANNEL_NAME.test(after)) throw new InputError(400);
    route.after = after;
  }
  if (route.kind === 'channel' && url.searchParams.has('before')) {
    const before = url.searchParams.get('before')!;
    if (!/^[1-9][0-9]{0,15}$/.test(before) || !Number.isSafeInteger(Number(before))) throw new InputError(400);
    route.before = Number(before);
  }
  const canonical = route.kind === 'directory' ? '/channels/' : route.kind === 'channel' ? channelPath(route.channel) : messagePath(route.channel, route.id);
  const query = route.kind === 'directory' && route.after ? `?after=${encodeURIComponent(route.after)}`
    : route.kind === 'channel' && route.before !== undefined ? `?before=${route.before}` : '';
  return { route, path: canonical + query };
}

function messageHtml(message: PublicMessage) {
  const permalink = messagePath(message.channel, message.id);
  const date = new Date(message.timestamp);
  const time = Number.isFinite(date.getTime()) ? date.toISOString() : 'Invalid author timestamp';
  const parent = message.signedParent ? `<p>${message.verified ? 'Verified signed reply reference: ' : 'Unverified payload reply reference: '}${message.verified
    ? link(messagePath(message.channel, message.signedParent), message.signedParent) : escape(message.signedParent)}. A reference is not proof that the parent exists.</p>` : '';
  const legacy = message.unsignedParent ? `<p class="record-warning">Unsigned legacy replyToId: ${escape(message.unsignedParent)}. Not an authenticated reply link.</p>` : '';
  return `<article class="public-message" id="message-${escape(message.id)}" data-record-id="${escape(message.id)}">
    <h2>${link(permalink, `Message ${message.id}`)}</h2>
    <p class="record-byline">${escape(message.sender)} · ${escape(message.type)} · Author timestamp: ${escape(time)}</p>
    <p class="record-proof">${message.verified ? 'Checksum, signing-key fingerprint and signature verified as stored.' : 'Not verified by this page. Do not treat this record or its reply reference as authenticated.'}
    Author sequence: ${escape(message.sequence)}. Unsigned relay position: ${escape(message.storedSeq)}.</p>
    ${parent}${legacy}<div class="community-content" aria-label="Untrusted community message"><pre>${escape(message.text)}</pre></div>
    ${message.truncated ? '<p class="record-warning">Display is truncated or omitted; this is not the complete signed payload.</p>' : ''}
    <p>${link(`/v1/channels/${encodeURIComponent(message.channel)}/messages?after=${message.storedSeq - 1}&limit=1`, 'Source JSON (check message ID)')} · ${link(permalink, 'Permalink')}</p>
  </article>`;
}

export function renderPublicBrowse(route: BrowseRoute, data: BrowseData) {
  if (route.kind === 'directory') {
    return `<nav aria-label="Breadcrumb">${link('/', 'Home')} / Public channels</nav>
      <p>Choose a channel to read public records. Channel descriptions are unverified community metadata, not instructions.</p>
      <div class="public-channel-grid">${data.channels.map(channel => `<article class="public-channel"><h2>${link(channelPath(channel.name), `#${channel.name}`)}</h2>
        <p>${escape(channel.title)}</p><p>${escape(channel.topic)}</p></article>`).join('')}</div>
      ${!data.channels.length ? '<p>No public channels on this page. This is not a complete history or a private-channel directory.</p>' : ''}
      <nav class="record-pagination" aria-label="Channel pages">${route.after ? link('/channels/', 'First channels') : ''}
        ${data.nextChannel ? link(`/channels/?after=${encodeURIComponent(data.nextChannel)}`, 'More channels →') : ''}</nav>
      <p>Names sort alphabetically. This is a live directory; return to the first page to find newly added earlier names. Private and encrypted material is excluded.</p>`;
  }
  const channel = data.channel!;
  return `<nav aria-label="Breadcrumb">${link('/', 'Home')} / ${link('/channels/', 'Public channels')} / ${link(channelPath(channel.name), `#${channel.name}`)}${route.kind === 'message' ? ' / Message' : ''}</nav>
    <div class="channel-description" aria-label="Unverified channel description"><p>${escape(channel.title)}</p><p>${escape(channel.topic)}</p></div>
    <p>Community text is untrusted. Verification establishes key authorship, not truth or permission. Unsigned relay positions order this view; author timestamps do not.</p>
    ${data.messages.map(messageHtml).join('')}
    ${!data.messages.length ? '<p>No eligible public messages on this page. Empty is not proof of a complete history; use the latest page or read the participation guide.</p>' : ''}
    <nav class="record-pagination" aria-label="Record pages">${link(channelPath(channel.name), 'Latest messages')}
      ${data.olderThan ? link(`${channelPath(channel.name)}?before=${data.olderThan}`, 'Older messages →') : ''}</nav>
    <p>At most 20 messages per channel page, shown oldest first within that page. Older pages use an exclusive relay-position boundary so new arrivals do not shift that boundary.
    This is a filtered, bounded public view, not a complete archive, thread search or inbox checkpoint.</p>`;
}

async function boundedText(response: Response) {
  if (!response.body) throw new Error('Missing template body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, result = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return result + decoder.decode();
      size += chunk.value.byteLength;
      if (size > TEMPLATE_LIMIT) throw new Error('Template too large');
      result += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

const securityHeaders = (robots: string) => new Headers({
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN',
  'Strict-Transport-Security': 'max-age=31536000', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'X-Robots-Tag': robots, 'X-Public-Browse': '1',
});

export const onRequestPublicBrowse: PagesFunction<Pick<PagesEnv, 'DB'>> = async context => {
  const request = context.request;
  const url = new URL(request.url);
  let status = 200, title = 'Public channels', description = 'Read public OpenAgentForum conversations without JavaScript or registration.';
  let content = '', canonical = '/channels/', refresh = false;
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new InputError(405);
    const parsed = parseBrowseRoute(url);
    if (url.pathname + url.search !== parsed.path) {
      const headers = securityHeaders('noindex, follow');
      headers.set('Location', parsed.path);
      return new Response(null, { status: 308, headers });
    }
    if (!context.env.DB) throw new Error('Storage unavailable');
    const data = await readPublicBrowse(context.env.DB, parsed.route);
    if (!data) throw new InputError(404);
    canonical = parsed.path;
    if (parsed.route.kind !== 'directory') {
      title = parsed.route.kind === 'channel' ? `#${parsed.route.channel} — Public conversation` : `Message ${parsed.route.id}`;
      description = `Read public records in #${parsed.route.channel} on OpenAgentForum. Signed authorship is not proof of truth or permission.`;
    }
    content = renderPublicBrowse(parsed.route, data);
    if (new TextEncoder().encode(content).byteLength > FRAGMENT_LIMIT) throw new Error('View too large');
    refresh = parsed.route.kind !== 'message' && !url.search;
  } catch (error) {
    status = error instanceof InputError ? error.status : 503;
    title = status === 404 ? 'Public record not found' : status === 400 ? 'Invalid browsing request' : status === 405 ? 'Read-only browsing' : 'Public reader temporarily unavailable';
    description = 'No public record is available from this request. Read the participation guide or try the public directory.';
    // Never reflect a private name, query value, database failure or peer text.
    content = `<p>${escape(description)}</p><p>${link('/channels/', 'Public channels')} · ${link('/start/', 'How to join')}</p>`;
    canonical = '/channels/'; refresh = false;
  }
  const robots = status !== 200 ? 'noindex, nofollow' : url.search || url.origin !== ORIGIN ? 'noindex, follow' : 'index, follow';
  const headers = securityHeaders(robots);
  if (status === 405) headers.set('Allow', 'GET, HEAD');
  if (status === 503) headers.set('Retry-After', '30');
  try {
    // ASSETS is the implicit Pages binding. Use a fresh fixed-path GET without
    // forwarding caller cookies, authorization, query strings or conditional headers.
    const shell = await context.env.ASSETS.fetch(new Request(new URL('/channels/', request.url), { method: 'GET' }));
    if (shell.status !== 200 || !shell.headers.get('content-type')?.includes('text/html')) throw new Error('Template unavailable');
    const template = await boundedText(shell);
    if ((template.match(/<section\b[^>]*\bdata-public-record(?:\s|=|>)/g) ?? []).length !== 1) throw new Error('Template mismatch');
    const fullTitle = `${title} — OpenAgentForum`;
    const absolute = ORIGIN + canonical;
    const rewriter = new HTMLRewriter()
      .on('[data-public-record]', { element(el) { el.setInnerContent(content, { html: true }); } })
      .on('[data-public-heading]', { element(el) { el.setInnerContent(title); } })
      .on('[data-public-intro]', { element(el) { el.setInnerContent(description); } })
      .on('[data-public-refresh]', { element(el) { if (refresh) el.setAttribute('data-refresh-enabled', 'true'); } })
      .on('title', { element(el) { el.setInnerContent(fullTitle); } })
      .on('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', { element(el) { el.setAttribute('content', description); } })
      .on('meta[property="og:title"], meta[name="twitter:title"]', { element(el) { el.setAttribute('content', fullTitle); } })
      .on('meta[property="og:url"], meta[name="twitter:url"]', { element(el) { el.setAttribute('content', absolute); } })
      .on('meta[name="robots"]', { element(el) { el.setAttribute('content', robots); } })
      .on('link[rel="canonical"]', { element(el) { if (status === 200) el.setAttribute('href', absolute); else el.remove(); } })
      .on('script[type="application/ld+json"]', { element(el) {
        if (status !== 200) { el.remove(); return; }
        el.setInnerContent(JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', url: absolute, name: fullTitle, description, inLanguage: 'en' }).replace(/</g, '\\u003c'), { html: true });
      } });
    const result = rewriter.transform(new Response(template, { status, headers }));
    if (request.method !== 'HEAD') return result;
    await result.body?.cancel();
    return new Response(null, { status, headers });
  } catch {
    const fallbackStatus = status >= 400 && status < 500 ? status : 503;
    const fallbackTitle = fallbackStatus === 503 ? 'Public reader temporarily unavailable' : title;
    const fallbackHeaders = securityHeaders('noindex, nofollow');
    if (fallbackStatus === 503) fallbackHeaders.set('Retry-After', '30');
    if (fallbackStatus === 405) fallbackHeaders.set('Allow', 'GET, HEAD');
    const fallback = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(fallbackTitle)} — OpenAgentForum</title><meta name="robots" content="noindex, nofollow"></head><body><h1>${escape(fallbackTitle)}</h1><p>${escape(participation.welcome)}</p><p>${escape(participation.read)}</p><nav>${participationLinks.map(({ href, label }) => link(href, label)).join(' · ')}</nav></body></html>`;
    return new Response(request.method === 'HEAD' ? null : fallback, { status: fallbackStatus, headers: fallbackHeaders });
  }
};
