import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalPath, pageKeywords, site } from '../src/data/seo.mjs';
import { inspectPage, validateSite, validateFirstVisit, validatePublicDiscovery } from './check-seo.mjs';
import { communities, comparisonDescription, comparisonNames, comparisonTitle, renderComparisonMarkdown, reviewedOn } from '../src/data/comparison.mjs';
import { firstVisitCliVersion, firstVisitSteps, firstVisitTroubleshooting, firstVisitEvidence, renderFirstVisitMarkdown } from '../src/data/first-visit.mjs';

function page({ path = '/', title = 'A useful page', description = 'A useful description', noindex = false } = {}) {
  const url = `${site}${path}`;
  const tags = { description, keywords: 'agent communication', robots: noindex ? 'noindex, follow' : 'index, follow', 'og:url': url, 'twitter:url': url, 'og:title': title, 'twitter:title': title, 'og:description': description, 'twitter:description': description, 'og:image': `${site}/og-image.png`, 'twitter:image': `${site}/og-image.png`, 'og:image:alt': 'Agent forum', 'twitter:image:alt': 'Agent forum', 'og:type': 'website', 'og:locale': 'en_US', 'og:site_name': 'OpenAgentForum', 'twitter:card': 'summary_large_image' };
  return `<!doctype html><html><head><title>${title}</title>${Object.entries(tags).map(([name, content]) => `<meta name="${name}" content="${content}">`).join('')}${noindex ? '' : `<link rel="canonical" href="${url}">`}<link rel="sitemap" href="/sitemap-index.xml"><link rel="sitemap" href="/sitemap-public-index.xml"><script type="application/ld+json">${JSON.stringify({ '@type': 'WebPage', url })}</script></head><body><h1>${title}</h1></body></html>`;
}
function fixture() {
  const index = `<sitemapindex><sitemap><loc>${site}/sitemap-0.xml</loc></sitemap></sitemapindex>`;
  return new Map([
    ['index.html', page()], ['404.html', page({ path: '/404.html', title: 'Not found', noindex: true })],
    ['sitemap-index.xml', index], ['sitemap.xml', index], ['robots.txt', `Sitemap: ${site}/sitemap-index.xml\nSitemap: ${site}/sitemap-public-index.xml`],
    ['sitemap-0.xml', `<urlset><url><loc>${site}/</loc></url></urlset>`], ['og-image.png', ''],
  ]);
}

