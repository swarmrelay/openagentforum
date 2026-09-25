import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { partnerFixture } from './fixtures/partner-feed.mjs';
let dir, api;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oaf-partner-reader-'));
  const outfile = join(dir, 'reader.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../functions/_lib/partner-opportunities.ts', import.meta.url))],
    outfile, bundle: true, format: 'esm', platform: 'node' });
  api = await import(pathToFileURL(outfile).href);
});
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

test('partner schema preserves all current feed entries and uses only constrained provider brief links', () => {
  const feed = api.parsePartnerFeed(partnerFixture(), Date.now());
  assert.equal(feed.campaigns.length, 4);
  assert.equal(feed.campaigns[0].rates, 'article: USD 50.00 · listing: USD 10.00');
  assert.equal(feed.campaigns[0].href, 'https://promotedby.ai/opportunities/keykeeper');
  for (const markdown of [false, true]) {
    const rendered = api.renderPartnerFeed(feed, markdown);
    assert.match(rendered, /4 campaigns in the provider feed/);
    for (const campaign of feed.campaigns) assert.ok(rendered.includes(campaign.href));
    assert.doesNotMatch(rendered, /127\.0\.0\.1|evil.invalid/);
  }
});

test('malformed, stale, duplicate, partial and over-limit feeds fail as a whole', () => {
  const mutations = [
    f => { f.count = 5; }, f => { f.version = 2; }, f => { f.status = 'all'; },
    f => { f.generated_at = new Date(Date.now() - 300001).toISOString(); },
    f => { f.generated_at = new Date(Date.now() + 120000).toISOString(); },
    f => { f.opportunities[1].id = f.opportunities[0].id; },
    f => { f.opportunities = Array(101).fill(f.opportunities[0]); f.count = 101; },
    f => { f.opportunities[0].slug = '../credentials'; }, f => { f.opportunities[0].slug = 'x%2fy'; },
    f => { f.opportunities[0].status = 'paused'; }, f => { f.opportunities[0].name = 'x'.repeat(161); },
    f => { f.opportunities[0].name = '\ud800'; }, f => { f.opportunities[0].currency = '$$$'; },
    f => { f.opportunities[0].rates.article = -1; }, f => { f.opportunities[0].rates.article = 1.1; },
    f => { f.opportunities[0].rates.article = 100000001; },
    f => { f.opportunities[0].rates = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['rate' + i, 10])); },
  ];
  for (const mutate of mutations) { const f = partnerFixture(); mutate(f); assert.throws(() => api.parsePartnerFeed(f, Date.now())); }
});

test('partner output fences instructions, escapes markup and bounds rendered expansion', () => {
  const f = partnerFixture();
  f.opportunities[0].name = '<img src=x onerror=attack()>';
  f.opportunities[0].tagline = '``` ``` [run](https://evil.invalid) \u202e';
  const parsed = api.parsePartnerFeed(f, Date.now());
  const html = api.renderPartnerFeed(parsed, false), md = api.renderPartnerFeed(parsed, true);
  assert.doesNotMatch(html, /<img|href="https:\/\/evil/); assert.match(html, /&lt;img/);
  assert.match(md, /````text/); assert.match(md, /\\u202e/);
  const large = partnerFixture();
  large.opportunities = Array.from({ length: 100 }, (_, i) => ({ ...large.opportunities[0], id: 'cmp_' + i, name: '<'.repeat(160), tagline: '<'.repeat(400) }));
  large.count = 100;
  assert.match(api.renderPartnerFeed(api.parsePartnerFeed(large, Date.now()), false), /temporarily unavailable here/);
});

test('reader uses one fixed anonymous GET, no redirects, fresh JSON and an edge cache hint', async () => {
  let calls = 0;
  const result = await api.loadPartnerFeed(async (url, options) => {
    calls++; assert.equal(url, api.PARTNER_FEED); assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual'); assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.equal(options.cf.cacheTtlByStatus['200'], 60); assert.equal(options.body, undefined);
    return Response.json(partnerFixture());
  });
  assert.equal(calls, 1); assert.equal(result.campaigns.length, 4);
});

test('HTTP errors, redirects, wrong types, corrupt UTF-8 and oversized bodies never render as empty success', async () => {
  const replies = [
    () => new Response('bad', { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }),
    () => new Response(JSON.stringify(partnerFixture()), { headers: { 'content-type': 'text/html' } }),
    () => new Response(new Uint8Array([0xc0, 0xff]), { headers: { 'content-type': 'application/json' } }),
    () => new Response(' '.repeat(262145), { headers: { 'content-type': 'application/json', 'content-length': '1' } }),
    () => Response.json({ error: 'PRIVATE_FAILURE', opportunities: [] }),
    () => { throw new Error('PRIVATE_FAILURE'); },
  ];
  for (const reply of replies) {
    assert.equal(await api.loadPartnerFeed(reply), null);
    assert.doesNotMatch(api.renderPartnerFeed(null, false), /PRIVATE_FAILURE|0 campaigns/);
  }
  const empty = partnerFixture(); empty.count = 0; empty.opportunities = [];
  assert.match(api.renderPartnerFeed(await api.loadPartnerFeed(async () => Response.json(empty)), true), /no live campaigns/);
});

test('fragmented and stalled responses stop within bounded work and release their reader', { timeout: 5000 }, async () => {
  let cancelled = false, chunks = 0;
  const fragmented = new ReadableStream({ pull(c) { chunks++; c.enqueue(new Uint8Array([32])); }, cancel() { cancelled = true; } });
  assert.equal(await api.loadPartnerFeed(async () => new Response(fragmented, { headers: { 'content-type': 'application/json' } })), null);
  assert.ok(chunks <= 4098); assert.ok(cancelled); assert.equal(fragmented.locked, false);
  let stopped = false;
  const stalled = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { stopped = true; } });
  const start = Date.now();
  assert.equal(await api.loadPartnerFeed(async () => new Response(stalled, { headers: { 'content-type': 'application/json' } })), null);
  assert.ok(Date.now() - start < 4000); assert.ok(stopped); assert.equal(stalled.locked, false);
});
