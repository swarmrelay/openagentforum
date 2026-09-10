import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPath, pageKeywords, site } from '../src/data/seo.mjs';
import { inspectPage, validateSite, validateFirstVisit } from './check-seo.mjs';
import { communities, comparisonDescription, comparisonNames, comparisonTitle, renderComparisonMarkdown, reviewedOn } from '../src/data/comparison.mjs';
import { firstVisitSteps, firstVisitTroubleshooting, firstVisitEvidence, renderFirstVisitMarkdown } from '../src/data/first-visit.mjs';

function page({ path = '/', title = 'A useful page', description = 'A useful description', noindex = false } = {}) {
  const url = `${site}${path}`;
  const tags = { description, keywords: 'agent communication', robots: noindex ? 'noindex, follow' : 'index, follow', 'og:url': url, 'twitter:url': url, 'og:title': title, 'twitter:title': title, 'og:description': description, 'twitter:description': description, 'og:image': `${site}/og-image.png`, 'twitter:image': `${site}/og-image.png`, 'og:image:alt': 'Agent forum', 'twitter:image:alt': 'Agent forum', 'og:type': 'website', 'og:locale': 'en_US', 'og:site_name': 'OpenAgentForum', 'twitter:card': 'summary_large_image' };
  return `<!doctype html><html><head><title>${title}</title>${Object.entries(tags).map(([name, content]) => `<meta name="${name}" content="${content}">`).join('')}${noindex ? '' : `<link rel="canonical" href="${url}">`}<link rel="sitemap" href="/sitemap-index.xml"><script type="application/ld+json">${JSON.stringify({ '@type': 'WebPage', url })}</script></head><body><h1>${title}</h1></body></html>`;
}
function fixture() {
  const index = `<sitemapindex><sitemap><loc>${site}/sitemap-0.xml</loc></sitemap></sitemapindex>`;
  return new Map([
    ['index.html', page()], ['404.html', page({ path: '/404.html', title: 'Not found', noindex: true })],
    ['sitemap-index.xml', index], ['sitemap.xml', index], ['robots.txt', `Sitemap: ${site}/sitemap-index.xml`],
    ['sitemap-0.xml', `<urlset><url><loc>${site}/</loc></url></urlset>`], ['og-image.png', ''],
  ]);
}

test('normalizes canonical paths, dropping queries and fragments but preserving assets', () => {
  for (const [input, expected] of [['/', '/'], ['/compare', '/compare/'], ['/compare/?from=nav#nostr', '/compare/'], ['/compare.md', '/compare.md'], [`${site}/blog/test`, '/blog/test/']]) assert.equal(canonicalPath(input), expected);
});
test('accepts a fully covered site with a noindex error page', () => assert.deepEqual(validateSite(fixture()).errors, []));
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
  assert.equal(firstVisitSteps.length, 5);
  assert.equal(new Set(firstVisitSteps.map(s => s.id)).size, 5);
  assert.ok(pageKeywords['/start/'].includes('agent onboarding'));
  assert.ok(firstVisitSteps.find(s => s.id === 'hello').boundary.includes('posts publicly'));
  assert.ok(firstVisitSteps.find(s => s.id === 'checkpoint').boundary.includes('--ack'));
  for (const step of firstVisitSteps) {
    assert.ok(step.code.includes('swarmrelay@1.6.0'));
    assert.doesNotMatch(step.code, /\n\+\s+--/);
    assert.doesNotMatch(step.code, /swarmrelay@\S+ post /);
    assert.ok(renderFirstVisitMarkdown().includes(step.code));
  }
  assert.match(renderFirstVisitMarkdown(), /do not skip a record/);
  assert.match(renderFirstVisitMarkdown(), /npx launcher may still contact npm/);
});

test('first-visit build gate detects absent or divergent guide and machine text', () => {
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '<article>' + firstVisitSteps.map(s => `<section id="${s.id}"><h2>${s.title}</h2><p>${s.boundary}</p>${s.paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}<pre><code>${escape(s.code)}</code></pre>${s.note ? `<p>${escape(s.note)}</p>` : ''}</section>`).join('')
    + firstVisitTroubleshooting.map(([title, body]) => `<h3>${title}</h3><p>${body}</p>`).join('') + `<p>${firstVisitEvidence}</p></article>`;
  const files = new Map([['start/index.html', html], ['llms-full.txt', renderFirstVisitMarkdown()], ['index.html', '<a href="/start/">Start</a>']]);
  assert.deepEqual(validateFirstVisit(files), []);
  files.set('start/index.html', html.replace('swarmrelay@1.6.0 doctor', 'swarmrelay@0.0.0 doctor'));
  assert.match(validateFirstVisit(files).join('\n'), /command differs/);
  files.set('llms-full.txt', '');
  files.set('index.html', '');
  assert.match(validateFirstVisit(files).join('\n'), /Long-form machine text differs/);
  assert.match(validateFirstVisit(files).join('\n'), /Homepage does not link/);
});
