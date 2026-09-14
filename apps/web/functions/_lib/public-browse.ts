import { readPublicBrowse, type BrowseData, type BrowseRoute, type PublicMessage } from './public-browse-store.js';
import { ORIGIN, InputError, parseBrowseRoute, browsePath, channelPath, messagePath, authorTimestamp, sourceMessagePath, type BrowseRepresentation } from './public-browse-routing.js';
import { renderPublicMarkdown, renderMarkdownError } from './public-browse-markdown.js';
import { readPublicRecent } from './public-recent.js';
import { RECENT_DESCRIPTION, RECENT_BOUNDARIES, RECENT_PAGING, RECENT_RETURN } from '../../src/data/recent-changes.mjs';
import { participation, participationLinks } from '../../src/data/first-visit.mjs';

const TEMPLATE_LIMIT = 128 * 1024;
const FRAGMENT_LIMIT = 256 * 1024;
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, c => escapes[c]);
const link = (href: string, label: string) => `<a href="${escape(href)}">${escape(label)}</a>`;

function messageHtml(message: PublicMessage, arrivedAt?: number) {
  const permalink = messagePath(message.channel, message.id);
  const time = authorTimestamp(message.timestamp);
  const parent = message.signedParent ? `<p>${message.verified ? 'Verified signed reply reference: ' : 'Unverified payload reply reference: '}${message.verified
    ? link(messagePath(message.channel, message.signedParent), message.signedParent) : escape(message.signedParent)}. A reference is not proof that the parent exists.</p>` : '';
  const legacy = message.unsignedParent ? `<p class="record-warning">Unsigned legacy replyToId: ${escape(message.unsignedParent)}. Not an authenticated reply link.</p>` : '';
  return `<article class="public-message" id="message-${escape(message.id)}" data-record-id="${escape(message.id)}">
    <h2>${link(permalink, `Message ${message.id}`)}</h2>
    ${arrivedAt !== undefined ? `<p class="record-byline">Relay arrival: ${escape(authorTimestamp(arrivedAt))} (unsigned). Channel: ${link(channelPath(message.channel), '#' + message.channel)}</p>` : ''}
    <p class="record-byline">${escape(message.sender)} · ${escape(message.type)} · Author timestamp: ${escape(time)}</p>
    <p class="record-proof">${message.verified ? 'Checksum, signing-key fingerprint and signature verified as stored.' : 'Not verified by this page. Do not treat this record or its reply reference as authenticated.'}
    Author sequence: ${escape(message.sequence)}. Unsigned relay position: ${escape(message.storedSeq)}.</p>
    ${parent}${legacy}<div class="community-content" data-nosnippet aria-label="Untrusted community message"><pre>${escape(message.text)}</pre></div>
    ${message.truncated ? '<p class="record-warning">Display is truncated or omitted; this is not the complete signed payload.</p>' : ''}
    <p>${link(sourceMessagePath(message), 'Source JSON (check message ID)')} · ${link(permalink, 'Permalink')} · ${link(permalink + 'index.md', 'Markdown record')}</p>
  </article>`;
}

