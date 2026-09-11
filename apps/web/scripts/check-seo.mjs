import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { canonicalPath, site } from '../src/data/seo.mjs';
import { communities, comparisonNames, renderComparisonMarkdown, reviewedOn } from '../src/data/comparison.mjs';
import { firstVisitSteps, firstVisitTroubleshooting, firstVisitEvidence, renderFirstVisitMarkdown } from '../src/data/first-visit.mjs';

function descendants(node) {
  return [node, ...(node.childNodes ?? []).flatMap(descendants)];
}
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const text = (node) => descendants(node).filter(n => n.nodeName === '#text').map(n => n.value).join('').trim();
const locations = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace(/&amp;/g, '&'));

export function inspectPage(html, file) {
  const nodes = descendants(parse(html));
  const head = nodes.find(n => n.tagName === 'head');
  const headNodes = descendants(head);
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(`${file}: ${message}`); };
  const one = (items, label) => {
    check(items.length === 1 && Boolean(items[0]?.trim()), `expected exactly one nonempty ${label}`);
    return items[0] ?? '';
  };
  const meta = key => one(headNodes.filter(n => n.tagName === 'meta' && (attr(n, 'name') === key || attr(n, 'property') === key)).map(n => attr(n, 'content') ?? ''), key);
  const links = rel => headNodes.filter(n => n.tagName === 'link' && attr(n, 'rel') === rel).map(n => attr(n, 'href') ?? '');
  const title = one(headNodes.filter(n => n.tagName === 'title').map(text), 'title');
  const description = meta('description');
  const noindex = /\bnoindex\b/.test(meta('robots'));
  const path = file === 'index.html' ? '/' : `/${file.replace(/index\.html$/, '')}`;
  const expected = new URL(canonicalPath(path), site).href;
  const canonical = noindex ? '' : one(links('canonical'), 'canonical');
  if (!noindex) {
    check(canonical === expected, `canonical must be ${expected}`);
    meta('keywords');
    check(nodes.filter(n => n.tagName === 'h1').length === 1, 'expected one visible page heading');
  }
  const shareURL = meta('og:url');
  // Astro renders its special 404 route as 404.html, with /404/ in Astro.url.
  check(noindex || shareURL === expected, 'og:url must match the canonical page URL');
  check(meta('twitter:url') === shareURL, 'twitter:url must match og:url');
  check(meta('og:title') === title && meta('twitter:title') === title, 'share titles must match title');
  check(meta('og:description') === description && meta('twitter:description') === description, 'share descriptions must match description');
  check(meta('twitter:card') === 'summary_large_image', 'expected large-image Twitter card');
  meta('og:site_name');
  meta('og:locale');
  const image = meta('og:image');
  check(/^https:\/\//.test(image), 'share image must use an absolute HTTPS URL');
  check(meta('twitter:image') === image, 'share images must agree');
  check(meta('twitter:image:alt') === meta('og:image:alt'), 'share image alternative text must agree');
  check(links('sitemap')[0] === '/sitemap-index.xml', 'missing sitemap discovery link');
  const type = meta('og:type');
  check(type === 'website' || type === 'article', 'unexpected Open Graph type');
  const schemas = [];
  for (const node of nodes.filter(n => n.tagName === 'script' && attr(n, 'type') === 'application/ld+json')) {
    try { schemas.push(JSON.parse(text(node))); } catch { check(false, 'invalid JSON-LD'); }
  }
  if (!noindex) check(schemas.some(s => s['@type'] === 'WebPage' && s.url === canonical), 'missing page-specific WebPage schema');
  if (type === 'article') {
    const published = meta('article:published_time');
    const modified = meta('article:modified_time');
    check(Number.isFinite(Date.parse(published)) && Date.parse(modified) >= Date.parse(published), 'invalid article dates');
    check(schemas.some(s => ['Article', 'TechArticle', 'BlogPosting'].includes(s['@type']) && s.url === canonical && s.datePublished === published && s.dateModified === modified), 'article schema and metadata disagree');
  }
  return { file, title, description, canonical, noindex, image, errors };
}

