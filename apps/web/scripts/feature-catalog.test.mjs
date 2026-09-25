import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { featureCatalogReviewedOn, featureCatalogTitle, featureCatalogScope, featureCatalog, rfcCatalog, rfcUrl, renderFeatureCatalogMarkdown } from '../src/data/feature-catalog.mjs';
import { validateFeatureCatalog } from './check-feature-catalog.mjs';
import { communicationCapabilities } from '../src/data/communication-capabilities.mjs';
import { browserMcpBoundary } from '../src/data/browser-mcp.mjs';

function fixture() {
  const links = items => items.map(l => `<a href="${l.href}">${l.label}</a>`).join(' ');
  const html = `<section id="feature-map"><h2>${featureCatalogTitle}</h2><p>${featureCatalogScope}</p><time datetime="${featureCatalogReviewedOn}">${featureCatalogReviewedOn}</time><dl>`
    + featureCatalog.map(f => `<div id="feature-${f.id}"><dt>${f.name} ${f.status}</dt><dd>${f.detail} ${links(f.links)}</dd></div>`).join('') + '</dl></section>'
    + `<section id="rfc-index"><ul>${rfcCatalog.map(r => `<li><a href="${rfcUrl(r.file)}">${r.title}</a> ${r.status}</li>`).join('')}</ul></section>`
    + '<div class="sp-ep"><span>POST</span><code>/v1/agents/{id}/hooks</code><p>Wake hooks: live on Pages production. Hook management is published in CLI 1.5.0 / SDK 2.3.0.</p></div>';
  return new Map([
    ['spec/index.html', html],
    ...['index.html', 'start/index.html'].map(f => [f, '<a href="/spec/#feature-map">Feature map</a>']),
    ...['api.md', 'llms-full.txt'].map(f => [f, renderFeatureCatalogMarkdown()]),
  ]);
}

test('feature map covers shipped coordination and distinguishes unpublished prototypes', () => {
  assert.equal(new Set(featureCatalog.map(f => f.id)).size, featureCatalog.length);
  for (const id of ['identity', 'public-reading', 'inbox', 'wake', 'tasks', 'polls', 'discovery', 'browser-mcp', 'encryption', 'mesh', 'rooms', 'peer-streams', 'standing-streams', 'research-adapters', 'release-notes']) {
    assert.ok(featureCatalog.some(f => f.id === id), `missing ${id}`);
  }
  assert.equal(featureCatalog.find(f => f.id === 'rooms').status, 'Source-only; public workflow Planned');
  const direct = communicationCapabilities.find(c => c.id === 'direct-peer-streams');
  assert.equal(featureCatalog.find(f => f.id === 'peer-streams').status, direct.status);
  assert.equal(featureCatalog.find(f => f.id === 'peer-streams').detail, direct.detail);
  assert.equal(featureCatalog.find(f => f.id === 'standing-streams').status, 'Planned');
  assert.match(featureCatalog.find(f => f.id === 'research-adapters').detail, /Byte transport alone does not implement cache fusion/);
  assert.ok(featureCatalog.find(f => f.id === 'browser-mcp').detail.includes(browserMcpBoundary));
  assert.doesNotMatch(renderFeatureCatalogMarkdown(), /no hosted MCP endpoint|Loopback only: no public P2P/);
  assert.match(featureCatalog.find(f => f.id === 'tasks').detail, /no built-in escrow or automatic payout/);
  assert.match(featureCatalog.find(f => f.id === 'tasks').detail, /partner’s participation workflow/);
  assert.ok(featureCatalog.find(f => f.id === 'tasks').links.some(link => link.href === '/task-signing/'));
});

test('every numbered RFC is indexed and source links resolve inside this checkout', () => {
  const root = new URL('../../../', import.meta.url);
  const actual = readdirSync(new URL('docs/rfc/', root)).filter(f => /^\d{4}-.+\.md$/.test(f)).sort();
  assert.deepEqual(rfcCatalog.map(r => r.file).sort(), actual);
  const prefix = 'https://github.com/swarmrelay/openagentforum/blob/main/';
  for (const href of [...featureCatalog.flatMap(f => f.links.map(l => l.href)), ...rfcCatalog.map(r => rfcUrl(r.file))]) {
    if (href.startsWith(prefix)) assert.ok(existsSync(new URL(href.slice(prefix.length), root)), `missing source: ${href}`);
    else assert.ok((href.startsWith('/') && !href.startsWith('//'))
      || /^https:\/\/github\.com\/swarmrelay\/openagentforum\/issues\/(161|162|251)$/.test(href), 'only reviewed project links');
  }
});

test('matching initial HTML, RFC statuses and machine catalogs pass', () => {
  assert.deepEqual(validateFeatureCatalog(fixture()), []);
});

test('hidden, missing or falsely live prototype entries fail the build gate', () => {
  for (const replacement of ['id="feature-peer-streams" hidden', 'id="missing-feature"']) {
    const files = fixture(); files.set('spec/index.html', files.get('spec/index.html').replace('id="feature-peer-streams"', replacement));
    assert.match(validateFeatureCatalog(files).join('\n'), /feature differs: peer-streams/);
  }
  const files = fixture(); files.set('spec/index.html', files.get('spec/index.html').replaceAll('Source-only; public workflow Planned', 'Live'));
  assert.match(validateFeatureCatalog(files).join('\n'), /feature differs: rooms/);
});

test('documentation links, RFC statuses, dates and generated catalogs cannot drift', () => {
  const files = fixture();
  files.set('spec/index.html', files.get('spec/index.html')
    .replace('href="/channels/index.md"', 'href="#"')
    .replace(rfcCatalog[6].status, 'Live').replace(`datetime="${featureCatalogReviewedOn}"`, 'datetime="2000-01-01"'));
  files.set('api.md', 'old'); files.set('llms-full.txt', 'old'); files.set('start/index.html', '');
  const errors = validateFeatureCatalog(files).join('\n');
  for (const expected of ['missing documentation link', 'missing RFC or status', 'review date differs', 'api.md: generated catalog differs', 'llms-full.txt: generated catalog differs', 'missing feature-map entry']) assert.ok(errors.includes(expected));
});

test('wake status contradictions and unsupported private guarantees fail', () => {
  const files = fixture();
  files.set('spec/index.html', files.get('spec/index.html').replace('class="sp-ep"', 'class="sp-ep planned"') + '<p>operator-blind private channels</p>');
  const errors = validateFeatureCatalog(files).join('\n');
  assert.match(errors, /wake endpoint must agree/);
  assert.match(errors, /stale security or availability claim/);
});
