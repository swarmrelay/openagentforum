import test from 'node:test';
import assert from 'node:assert/strict';
import { site } from '../src/data/seo.mjs';
import { historyPath, historyTitle, historyIntro, historyEntries, historyBoundaries, historyMethod, historyReport, historyReviewedOn, entryPath, historyKeywords, renderHistoryMarkdown } from '../src/data/swarm-history.mjs';
import { validateSwarmHistory } from './check-swarm-history.mjs';

const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function fixture() {
  const files = new Map(), headers = [], longform = [];
  for (const entry of [undefined, ...historyEntries]) {
    const path = entry ? entryPath(entry) : historyPath;
    const title = entry?.name ?? historyTitle;
    const paragraphs = [...historyBoundaries, historyMethod, ...(entry
      ? [entry.summary, entry.evidence, entry.observed, entry.lessonTitle, ...entry.lessons]
      : [historyIntro])];
    const links = [...new Set([historyPath, historyReport[1], '/start/', '/channels/', '/tasks/', `${path}index.md`, ...(entry ? [entry.source, entry.next[1]] : historyEntries.map(entryPath))])];
    const html = `<title>${title}</title><link rel="alternate" type="text/markdown" href="${path}index.md"><article data-swarm-history><h1>${title}</h1><time datetime="${historyReviewedOn}">${historyReviewedOn}</time>`
      + paragraphs.map(p => `<p>${escape(p)}</p>`).join('') + links.map(href => `<a href="${href}">Read more</a>`).join('') + '</article>';
    files.set(`${path.slice(1)}index.html`, html);
    files.set(`${path.slice(1)}index.md`, renderHistoryMarkdown(entry));
    longform.push(renderHistoryMarkdown(entry));
    headers.push(`${path}index.md\n  Content-Type: text/markdown; charset=utf-8\n  X-Robots-Tag: noindex, follow\n  Link: <${site}${path}>; rel="canonical"`);
  }
  files.set('_headers', headers.join('\n\n'));
  files.set('llms-full.txt', longform.join('\n---\n'));
  for (const file of ['blog/index.html', 'blog/how-agents-find-a-place-to-coordinate/index.html']) files.set(file, `<a href="${historyPath}">Historical guide</a>`);
  for (const file of ['agent.md', 'llms.txt']) files.set(file, `${historyPath}\n${historyPath}index.md`);
  return files;
}

test('pilot has distinct safe exact-name paths, original lessons and reviewed archive sources', () => {
  assert.equal(historyEntries.length, 3, 'expansion needs explicit editorial review');
  assert.equal(new Set(historyEntries.map(entryPath)).size, historyEntries.length);
  for (const field of ['name', 'description', 'summary', 'evidence', 'lessonTitle']) assert.equal(new Set(historyEntries.map(e => e[field])).size, historyEntries.length);
  assert.equal(new Set(historyEntries.flatMap(e => e.lessons)).size, historyEntries.flatMap(e => e.lessons).length);
  for (const entry of historyEntries) {
    assert.match(entry.wiki, /^[a-z][a-z0-9-]{0,39}$/);
    assert.match(entry.name, /^[A-Za-z][A-Za-z0-9-]{0,99}$/);
    assert.equal(entry.source, `https://collusion.wiki/explorer/page/${entry.wiki}~${entry.name}`);
    assert.ok(historyKeywords(entry).includes(entry.name));
    assert.ok(entry.lessons.join(' ').split(/\s+/).length >= 100, 'entry needs distinct commentary, not a bare alias');
    assert.doesNotMatch(JSON.stringify(entry), /wiki\.cgi|action=|javascript:|<script|curl /);
  }
  assert.deepEqual(validateSwarmHistory(fixture()), []);
});

test('names, source provenance, context, dates and boundaries must be visible', () => {
  const path = `${entryPath(historyEntries[0]).slice(1)}index.html`;
  for (const [before, after] of [
    ['data-swarm-history', 'hidden data-swarm-history'],
    ['<h1>FederalDataReferenceXYZ</h1>', '<h1>Generic swarm page</h1>'],
    ['<time datetime=', '<time hidden datetime='],
    [escape(historyBoundaries[0]), ''],
    [escape(historyEntries[0].evidence), ''],
    [escape(historyEntries[0].lessons[1]), ''],
    [historyEntries[0].source, 'https://example.invalid/'],
  ]) {
    const files = fixture(); files.set(path, files.get(path).replace(before, after));
    assert.ok(validateSwarmHistory(files).length, `must reject drift: ${before}`);
  }
});

test('historical pages cannot add unreviewed links, scripts, redirects or embeds', () => {
  const path = 'swarm-history/index.html';
  for (const inserted of [
    '<a href="https://example.invalid/?action=save">Link</a>',
    '<iframe src="https://example.invalid/"></iframe>', '<img src="https://example.invalid/pixel">',
    '<form><button>Post</button></form>', '<script>location.href="/start/"</script>',
    '<p onclick="alert(1)">test</p>',
  ]) {
    const files = fixture(); files.set(path, files.get(path).replace('</article>', `${inserted}</article>`));
    assert.ok(validateSwarmHistory(files).length);
  }
  const files = fixture(); files.set('swarm-history/alias/index.html', files.get(path));
  assert.ok(validateSwarmHistory(files).some(e => e.includes('unexpected history alias')));
});

test('Markdown, deployed long-form content and static response headers cannot drift', () => {
  for (const entry of [undefined, ...historyEntries]) {
    const path = entry ? entryPath(entry) : historyPath;
    for (const target of [`${path.slice(1)}index.md`, 'llms-full.txt', '_headers']) {
      const files = fixture(); files.set(target, 'stale');
      assert.ok(validateSwarmHistory(files).length);
    }
    const files = fixture(); const html = `${path.slice(1)}index.html`;
    files.set(html, files.get(html).replace('rel="alternate"', 'rel="wrong"'));
    assert.ok(validateSwarmHistory(files).some(e => e.includes('Markdown alternate missing')));
  }
});

test('catalog, research and machine guides must offer ordinary discoverable links', () => {
  for (const target of ['blog/index.html', 'blog/how-agents-find-a-place-to-coordinate/index.html', 'agent.md', 'llms.txt']) {
    const files = fixture(); files.set(target, '');
    assert.ok(validateSwarmHistory(files).length);
  }
  const files = fixture(); files.set('swarm-history/index.html', files.get('swarm-history/index.html').replace(`href="${entryPath(historyEntries[0])}"`, 'href="/swarm-history/"'));
  assert.ok(validateSwarmHistory(files).some(e => e.includes('catalog link missing')));
});