export function validateSite(files) {
  const errors = [];
  const read = file => String(files.get(file) ?? '');
  const pages = [...files.keys()].filter(f => f.endsWith('.html')).map(f => inspectPage(read(f), f));
  if (!pages.length) errors.push('No built HTML pages found; run the web build first');
  errors.push(...pages.flatMap(p => p.errors));
  const indexable = pages.filter(p => !p.noindex);
  for (const key of ['title', 'description', 'canonical']) {
    const seen = new Set();
    for (const page of indexable) {
      if (seen.has(page[key])) errors.push(`${page.file}: duplicate ${key}`);
      seen.add(page[key]);
    }
  }
  const sitemapIndex = read('sitemap-index.xml');
  if (!sitemapIndex.includes('<sitemapindex')) errors.push('Missing sitemap index');
  if (read('sitemap.xml') !== sitemapIndex) errors.push('sitemap.xml alias differs from sitemap-index.xml');
  if (!read('robots.txt').includes(`Sitemap: ${site}/sitemap-index.xml`)) errors.push('robots.txt must advertise the sitemap index');
  const maps = locations(sitemapIndex);
  if (!maps.length) errors.push('Empty sitemap index');
  const urls = [];
  for (const url of maps) {
    if (!url.startsWith(`${site}/`)) { errors.push(`Unexpected sitemap origin: ${url}`); continue; }
    const file = new URL(url).pathname.slice(1);
    if (!files.has(file)) errors.push(`Missing sitemap file: ${file}`);
    urls.push(...locations(read(file)));
  }
  if (new Set(urls).size !== urls.length) errors.push('Duplicate sitemap URL');
  const canonicals = new Set(indexable.map(p => p.canonical));
  for (const page of indexable) if (!urls.includes(page.canonical)) errors.push(`${page.file}: missing from sitemap`);
  for (const url of urls) if (!canonicals.has(url)) errors.push(`Sitemap contains a noncanonical, missing, or nonindexable page: ${url}`);
  if (!pages.find(p => p.file === '404.html')?.noindex) errors.push('404.html must be noindex');
  for (const page of pages) {
    if (page.image.startsWith(`${site}/`) && !files.has(new URL(page.image).pathname.slice(1))) errors.push(`${page.file}: missing share image asset`);
  }
  return { errors, pageCount: pages.length, indexableCount: indexable.length, sitemapCount: urls.length };
}

// Additional assertions for the real comparison, beyond the reusable SEO checks.
export function validateComparison(files) {
  const errors = [];
  const html = String(files.get('compare/index.html') ?? '');
  const nodes = descendants(parse(html));
  const visible = text(nodes.find(n => n.tagName === 'article') ?? { childNodes: [] });
  if (String(files.get('compare.md') ?? '') !== renderComparisonMarkdown()) errors.push('Comparison Markdown differs from its editorial source');
  if (!nodes.some(n => n.tagName === 'link' && attr(n, 'rel') === 'alternate' && attr(n, 'href') === '/compare.md')) errors.push('Comparison lacks Markdown alternate link');
  if (!String(files.get('_headers') ?? '').includes('/compare.md\n  Content-Type: text/markdown; charset=utf-8\n  Link: <https://openagentforum.com/compare/>; rel="canonical"')) errors.push('Comparison Markdown lacks its Pages content-type/canonical headers');
  if (!nodes.some(n => n.tagName === 'time' && attr(n, 'datetime') === reviewedOn)) errors.push('Comparison review date differs from the source');
  if (!nodes.some(n => n.tagName === 'caption' && text(n) === `Compare ${comparisonNames}`)) errors.push('Comparison caption differs from the shared entry list');
  if (nodes.filter(n => n.tagName === 'section' && attr(n, 'class')?.split(/\s+/).includes('profile')).length !== communities.length) errors.push('Comparison profile count differs from the shared entry list');
  for (const entry of communities) {
    if (!nodes.some(n => n.tagName === 'section' && attr(n, 'id') === entry.id)) errors.push(`Comparison profile missing: ${entry.name}`);
    if (!nodes.some(n => n.tagName === 'a' && attr(n, 'href') === `#${entry.id}` && text(n) === entry.name)) errors.push(`Comparison table link missing: ${entry.name}`);
    if (!visible.includes(entry.caveat)) errors.push(`Comparison limits missing: ${entry.name}`);
    for (const [, url] of entry.sources) if (!nodes.some(n => n.tagName === 'a' && attr(n, 'href') === url)) errors.push(`Comparison source link missing: ${url}`);
  }
  return errors;
}

export function readBuiltFiles(dir) {
  const files = new Map();
  function walk(path, prefix = '') {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(path, entry.name), `${file}/`);
      else files.set(file, /\.(html|xml|md|txt)$/.test(file) || file === '_headers' ? readFileSync(join(path, entry.name), 'utf8') : '');
    }
  }
  walk(dir);
  return files;
}

