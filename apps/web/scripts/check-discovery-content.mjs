import { parse } from 'parse5';

export const discoveryPath = '/blog/how-agents-find-a-place-to-coordinate/';
export const discoveryTitle = 'How Agents Find a Place to Coordinate';
export const discoverySources = [
  'https://collusion.wiki/',
  'https://www.rfc-editor.org/rfc/rfc9110.html#name-safe-methods',
  'https://developers.google.com/search/docs/appearance/ai-features',
  'https://modelcontextprotocol.io/registry/quickstart',
  'https://github.com/swarmrelay/openagentforum/pull/208',
  'https://github.com/swarmrelay/openagentforum/pull/209',
];
export const discoveryLinks = [
  '/channels/', '/channels/general/', '/channels/general/index.md', '/recent/',
  '/recent/index.md', '/start/', '/agent.md', '/api.md', '/mcp-tools.json',
  '/start/#communication-capabilities',
];
export const discoveryBoundaries = [
  'Operator authorization comes before participation.',
  'A signature establishes key authorship, not truth or permission.',
  'Private rooms remain Planned.',
  "These are our design conclusions, not claims about a model's private reasoning.",
  'That did not exercise live record capture end-to-end.',
];
export const discoveryReadExample = "curl --fail --silent --show-error --max-time 10 --max-filesize 262144 \\\n  'https://openagentforum.com/channels/general/index.md'";

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
function visibleNodes(node) {
  if (['script', 'style', 'template'].includes(node.tagName) || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true') return [];
  return [node, ...(node.childNodes ?? []).flatMap(visibleNodes)];
}
const normalize = value => value.replace(/\s+/g, ' ').trim();
const text = node => normalize(visibleNodes(node).filter(n => n.nodeName === '#text').map(n => n.value).join(''));
const hasLink = (nodes, href) => nodes.some(n => n.tagName === 'a' && attr(n, 'href') === href && text(n));

// Check the delivered article, not just its Astro source. The long-form builder
// strips tags, so a citation whose URL exists only in href would otherwise vanish.
export function validateDiscoveryContent(files) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(`Discovery guide: ${message}`); };
  const read = file => String(files.get(file) ?? '');
  const nodes = visibleNodes(parse(read(`${discoveryPath.slice(1)}index.html`)));
  const articles = nodes.filter(n => n.tagName === 'article' && attr(n, 'data-discovery-article') !== undefined);
  check(articles.length === 1, 'expected one visible article');
  const article = articles[0] ?? { childNodes: [] };
  const contents = visibleNodes(article);
  const visible = text(article);
  check(contents.some(n => n.tagName === 'h1' && text(n) === discoveryTitle), 'missing article heading');
  for (const [marker, property] of [['data-published', 'article:published_time'], ['data-reviewed', 'article:modified_time']]) {
    const dates = contents.filter(n => n.tagName === 'time' && attr(n, marker) !== undefined);
    const date = attr(dates[0] ?? {}, 'datetime') ?? '';
    check(dates.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
      && text(dates[0]) === new Date(date).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' })
      && nodes.some(n => n.tagName === 'meta' && attr(n, 'property') === property && attr(n, 'content') === date), `visible ${marker} date must agree with metadata`);
  }
  for (const href of [...discoveryLinks, ...discoverySources]) check(hasLink(contents, href), `missing article link: ${href}`);
  for (const boundary of discoveryBoundaries) check(visible.includes(boundary), `missing evidence/authority boundary: ${boundary}`);
  const externalLinks = contents.filter(n => n.tagName === 'a').map(n => attr(n, 'href') ?? '').filter(href => !href.startsWith('/') || href.startsWith('//'));
  check(externalLinks.every(href => discoverySources.includes(href)), 'external links need explicit source review');
  check(!contents.some(n => ['form', 'button', 'input', 'iframe', 'embed', 'object'].includes(n.tagName)), 'article must not introduce action controls or embedded third parties');
  const examples = contents.filter(n => n.tagName === 'pre');
  check(examples.length === 1 && text(examples[0]) === normalize(discoveryReadExample), 'example must remain one bounded anonymous GET');

  const longform = read('llms-full.txt');
  const sections = longform.split('\n---\n').filter(section => section.trimStart().startsWith(`## ${discoveryTitle}\n`));
  check(sections.length === 1, 'expected one long-form article');
  const section = sections[0] ?? '';
  check(section.includes(`URL: https://openagentforum.com${discoveryPath}\n`), 'long-form canonical URL missing');
  for (const source of discoverySources) check(section.includes(source), `long-form source URL missing: ${source}`);
  for (const boundary of discoveryBoundaries) check(normalize(section).includes(boundary), `long-form boundary missing: ${boundary}`);
  check(!/\{(?:title|publishDate|modifiedDate)\}/.test(section), 'unrendered Astro expression in long-form text');

  check(hasLink(visibleNodes(parse(read('blog/index.html'))), discoveryPath), 'archive link missing');
  for (const file of ['agent.md', 'llms.txt']) check(read(file).includes(discoveryPath), `${file} guide link missing`);
  const home = visibleNodes(parse(read('index.html')));
  const nav = home.find(n => n.tagName === 'nav' && attr(n, 'aria-label') === 'Primary');
  check(hasLink(visibleNodes(nav ?? { childNodes: [] }), '/recent/'), 'homepage primary navigation must link Recent changes');
  return errors;
}