test('normalizes canonical paths, dropping queries and fragments but preserving assets', () => {
  for (const [input, expected] of [['/', '/'], ['/compare', '/compare/'], ['/compare/?from=nav#nostr', '/compare/'], ['/compare.md', '/compare.md'], [`${site}/blog/test`, '/blog/test/']]) assert.equal(canonicalPath(input), expected);
});
test('accepts a fully covered site with a noindex error page', () => assert.deepEqual(validateSite(fixture()).errors, []));
test('public discovery checks reject missing live sitemap discovery and navigation or frozen cursor URLs', () => {
  const files = fixture();
  files.set('robots.txt', `Sitemap: ${site}/sitemap-index.xml`);
  files.set('index.html', page().replace('<link rel="sitemap" href="/sitemap-public-index.xml">', ''));
  assert.match(validateSite(files).errors.join('\n'), /live public sitemap index/);
  assert.match(validateSite(files).errors.join('\n'), /public conversation sitemap discovery link/);
  const nav = ['/channels/', '/recent/', '/blog/', '/start/'].map(href => `<a href="${href}">${href}</a>`).join('');
  for (const file of ['index.html', 'channels/index.html', 'recent/index.html', 'blog/index.html', 'start/index.html']) files.set(file, nav);
  assert.deepEqual(validatePublicDiscovery(files), []);
  files.set('recent/index.html', '');
  files.set('sitemap-0.xml', `<urlset><url><loc>${site}/recent/?after=1</loc></url></urlset>`);
  assert.match(validatePublicDiscovery(files).join('\n'), /ordinary discovery link/);
  assert.match(validatePublicDiscovery(files).join('\n'), /cursor URL/);
});
test('rejects missing sitemap pages and noncanonical or alternate entries', () => {
  const files = fixture();
  files.set('sitemap-0.xml', `<urlset><url><loc>${site}/compare.md</loc></url><url><loc>${site}/404.html</loc></url></urlset>`);
  const errors = validateSite(files).errors.join('\n');
  assert.match(errors, /missing from sitemap/);
  assert.match(errors, /nonindexable page/);
});
test('detects duplicate titles/descriptions and missing share assets', () => {
  const files = fixture();
  files.set('compare/index.html', page({ path: '/compare/' }));
  files.delete('og-image.png');
  const errors = validateSite(files).errors.join('\n');
  assert.match(errors, /duplicate title/);
  assert.match(errors, /duplicate description/);
  assert.match(errors, /missing share image/);
});
test('rejects missing or duplicate tags and malformed JSON-LD', () => {
  const html = page().replace('<meta name="keywords" content="agent communication">', '').replace('</head>', '<meta name="description" content="duplicate"></head>').replace('"@type":"WebPage"', 'invalid');
  const errors = inspectPage(html, 'index.html').errors.join('\n');
  assert.match(errors, /one nonempty keywords/);
  assert.match(errors, /one nonempty description/);
  assert.match(errors, /invalid JSON-LD/);
});
test('rejects canonical/share mismatch and indexable error pages', () => {
  const files = fixture();
  files.set('index.html', page().replace(`href="${site}/"`, `href="${site}/?campaign=wrong"`));
  files.set('404.html', page({ path: '/404.html' }));
  assert.match(validateSite(files).errors.join('\n'), /canonical must be/);
  assert.match(validateSite(files).errors.join('\n'), /404.html must be noindex/);
});
test('rejects inconsistent article dates/schema', () => {
  const html = page().replace('name="og:type" content="website"', 'name="og:type" content="article"');
  assert.match(inspectPage(html, 'index.html').errors.join('\n'), /article schema and metadata disagree/);
});
test('Markdown retains every source, caveat, and the fixed review date', () => {
  const markdown = renderComparisonMarkdown();
  assert.ok(markdown.includes(reviewedOn));
  assert.equal(new Set(communities.map(c => c.id)).size, communities.length);
  for (const community of communities) {
    assert.ok(markdown.includes(community.caveat));
    for (const [, url] of community.sources) assert.ok(markdown.includes(url));
  }
});

test('iLands is a full sourced entry with preview limits and matching discovery metadata', () => {
  const entry = communities.find(c => c.id === 'ilands');
  assert.ok(entry);
  assert.equal(entry.name, 'iLands');
  for (const field of ['fit', 'identity', 'returning', 'tools', 'hosting', 'caveat']) assert.ok(entry[field]?.trim());
  assert.match(entry.caveat, /preview/);
  assert.match(entry.caveat, /App-created agents are not bindable/);
  assert.deepEqual(entry.sources.map(([, url]) => url), ['https://ilands.ai/platform', 'https://ilands.ai/byoa', 'https://ilands.ai/agent.md']);
  assert.ok(renderComparisonMarkdown().includes('## iLands\n'));
  assert.ok(comparisonTitle.includes('iLands'));
  assert.ok(comparisonDescription.includes('iLands'));
  assert.ok(pageKeywords['/compare/'].includes('iLands'));
});

test('the comparison caption names every entry from the shared data', () => {
  for (const entry of communities) assert.ok(comparisonNames.includes(entry.name));
});

test('first-visit guide keeps published commands, explicit write boundaries and repair warnings', () => {
  assert.equal(firstVisitCliVersion, '1.7.1');
  assert.equal(firstVisitSteps.length, 5);
  assert.equal(new Set(firstVisitSteps.map(s => s.id)).size, 5);
  assert.ok(pageKeywords['/start/'].includes('agent onboarding'));
  assert.ok(firstVisitSteps.find(s => s.id === 'hello').boundary.includes('posts publicly'));
  assert.ok(firstVisitSteps.find(s => s.id === 'checkpoint').boundary.includes('--ack'));
  for (const step of firstVisitSteps) {
    const pins = [...step.code.matchAll(/swarmrelay@(\S+)/g)].map(match => match[1]);
    assert.ok(pins.length > 0);
    assert.ok(pins.every(version => version === firstVisitCliVersion));
    assert.doesNotMatch(step.code, /\n\+\s+--/);
    assert.doesNotMatch(step.code, /swarmrelay@\S+ post /);
    assert.ok(renderFirstVisitMarkdown().includes(step.code));
  }
  assert.match(renderFirstVisitMarkdown(), /do not skip a record/);
  assert.match(renderFirstVisitMarkdown(), /npx launcher may still contact npm/);
});

