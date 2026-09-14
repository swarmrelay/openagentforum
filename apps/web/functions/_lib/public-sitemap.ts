import { CHANNEL_NAME, MESSAGE_ID, PUBLIC_CHANNEL, PUBLIC_MESSAGE } from './public-browse-store.js';
import { ORIGIN, InputError, channelPath, messagePath } from './public-browse-routing.js';

// A complete catalog within explicit safety caps, never a silently truncated
// sitemap. Expand the shard design before exceeding either operational guard.
export const SITEMAP_CHANNEL_LIMIT = 1000;
export const SITEMAP_MESSAGE_LIMIT = 5000;
const XML_LIMIT = 4 * 1024 * 1024;
const INDEX = '/sitemap-public-index.xml';
const MAP = '/sitemap-public.xml';
const escapeXml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const document = (paths: string[], index: boolean) => {
  const root = index ? 'sitemapindex' : 'urlset';
  const entry = index ? 'sitemap' : 'url';
  // No author clocks, payloads, titles, sender details or invented lastmod.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + paths.map(path => `<${entry}><loc>${escapeXml(ORIGIN + path)}</loc></${entry}>`).join('\n') + `\n</${root}>\n`;
};

export const onRequestPublicSitemap: PagesFunction<Pick<PagesEnv, 'DB'>> = async context => {
  const { request } = context;
  const url = new URL(request.url);
  let status = 200, body = '';
  const headers = new Headers({
    'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, follow',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
  });
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new InputError(405);
    // Preview data must not advertise production canonical URLs to crawlers.
    if (url.origin !== ORIGIN || ![INDEX, MAP].includes(url.pathname)) throw new InputError(404);
    if (url.search.length > 256) throw new InputError(400);
    const index = url.pathname === INDEX;
    url.searchParams.forEach((_, key) => {
      if (index || key !== 'channel' || url.searchParams.getAll(key).length !== 1) throw new InputError(400);
    });
    const channel = url.searchParams.get('channel');
    if (channel !== null && !CHANNEL_NAME.test(channel)) throw new InputError(400);
    const canonical = index ? INDEX : MAP + (channel === null ? '' : `?channel=${encodeURIComponent(channel)}`);
    if (url.pathname + url.search !== canonical) {
      headers.set('Location', canonical);
      return new Response(null, { status: 308, headers });
    }
    const db = context.env.DB;
    if (!db) throw new Error('Storage unavailable');
    let paths: string[];
    if (channel === null) {
      const [result] = await db.batch<{ name: string }>([
        db.prepare(`SELECT name FROM channels INDEXED BY idx_channels_public_browse
          WHERE ${PUBLIC_CHANNEL} ORDER BY name LIMIT ?`).bind(SITEMAP_CHANNEL_LIMIT + 1),
      ]);
      if (!result.success || result.results.length > SITEMAP_CHANNEL_LIMIT) throw new Error('Catalog unavailable or over capacity');
      if (result.results.some(row => typeof row.name !== 'string' || !CHANNEL_NAME.test(row.name))) throw new Error('Invalid catalog projection');
      paths = index ? [MAP, ...result.results.map(row => `${MAP}?channel=${encodeURIComponent(row.name)}`)]
        : ['/channels/', ...result.results.map(row => channelPath(row.name))];
    } else {
      // Keep the policy lookup OUTSIDE the message loop, as in the HTML reader.
      // The shared partial index excludes encrypted records before scanning.
      // Both statements run atomically on primary D1; no cache/replica fallback.
      const [visible, records] = await db.batch<{ name?: string; id?: string }>([
        db.prepare(`SELECT name FROM channels WHERE name = ? AND ${PUBLIC_CHANNEL}`).bind(channel),
        db.prepare(`SELECT m.id FROM (SELECT name FROM channels WHERE name = ? AND ${PUBLIC_CHANNEL}) AS visible
          CROSS JOIN (SELECT id, channel, stored_seq FROM messages INDEXED BY idx_messages_public_browse
            WHERE channel = ? AND ${PUBLIC_MESSAGE}) AS m
          WHERE m.channel = visible.name ORDER BY m.stored_seq DESC LIMIT ?`)
          .bind(channel, channel, SITEMAP_MESSAGE_LIMIT + 1),
      ]);
      if (!visible.success || !records.success) throw new Error('Sitemap unavailable');
      if (!visible.results.length) throw new InputError(404);
      if (records.results.length > SITEMAP_MESSAGE_LIMIT) throw new Error('Shard over capacity');
      paths = [channelPath(channel), ...records.results.map(row => {
        if (typeof row.id !== 'string' || !MESSAGE_ID.test(row.id)) throw new Error('Invalid projection');
        return messagePath(channel, row.id);
      })];
    }
    body = document(paths, index);
    if (new TextEncoder().encode(body).byteLength > XML_LIMIT) throw new Error('Sitemap too large');
  } catch (error) {
    status = error instanceof InputError ? error.status : 503;
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    if (status === 405) headers.set('Allow', 'GET, HEAD');
    if (status === 503) headers.set('Retry-After', '300');
    // Never emit partial URLs, private names, query values or storage errors.
    body = status === 503 ? 'Public sitemap temporarily unavailable.\n'
      : status === 405 ? 'Read-only sitemap. Use GET or HEAD.\n' : 'No public sitemap available for this request.\n';
  }
  return new Response(request.method === 'HEAD' ? null : body, { status, headers });
};
