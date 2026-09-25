import { parse } from 'parse5';
import { featureCatalogReviewedOn, featureCatalogTitle, featureCatalogScope, featureCatalog, rfcCatalog, rfcUrl, renderFeatureCatalogMarkdown } from '../src/data/feature-catalog.mjs';

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
function visibleNodes(node) {
  if (['script', 'style', 'template'].includes(node.tagName) || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true') return [];
  return [node, ...(node.childNodes ?? []).flatMap(visibleNodes)];
}
const normalize = value => value.replace(/\s+/g, ' ').trim();
const text = node => normalize(visibleNodes(node).filter(n => n.nodeName === '#text').map(n => n.value).join(''));
const hasLink = (nodes, href) => nodes.some(n => n.tagName === 'a' && attr(n, 'href') === href && text(n));

export function validateFeatureCatalog(files) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(`Feature catalog: ${message}`); };
  const read = file => String(files.get(file) ?? '');
  const nodes = visibleNodes(parse(read('spec/index.html')));
  const map = nodes.filter(n => attr(n, 'id') === 'feature-map');
  check(map.length === 1, 'expected one visible feature map');
  const contents = visibleNodes(map[0] ?? { childNodes: [] });
  const visible = text(map[0] ?? { childNodes: [] });
  check(visible.includes(featureCatalogTitle) && visible.includes(featureCatalogScope), 'map title/scope differs');
  check(contents.some(n => n.tagName === 'time' && attr(n, 'datetime') === featureCatalogReviewedOn), 'review date differs');
  for (const feature of featureCatalog) {
    const rows = contents.filter(n => attr(n, 'id') === `feature-${feature.id}`);
    const row = rows[0] ?? { childNodes: [] };
    check(rows.length === 1 && [feature.name, feature.status, feature.detail].every(v => text(row).includes(normalize(v))), `feature differs: ${feature.id}`);
    for (const link of feature.links) check(hasLink(visibleNodes(row), link.href), `missing documentation link: ${feature.id}: ${link.href}`);
  }
  const rfcs = nodes.filter(n => attr(n, 'id') === 'rfc-index');
  check(rfcs.length === 1, 'expected one visible RFC index');
  const rfcNodes = visibleNodes(rfcs[0] ?? { childNodes: [] });
  for (const rfc of rfcCatalog) {
    check(rfcNodes.some(n => n.tagName === 'li' && text(n).includes(rfc.title) && text(n).includes(rfc.status)
      && hasLink(visibleNodes(n), rfcUrl(rfc.file))), `missing RFC or status: ${rfc.file}`);
  }
  for (const file of ['api.md', 'llms-full.txt']) check(read(file).includes(renderFeatureCatalogMarkdown()), `${file}: generated catalog differs`);
  for (const file of ['index.html', 'start/index.html']) check(hasLink(visibleNodes(parse(read(file))), '/spec/#feature-map'), `${file}: missing feature-map entry`);
  // Regression checks for the contradictions found in #263. Check the actual
  // endpoint row, not a second "live" claim elsewhere in the same document.
  const hooks = nodes.find(n => attr(n, 'class')?.split(/\s+/).includes('sp-ep')
    && visibleNodes(n).some(c => c.tagName === 'code' && text(c) === '/v1/agents/{id}/hooks')
    && visibleNodes(n).some(c => c.tagName === 'span' && text(c) === 'POST'));
  check(hooks && !attr(hooks, 'class').split(/\s+/).includes('planned') && /live on Pages production/.test(text(hooks))
    && /published in CLI 1\.5\.0 \/ SDK 2\.3\.0/.test(text(hooks)) && !/not live/.test(text(hooks)), 'wake endpoint must agree with live/published status');
  const spec = text({ childNodes: nodes.filter(n => n.tagName === 'body') });
  check(!/operator-blind private channels|self-host the identical surface|once RFC 0002 lands/.test(spec), 'stale security or availability claim');
  check(spec.includes('Deadline-derived closure emits no new envelope or wake notification'), 'missing derived-closure wake limit');
  return errors;
}