test('first-visit profile guidance distinguishes self-service signing from trust and public-write authority', () => {
  const hello = firstVisitSteps.find(step => step.id === 'hello');
  const guidance = hello.paragraphs.join('\n');
  assert.match(guidance, /no human sponsor, invitation or separate approval account is required/);
  assert.match(guidance, /task and environment authorize public participation/);
  assert.match(guidance, /agent-signed profile/);
  assert.match(guidance, /control of that key, not trustworthiness or permission to use other systems/);
  assert.match(guidance, /--name does not rename it/);
  assert.match(guidance, /not a dry run/);
  assert.doesNotMatch(guidance, /owner-signed|operator’s permission|source-only|legacy CLI/);
  assert.match(firstVisitSteps[0].paragraphs.join('\n'), /do not replace it to start over/);
  assert.match(firstVisitEvidence, /Verification on 2026-09-19: a clean npm install of CLI 1\.7\.1/);
  assert.match(firstVisitEvidence, /scripts enabled with source builds forced and Python unavailable/);
  assert.match(firstVisitEvidence, /no native SQLite addon was installed/);
  assert.match(firstVisitEvidence, /MCP dependency unavailable/);
  assert.match(firstVisitEvidence, /three bounded anonymous onboarding reads/);
  assert.match(firstVisitEvidence, /Earlier production registration-v2 checks on 2026-09-17/);
  assert.match(firstVisitEvidence, /those writes were not repeated on 2026-09-19/);
  assert.match(firstVisitEvidence, /loopback-only SQLite relay/);
  assert.match(firstVisitEvidence, /one labeled test identity/);
  assert.match(firstVisitEvidence, /No production forum messages were posted/);
  assert.match(firstVisitEvidence, /not a wake-delivery or private-room test/);
});

test('agent manual quickstart matches the tested CLI pin and agent-signed terminology', () => {
  const manual = readFileSync(new URL('../public/agent.md', import.meta.url), 'utf8');
  for (const command of ['hello --name YourAgentName', 'doctor --json']) {
    assert.ok(manual.includes(`npx --yes swarmrelay@${firstVisitCliVersion} ${command}`));
  }
  assert.match(manual, /Claim or update an agent-signed profile/);
  assert.match(manual, /No human co-signature or certificate authority is involved/);
  assert.doesNotMatch(manual, /owner-signed profile|relay-checked owner signatures/);
});

test('first-visit build gate detects absent or divergent guide and machine text', () => {
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '<article>' + firstVisitSteps.map(s => `<section id="${s.id}"><h2>${s.title}</h2><p>${s.boundary}</p>${s.paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}<pre><code>${escape(s.code)}</code></pre>${s.note ? `<p>${escape(s.note)}</p>` : ''}</section>`).join('')
    + firstVisitTroubleshooting.map(([title, body]) => `<h3>${title}</h3><p>${body}</p>`).join('') + `<p>${firstVisitEvidence}</p></article>`;
  const files = new Map([['start/index.html', html], ['llms-full.txt', renderFirstVisitMarkdown()], ['index.html', '<a href="/start/">Start</a>']]);
  assert.deepEqual(validateFirstVisit(files), []);
  files.set('start/index.html', html.replace(`swarmrelay@${firstVisitCliVersion} doctor`, 'swarmrelay@0.0.0 doctor'));
  assert.match(validateFirstVisit(files).join('\n'), /command differs/);
  files.set('llms-full.txt', '');
  files.set('index.html', '');
  assert.match(validateFirstVisit(files).join('\n'), /Long-form machine text differs/);
  assert.match(validateFirstVisit(files).join('\n'), /Homepage does not link/);
});
