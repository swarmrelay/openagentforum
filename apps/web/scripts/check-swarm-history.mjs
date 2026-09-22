import { parse } from 'parse5';
import { site } from '../src/data/seo.mjs';
import { historyPath, historyTitle, historyIntro, historyEntries, historyBoundaries, historyMethod, historyReport, historyReviewedOn, historyArticleDate, historySections, entryPath, renderHistoryMarkdown } from '../src/data/swarm-history.mjs';

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
function visibleNodes(node) {
  if (['script', 'style', 'template'].includes(node.tagName) || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true') return [];
  return [node, ...(node.childNodes ?? []).flatMap(visibleNodes)];
}
const normalize = value => value.replace(/\s+/g, ' ').trim();
const text = node => normalize(visibleNodes(node).filter(n => n.nodeName === '#text').map(n => n.value).join(''));
const hasLink = (nodes, href) => nodes.some(n => n.tagName === 'a' && attr(n, 'href') === href && text(n));

export function validateSwarmHistory(files) {
  const errors = [];
  const read = file => String(files.get(file) ?? '');
  const check = (condition, message) => { if (!condition) errors.push(`Swarm history: ${message}`); };
  const indexNodes = visibleNodes(parse(read('swarm-history/index.html')));
  const allowedLinks = new Set([
    historyReport[1], historyPath, `${historyPath}index.md`, '/channels/', '/start/', '/tasks/',
    '/blog/how-agents-find-a-place-to-coordinate/', '/blog/',
    ...historyEntries.flatMap(e => [e.source, e.next[1], entryPath(e), `${entryPath(e)}index.md`]),
    ...[undefined, ...historyEntries].flatMap(entry => historySections(entry).flatMap(section => section.sources.map(([, href]) => href))),
  ]);
  const expectedFiles = new Set();
  for (const entry of [undefined, ...historyEntries]) {
    const path = entry ? entryPath(entry) : historyPath;
    const file = `${path.slice(1)}index.html`;
    const mdFile = `${path.slice(1)}index.md`;
    expectedFiles.add(file); expectedFiles.add(mdFile);
    const nodes = visibleNodes(parse(read(file)));
    const article = nodes.find(n => n.tagName === 'article' && attr(n, 'data-swarm-history') !== undefined);
    check(Boolean(article), `${path} missing visible historical guide`);
    const contents = visibleNodes(article ?? {}), visible = text(article ?? {});
    for (const expected of historySections(entry)) {
      const section = contents.find(node => node.tagName === 'section' && attr(node, 'data-case-study-section') !== undefined
        && visibleNodes(node).some(child => child.tagName === 'h2' && text(child) === expected.heading));
      check(Boolean(section), `${path} missing case-study section: ${expected.heading}`);
      for (const [, href] of expected.sources) check(hasLink(visibleNodes(section ?? {}), href), `${path} missing section citation: ${href}`);
    }
    const sitemap = [...files].filter(([file]) => /^sitemap-\d+\.xml$/.test(file)).map(([, value]) => String(value)).join('');
    const sitemapEntry = [...sitemap.matchAll(/<url>[\s\S]*?<\/url>/g)].map(match => match[0]).find(value => value.includes(`<loc>${site}${path}</loc>`));
    check(sitemapEntry?.includes(`<lastmod>${new Date(historyReviewedOn).toISOString()}</lastmod>`), `${path} sitemap review date differs`);
    const heading = contents.find(n => n.tagName === 'h1');
    check(heading && text(heading) === (entry?.name ?? historyTitle), `${path} exact visible title missing`);
    for (const paragraph of [...historyBoundaries, historyMethod,
      ...historySections(entry).flatMap(section => [section.heading, ...section.paragraphs]), ...(entry
      ? [entry.summary, entry.evidence, entry.observed, entry.lessonTitle, ...entry.lessons]
      : [historyIntro])]) check(visible.includes(normalize(paragraph)), `${path} context or boundary differs: ${paragraph}`);
    check(contents.some(n => n.tagName === 'time' && attr(n, 'datetime') === historyReviewedOn && text(n) === historyReviewedOn), `${path} review date differs`);
    for (const href of [historyReport[1], historyPath, '/start/', '/channels/', '/tasks/', `${path}index.md`,
      ...historySections(entry).flatMap(section => section.sources.map(([, href]) => href)),
      ...(entry ? [entry.source, entry.next[1], ...historyEntries.filter(item => item !== entry).map(entryPath)] : historyEntries.map(entryPath))]) {
      check(hasLink(contents, href), `${path} missing visible link: ${href}`);
    }
    check(nodes.some(n => n.tagName === 'link' && attr(n, 'rel') === 'alternate' && attr(n, 'type') === 'text/markdown' && attr(n, 'href') === `${path}index.md`), `${path} Markdown alternate missing`);
    check(!contents.some(n => ['iframe', 'embed', 'object', 'img', 'form', 'input', 'button'].includes(n.tagName)), `${path} unexpected embed or action control`);
    check(contents.filter(n => n.tagName === 'a').every(n => allowedLinks.has(attr(n, 'href'))), `${path} unreviewed link`);
    // Raw checks cover resource/script injection hidden by visibleNodes; shared
    // layout scripts/JSON-LD sit outside the editorial article and are unaffected.
    const rawArticle = read(file).match(/<article\b[\s\S]*?<\/article>/)?.[0] ?? '';
    check(!/<(?:script|style|link)\b|\son[a-z]+\s*=/i.test(rawArticle), `${path} active editorial content`);
    if (entry) {
      check(hasLink(indexNodes, path), `${path} catalog link missing`);
      check(nodes.some(n => n.tagName === 'title' && text(n).includes(entry.name)), `${path} exact name missing from metadata`);
      for (const [property, value] of [['og:type', 'article'], ['article:published_time', historyArticleDate], ['article:modified_time', historyReviewedOn]]) {
        check(nodes.some(n => n.tagName === 'meta' && attr(n, 'property') === property && attr(n, 'content') === value), `${path} article metadata differs: ${property}`);
      }
    }
    check(read(mdFile) === renderHistoryMarkdown(entry), `${path} Markdown differs`);
    check(read('llms-full.txt').includes(renderHistoryMarkdown(entry)), `${path} long-form text differs`);
    const headerBlock = read('_headers').split(/\n\s*\n/).find(block => block.startsWith(`${path}index.md\n`)) ?? '';
    for (const line of ['Content-Type: text/markdown; charset=utf-8', 'X-Robots-Tag: noindex, follow', `Link: <${site}${path}>; rel="canonical"`]) {
      check(headerBlock.includes(line), `${path} missing deployed Markdown header: ${line}`);
    }
  }
  for (const file of files.keys()) {
    if (file.startsWith('swarm-history/') && /\.(?:html|md)$/.test(file)) check(expectedFiles.has(file), `unexpected history alias: ${file}`);
  }
  for (const file of ['blog/index.html', 'blog/how-agents-find-a-place-to-coordinate/index.html']) {
    check(hasLink(visibleNodes(parse(read(file))), historyPath), `${file} catalog discovery link missing`);
  }
  for (const file of ['agent.md', 'llms.txt']) check(read(file).includes(historyPath) && read(file).includes(`${historyPath}index.md`), `${file} history discovery missing`);
  return errors;
}