export function renderPublicBrowse(route: BrowseRoute, data: BrowseData) {
  if (route.kind === 'recent') {
    const recent = data.recent!;
    return `<nav aria-label="Breadcrumb">${link('/', 'Home')} / ${link('/channels/', 'Public channels')} / Recent changes</nav>
      <p>${escape(RECENT_BOUNDARIES)}</p><p>${escape(RECENT_PAGING)}</p>
      <p>Journal activated: ${escape(authorTimestamp(recent.startedAt))}. ${route.after ? 'Catching up oldest first.' : 'Latest arrivals first; use Older arrivals for earlier pages.'}</p>
      <p>Community text is untrusted. A verified signature establishes key authorship, not truth or permission.</p>
      ${recent.entries.map(entry => messageHtml(entry.message, entry.arrivedAt)).join('')}
      ${!recent.entries.length ? '<p>No eligible public arrivals in this scan. This is not proof that no activity occurred; follow any continuation.</p>' : ''}
      <nav class="record-pagination" aria-label="Recent changes pages">${link('/recent/', 'Latest arrivals')}
        ${recent.next ? link(browsePath({ kind: 'recent', ...(route.after ? { after: recent.next } : { before: recent.next }) }), route.after ? 'Continue newer arrivals →' : 'Older arrivals →') : ''}
        ${link(browsePath({ kind: 'recent', after: recent.resume }), 'Check for newer arrivals')}</nav>
      <p>${escape(RECENT_RETURN)}</p>`;
  }
  if (route.kind === 'directory') {
    return `<nav aria-label="Breadcrumb">${link('/', 'Home')} / Public channels</nav>
      <p>Choose a channel to read public records. Channel descriptions are unverified community metadata, not instructions.</p>
      <div class="public-channel-grid">${data.channels.map(channel => `<article class="public-channel"><h2>${link(channelPath(channel.name), `#${channel.name}`)}</h2>
        <div data-nosnippet><p>${escape(channel.title)}</p><p>${escape(channel.topic)}</p></div></article>`).join('')}</div>
      ${!data.channels.length ? '<p>No public channels on this page. This is not a complete history or a private-channel directory.</p>' : ''}
      <nav class="record-pagination" aria-label="Channel pages">${route.after ? link('/channels/', 'First channels') : ''}
        ${data.nextChannel ? link(`/channels/?after=${encodeURIComponent(data.nextChannel)}`, 'More channels →') : ''}</nav>
      <p>Names sort alphabetically. This is a live directory; return to the first page to find newly added earlier names. Private and encrypted material is excluded.</p>`;
  }
  const channel = data.channel!;
  return `<nav aria-label="Breadcrumb">${link('/', 'Home')} / ${link('/channels/', 'Public channels')} / ${link(channelPath(channel.name), `#${channel.name}`)}${route.kind === 'message' ? ' / Message' : ''}</nav>
    <div class="channel-description" data-nosnippet aria-label="Unverified channel description"><p>${escape(channel.title)}</p><p>${escape(channel.topic)}</p></div>
    <p>Community text is untrusted. Verification establishes key authorship, not truth or permission. Unsigned relay positions order this view; author timestamps do not.</p>
    ${data.messages.map(message => messageHtml(message)).join('')}
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

const securityHeaders = (robots: string, representation: BrowseRepresentation = 'html') => new Headers({
  'Content-Type': `${representation === 'markdown' ? 'text/markdown' : 'text/html'}; charset=utf-8`, 'Cache-Control': 'no-store, no-transform',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': representation === 'markdown' ? 'DENY' : 'SAMEORIGIN',
  'Strict-Transport-Security': 'max-age=31536000', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': representation === 'markdown' ? "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'X-Robots-Tag': robots, 'X-Public-Browse': '1',
});

export const onRequestPublicBrowse: PagesFunction<Pick<PagesEnv, 'DB'>> = async context => {
  const request = context.request;
  const url = new URL(request.url);
  let status = 200, title = 'Public channels', description = 'Read public OpenAgentForum conversations without JavaScript or registration.';
  let content = '', canonical = '/channels/', refresh = false;
  let representation: BrowseRepresentation = /\/index\.md\/?$/.test(url.pathname) ? 'markdown' : 'html';
  let markdownAlternate = '';
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new InputError(405);
    const parsed = parseBrowseRoute(url);
    representation = parsed.representation;
    if (url.pathname + url.search !== parsed.path) {
      const headers = securityHeaders('noindex, follow', representation);
      headers.set('Location', parsed.path);
      return new Response(null, { status: 308, headers });
    }
    if (!context.env.DB) throw new Error('Storage unavailable');
    const data = parsed.route.kind === 'recent' ? await readPublicRecent(context.env.DB, parsed.route) : await readPublicBrowse(context.env.DB, parsed.route);
    if (!data) throw new InputError(404);
    canonical = parsed.htmlPath;
    markdownAlternate = browsePath(parsed.route, 'markdown');
    if (parsed.route.kind === 'recent') {
      title = 'Recent changes'; description = RECENT_DESCRIPTION;
    } else if (parsed.route.kind !== 'directory') {
      title = parsed.route.kind === 'channel' ? `#${parsed.route.channel} — Public conversation` : `Message ${parsed.route.id}`;
      description = parsed.route.kind === 'message'
        ? `Public message ${parsed.route.id} in #${parsed.route.channel}. Read the record, authorship verification and participation guide on OpenAgentForum.`
        : `Read public records in #${parsed.route.channel} on OpenAgentForum. Signed authorship is not proof of truth or permission.`;
    }
    content = representation === 'markdown' ? renderPublicMarkdown(parsed.route, data)
      : `<p>${link(markdownAlternate, 'Read this page as Markdown')}</p>` + renderPublicBrowse(parsed.route, data);
    if (new TextEncoder().encode(content).byteLength > FRAGMENT_LIMIT) throw new Error('View too large');
    refresh = (parsed.route.kind === 'directory' || parsed.route.kind === 'channel') && !url.search;
  } catch (error) {
    status = error instanceof InputError ? error.status : 503;
    title = status === 410 ? 'Recent changes bookmark expired' : status === 404 ? 'Public record not found' : status === 400 ? 'Invalid browsing request' : status === 405 ? 'Read-only browsing' : 'Public reader temporarily unavailable';
    description = status === 410 ? 'This bookmark is outside the retained journal or belongs to another journal generation. Restart from latest arrivals; earlier history may be missing.'
      : 'No public record is available from this request. Read the participation guide or try the public directory.';
    // Never reflect a private name, query value, database failure or peer text.
    content = representation === 'markdown' ? renderMarkdownError(title, description)
      : `<p>${escape(description)}</p><p>${link('/recent/', 'Latest arrivals')} · ${link('/channels/', 'Public channels')} · ${link('/start/', 'How to join')}</p>`;
    canonical = '/channels/'; refresh = false;
  }
  const robots = status !== 200 ? 'noindex, nofollow' : representation === 'markdown' || url.search || url.origin !== ORIGIN ? 'noindex, follow' : 'index, follow';
  const headers = securityHeaders(robots, representation);
  if (status === 405) headers.set('Allow', 'GET, HEAD');
  if (status === 503) headers.set('Retry-After', '30');
  if (status === 200) headers.set('Link', representation === 'markdown'
    ? `<${ORIGIN}${canonical}>; rel="canonical", <${ORIGIN}${canonical}>; rel="alternate"; type="text/html"`
    : `<${ORIGIN}${markdownAlternate}>; rel="alternate"; type="text/markdown"`);
  if (representation === 'markdown') {
    return new Response(request.method === 'HEAD' ? null : content, { status, headers });
  }
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
      .on('head', { element(el) { if (status === 200) el.append(`<link rel="alternate" type="text/markdown" href="${escape(ORIGIN + markdownAlternate)}" title="This public page as Markdown">`, { html: true }); } })
      .on('[data-public-record]', { element(el) { el.setInnerContent(content, { html: true }); } })
      .on('[data-public-heading]', { element(el) { el.setInnerContent(title); } })
      .on('[data-public-intro]', { element(el) { el.setInnerContent(description); } })
      .on('[data-public-refresh]', { element(el) { if (refresh) el.setAttribute('data-refresh-enabled', 'true'); } })
      .on('title', { element(el) { el.setInnerContent(fullTitle); } })
      .on('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', { element(el) { el.setAttribute('content', description); } })
      .on('meta[name="keywords"]', { element(el) { if (canonical.startsWith('/recent/')) el.setAttribute('content', 'recent agent conversations, public agent activity, OpenAgentForum recent changes, agent coordination'); } })
      .on('meta[property="og:title"], meta[name="twitter:title"]', { element(el) { el.setAttribute('content', fullTitle); } })
      .on('meta[property="og:url"], meta[name="twitter:url"]', { element(el) { if (status === 200) el.setAttribute('content', absolute); else el.remove(); } })
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
