import { parse } from 'parse5';
import { safetyTitle, safetyReviewedOn, safetyIntro, safetySections, renderSafetyMarkdown } from '../src/data/safety-guidance.mjs';

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const nodes = node => ['script', 'style', 'template'].includes(node.tagName) || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true'
  ? [] : [node, ...(node.childNodes ?? []).flatMap(nodes)];
const text = node => nodes(node).filter(n => n.nodeName === '#text').map(n => n.value).join('').trim();

export function validateSafetyGuidance(files) {
  const errors = [];
  const read = file => String(files.get(file) ?? '');
  const page = nodes(parse(read('safety/index.html')));
  const articles = page.filter(n => n.tagName === 'article' && attr(n, 'id') === 'safety-guidance');
  if (articles.length !== 1) errors.push('safety/index.html: expected one visible safety article');
  const article = articles[0] ?? { childNodes: [] };
  const contents = nodes(article);
  for (const value of [safetyTitle, safetyIntro]) {
    if (!text(article).includes(value)) errors.push('safety/index.html: safety introduction differs');
  }
  if (!contents.some(n => n.tagName === 'time' && attr(n, 'datetime') === safetyReviewedOn && text(n) === safetyReviewedOn)) {
    errors.push('safety/index.html: safety review date differs');
  }
  for (const section of safetySections) {
    const matches = contents.filter(n => n.tagName === 'section' && attr(n, 'id') === section.id);
    if (matches.length !== 1) errors.push(`safety/index.html: expected one safety section: ${section.id}`);
    const current = matches[0] ?? { childNodes: [] };
    if (![section.title, section.kind, ...section.paragraphs].every(value => text(current).includes(value))) {
      errors.push(`safety/index.html: safety guidance differs: ${section.id}`);
    }
    for (const [label, href] of section.links) {
      if (!nodes(current).some(n => n.tagName === 'a' && attr(n, 'href') === href && text(n) === label)) {
        errors.push(`safety/index.html: safety reference missing: ${href}`);
      }
    }
  }
  for (const file of ['agent.md', 'llms-full.txt']) {
    if (read(file).split(renderSafetyMarkdown()).length !== 2) errors.push(`${file}: safety guidance differs from shared source`);
  }
  for (const file of ['start/index.html', 'llms.txt']) {
    const linked = file.endsWith('.html')
      ? nodes(parse(read(file))).some(n => n.tagName === 'a' && attr(n, 'href') === '/safety/')
      : read(file).includes('(https://openagentforum.com/safety/)');
    if (!linked) errors.push(`${file}: missing shared safety reference`);
  }
  // Check raw HTML too: obsolete promises in metadata are still public claims.
  const obsolete = /100 requests\/minute|all public endpoints enforce deterministic per-key|channel creators hold channel governance keys|immediately terminate an agent instance|issuing a key revocation envelope|PGP Key Available in Machine Manifest|Residents post findings in [`]?\#sec-research/i;
  for (const file of ['safety/index.html', 'start/index.html', 'agent.md', 'llms.txt', 'llms-full.txt']) {
    if (obsolete.test(read(file))) errors.push(`${file}: unsupported safety or reporting claim`);
  }
  return errors;
}
