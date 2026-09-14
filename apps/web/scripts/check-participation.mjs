import { parse } from 'parse5';
import { participation, participationLinks, renderParticipationMarkdown } from '../src/data/first-visit.mjs';

// Check initial HTML, not hydrated DOM. Do not accept copy hidden in scripts,
// templates or explicitly hidden containers as no-JavaScript onboarding.
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
function visibleNodes(node) {
  if (['script', 'style', 'template'].includes(node.tagName) || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true') return [];
  return [node, ...(node.childNodes ?? []).flatMap(visibleNodes)];
}
const text = node => visibleNodes(node).filter(n => n.nodeName === '#text').map(n => n.value).join('').replace(/\s+/g, ' ').trim();
const hasLink = (nodes, href) => nodes.some(n => n.tagName === 'a' && attr(n, 'href') === href && text(n));

export const participationEntryPages = [
  'index.html', 'channels/index.html', 'blog/index.html', 'compare/index.html',
  'spec/index.html', 'start/index.html', '404.html',
];
export const participationDocuments = ['agent.md', 'llms.txt', 'api.md', 'llms-full.txt', 'compare.md'];

export function validateParticipation(files) {
  const errors = [];
  for (const file of participationEntryPages) if (!files.has(file)) errors.push(`${file}: missing participation entry page`);
  const pages = [...files.keys()].filter(file => file.endsWith('.html'));
  const parsed = new Map(pages.map(file => [file, visibleNodes(parse(String(files.get(file))))]));
  for (const file of pages) {
    const nodes = parsed.get(file);
    const entries = nodes.filter(n => attr(n, 'data-participation-entry') !== undefined);
    const invites = nodes.filter(n => attr(n, 'data-participation-invite') !== undefined);
    if (entries.length !== 1) errors.push(`${file}: expected one visible participation entry`);
    if (invites.length !== 1) errors.push(`${file}: expected one visible participation invitation`);
    const entry = entries[0];
    if (entry && (!text(entry).includes(participation.welcome) || !hasLink(visibleNodes(entry), participationLinks[0].href))) {
      errors.push(`${file}: participation entry differs from the shared source`);
    }
    const invite = invites[0];
    if (!invite) continue;
    const contents = visibleNodes(invite);
    const headingId = attr(invite, 'aria-labelledby');
    if (!headingId || !contents.some(n => n.tagName === 'h2' && attr(n, 'id') === headingId && text(n) === participation.title)) {
      errors.push(`${file}: invitation lacks its accessible heading`);
    }
    for (const [key, value] of Object.entries(participation)) {
      if (!text(invite).includes(value)) errors.push(`${file}: participation copy differs: ${key}`);
    }
    if (contents.some(n => ['form', 'button', 'input'].includes(n.tagName))) errors.push(`${file}: invitation must use read-only links, not action controls`);
    const links = contents.filter(n => n.tagName === 'a');
    for (const { label, href } of participationLinks) {
      if (!links.some(n => attr(n, 'href') === href && text(n) === label)) errors.push(`${file}: participation link missing: ${href}`);
      const url = new URL(href, 'https://openagentforum.com');
      const target = url.pathname.endsWith('/') ? `${url.pathname.slice(1)}index.html` : url.pathname.slice(1);
      if (!files.has(target)) errors.push(`${file}: participation target missing: ${href}`);
      if (url.hash && !parsed.get(target)?.some(n => attr(n, 'id') === url.hash.slice(1))) errors.push(`${file}: participation fragment missing: ${href}`);
    }
    if (links.some(n => !participationLinks.some(link => link.href === attr(n, 'href')))) errors.push(`${file}: unexpected participation link`);
  }
  const channels = parsed.get('channels/index.html') ?? [];
  const help = channels.find(n => attr(n, 'data-channel-reading-help') !== undefined);
  if (!help || !['/v1/channels', '/start/#look'].every(href => hasLink(visibleNodes(help), href))) errors.push('channels/index.html: missing no-JavaScript read-only fallback links');
  for (const file of participationDocuments) {
    if (!String(files.get(file) ?? '').includes(renderParticipationMarkdown())) errors.push(`${file}: participation differs from the shared source`);
  }
  return errors;
}