export function validateFirstVisit(files) {
  const errors = [];
  const html = String(files.get('start/index.html') ?? '');
  const nodes = descendants(parse(html));
  for (const step of firstVisitSteps) {
    const section = nodes.find(n => n.tagName === 'section' && attr(n, 'id') === step.id);
    const visible = text(section ?? { childNodes: [] });
    if (!section || !visible.includes(step.title) || !visible.includes(step.boundary)) errors.push(`First-visit step missing: ${step.id}`);
    for (const paragraph of [...step.paragraphs, ...(step.note ? [step.note] : [])]) {
      if (!visible.includes(paragraph)) errors.push(`First-visit guidance differs: ${step.id}`);
    }
    if (!descendants(section ?? { childNodes: [] }).some(n => n.tagName === 'code' && text(n) === step.code)) errors.push(`First-visit command differs: ${step.id}`);
  }
  const visible = text(nodes.find(n => n.tagName === 'article') ?? { childNodes: [] });
  for (const [title, body] of firstVisitTroubleshooting) if (!visible.includes(title) || !visible.includes(body)) errors.push('First-visit troubleshooting missing');
  if (!visible.includes(firstVisitEvidence)) errors.push('First-visit verification scope missing');
  if (!String(files.get('llms-full.txt') ?? '').includes(renderFirstVisitMarkdown())) errors.push('Long-form machine text differs from first-visit guide');
  if (!String(files.get('index.html') ?? '').includes('href="/start/"')) errors.push('Homepage does not link to first-visit guide');
  return errors;
}

// Check delivered copy, including metadata and the article text appended at build
// time. Client helpers are not evidence of a deployed payment integration.
export function validatePaymentMessaging(files) {
  const errors = [];
  const pages = ['payments/index.html', 'commerce/index.html', 'tasks/index.html', 'blog/autonomous-agent-affiliate-protocol-earning-usdc/index.html'];
  const documents = [...pages, 'agent.md', 'llms-full.txt'];
  const read = file => String(files.get(file) ?? '');
  const visible = file => (file.endsWith('.html') ? text(parse(read(file))) : read(file)).replace(/\s+/g, ' ');
  for (const file of documents) {
    if (!visible(file).includes('No built-in escrow or automatic payouts')) errors.push(`${file}: missing payment availability boundary`);
  }
  for (const file of ['payments/index.html', 'agent.md', 'llms-full.txt']) {
    if (!visible(file).includes('No wallet provider or network is required to use the forum')) errors.push(`${file}: missing payment independence boundary`);
    if (!visible(file).includes('not proof of payment')) errors.push(`${file}: missing receipt verification boundary`);
  }
  for (const file of ['commerce/index.html', 'blog/autonomous-agent-affiliate-protocol-earning-usdc/index.html', 'agent.md', 'llms-full.txt']) {
    if (!visible(file).includes('Campaign routes are not implemented in the bundled hub adapters')) errors.push(`${file}: missing campaign availability boundary`);
  }
  const unsupported = /KeyKeeper automated escrow|Funds auto-release upon|Instant finality|Zero[- ](?:gas|fee) (?:internal )?micro|commissions auto-release|instant (?:non-custodial )?USDC payouts|automated Stripe webhook payouts|sales trigger automated payouts|LIVE REVENUE SHARE|\/v1\/campaigns\/[^\s<"']+\/(?:join|convert)|keykeeper\.world\/api\/v1\/agent\//i;
  for (const file of [...documents, 'blog/index.html', 'llms.txt']) {
    // Raw HTML includes descriptions/OG/JSON-LD as well as visible page copy.
    if (unsupported.test(read(file))) errors.push(`${file}: unsupported payment or campaign promise`);
  }
  if (/btn-gen-ref-link|btn-copy-owner-prompt/.test(read('commerce/index.html'))) errors.push('commerce/index.html: unavailable campaign call to action');
  if (!visible('blog/autonomous-agent-affiliate-protocol-earning-usdc/index.html').includes('Correction: proposal, not a live payout system')) errors.push('Affiliate article lacks its correction notice');
  if (!visible('llms-full.txt').includes('Correction: proposal, not a live payout system')) errors.push('Long-form machine text lacks the affiliate correction');
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = readBuiltFiles(fileURLToPath(new URL('../dist/', import.meta.url)));
  const result = validateSite(files);
  result.errors.push(...validateComparison(files));
  result.errors.push(...validateFirstVisit(files));
  result.errors.push(...validatePaymentMessaging(files));
  if (result.errors.length) {
    console.error(result.errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`SEO checked: ${result.indexableCount} indexable pages, ${result.sitemapCount} canonical sitemap URLs, ${result.pageCount - result.indexableCount} noindex page; comparison, first-visit and payment guidance checked against machine text`);
  }
}
