import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryPath, discoveryTitle, discoverySources, discoveryLinks, discoveryBoundaries, discoveryReadExample, validateDiscoveryContent } from './check-discovery-content.mjs';

const file = `${discoveryPath.slice(1)}index.html`;
function fixture() {
  const metadata = ['published', 'modified'].map(kind => `<meta property="article:${kind}_time" content="2026-09-14">`).join('');
  const dates = ['published', 'reviewed'].map(kind => `<time data-${kind} datetime="2026-09-14">September 14, 2026</time>`).join('');
  const links = [...discoveryLinks, ...discoverySources].map(href => `<a href="${href}">${href}</a>`).join('');
  return new Map([
    [file, `${metadata}<article data-discovery-article><h1>${discoveryTitle}</h1>${dates}${links}${discoveryBoundaries.map(value => `<p>${value}</p>`).join('')}<pre><code>${discoveryReadExample}</code></pre></article>`],
    ['llms-full.txt', `base\n---\n\n## ${discoveryTitle}\nURL: https://openagentforum.com${discoveryPath}\nPublished: 2026-09-14\n\n${discoverySources.join('\n')}\n${discoveryBoundaries.join('\n')}\n---\n\n## Another article\n`],
    ['blog/index.html', `<a href="${discoveryPath}">${discoveryTitle}</a>`],
    ['agent.md', discoveryPath], ['llms.txt', discoveryPath],
    ['index.html', '<nav aria-label="Primary"><a href="/recent/">recent</a></nav>'],
  ]);
}
const mutate = (target, before, after) => {
  const files = fixture(); files.set(target, files.get(target).replace(before, after)); return files;
};

test('delivered discovery article, dates, citations and machine text agree', () => {
  assert.deepEqual(validateDiscoveryContent(fixture()), []);
});

test('missing or hidden article and mismatched visible dates fail the gate', () => {
  for (const [before, after] of [
    ['data-discovery-article', 'hidden data-discovery-article'],
    ['data-reviewed', 'data-stale'],
    ['September 14, 2026', 'September 15, 2026'],
    ['article:modified_time" content="2026-09-14', 'article:modified_time" content="2026-09-15'],
  ]) assert.ok(validateDiscoveryContent(mutate(file, before, after)).length);
});

test('article requires explicit primary sources and live participation paths', () => {
  for (const href of [...discoveryLinks, ...discoverySources]) {
    assert.ok(validateDiscoveryContent(mutate(file, `href="${href}"`, 'href="/missing/"')).includes(`Discovery guide: missing article link: ${href}`));
  }
});

test('unreviewed external links, action controls and changed commands fail the gate', () => {
  for (const inserted of ['<a href="https://example.invalid/?action=save">Edit</a>', '<a href="//example.invalid/">Elsewhere</a>', '<form><button>Join</button></form>', '<iframe src="https://example.invalid/"></iframe>']) {
    assert.ok(validateDiscoveryContent(mutate(file, '</article>', `${inserted}</article>`)).length);
  }
  assert.ok(validateDiscoveryContent(mutate(file, '--max-time 10', '--request POST')).includes('Discovery guide: example must remain one bounded anonymous GET'));
});

test('authorization, authorship, Planned rooms and evidence limits cannot drift', () => {
  for (const boundary of discoveryBoundaries) {
    assert.ok(validateDiscoveryContent(mutate(file, boundary, 'Different claim')).includes(`Discovery guide: missing evidence/authority boundary: ${boundary}`));
    assert.ok(validateDiscoveryContent(mutate('llms-full.txt', boundary, 'Different claim')).includes(`Discovery guide: long-form boundary missing: ${boundary}`));
  }
});

test('citations must survive in this article of the deployed long-form text', () => {
  for (const source of discoverySources) {
    const files = mutate('llms-full.txt', source, 'Descriptive link text only');
    files.set('llms-full.txt', files.get('llms-full.txt') + source); // Another article cannot satisfy it.
    assert.ok(validateDiscoveryContent(files).includes(`Discovery guide: long-form source URL missing: ${source}`));
  }
  for (const expression of ['{title}', '{publishDate}', '{modifiedDate}']) {
    assert.ok(validateDiscoveryContent(mutate('llms-full.txt', 'Published: 2026-09-14', expression)).includes('Discovery guide: unrendered Astro expression in long-form text'));
  }
});

test('missing or duplicated long-form article cannot silently pass', () => {
  const files = fixture(); files.set('llms-full.txt', files.get('llms-full.txt').repeat(2));
  assert.ok(validateDiscoveryContent(files).includes('Discovery guide: expected one long-form article'));
  files.set('llms-full.txt', 'Old build');
  assert.ok(validateDiscoveryContent(files).includes('Discovery guide: expected one long-form article'));
});

test('archive and machine guides must link the article; footer alone is not primary navigation', () => {
  for (const target of ['blog/index.html', 'agent.md', 'llms.txt']) {
    assert.ok(validateDiscoveryContent(mutate(target, discoveryPath, '/missing/')).length);
  }
  assert.ok(validateDiscoveryContent(mutate('index.html', 'nav aria-label="Primary"', 'nav aria-label="Footer"')).includes('Discovery guide: homepage primary navigation must link Recent changes'));
});
