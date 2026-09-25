import { parse } from 'parse5';
import { taskSigningTitle, taskSigningReference, taskSigningProof, taskSigningParagraphs, taskSigningActions,
  taskSigningFailures, taskClaimExampleIntro, taskClaimExample, taskClaimExampleBoundary,
  taskSigningPaymentBoundary, renderTaskSigningMarkdown } from '../src/data/task-signing.mjs';

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const nodes = node => ['script', 'style', 'template'].includes(node.tagName) || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true'
  ? [] : [node, ...(node.childNodes ?? []).flatMap(nodes)];
const text = node => nodes(node).filter(n => n.nodeName === '#text').map(n => n.value).join('').trim();

export function validateTaskSigning(files) {
  const errors = [];
  const page = nodes(parse(String(files.get('task-signing/index.html') ?? '')));
  const sections = page.filter(n => attr(n, 'id') === 'task-signing');
  if (sections.length !== 1) errors.push('task-signing/index.html: expected one task-signing section');
  const section = sections[0] ?? { childNodes: [] };
  const contents = nodes(section);
  const visible = text(section);
  for (const value of [taskSigningTitle, ...taskSigningParagraphs, taskSigningFailures, taskClaimExampleIntro, taskClaimExampleBoundary, taskSigningPaymentBoundary]) {
    if (!visible.includes(value)) errors.push(`task-signing/index.html: task guidance differs: ${value}`);
  }
  for (const value of [taskSigningProof, taskClaimExample]) {
    if (!contents.some(n => n.tagName === 'code' && text(n) === value)) errors.push('task-signing/index.html: task proof or claim example differs');
  }
  for (const action of taskSigningActions) {
    const rows = contents.filter(n => attr(n, 'data-task-action') === action.action);
    const row = rows[0] ?? { childNodes: [] };
    if (rows.length !== 1 || ![action.label, action.detail].every(value => text(row).includes(value))) errors.push(`task-signing/index.html: task action differs: ${action.action}`);
    for (const value of [action.route, action.payload, action.body]) {
      if (!nodes(row).some(n => n.tagName === 'code' && text(n) === value)) errors.push(`task-signing/index.html: task action contract differs: ${action.action}`);
    }
  }
  for (const href of [taskSigningReference, '/payments/']) {
    if (!contents.some(n => n.tagName === 'a' && attr(n, 'href') === href)) errors.push(`task-signing/index.html: missing task reference: ${href}`);
  }
  for (const file of ['agent.md', 'llms-full.txt']) {
    const source = String(files.get(file) ?? '');
    if (source.split(renderTaskSigningMarkdown()).length !== 2) errors.push(`${file}: task signing differs from the shared source`);
  }
  for (const file of ['task-signing/index.html', 'agent.md', 'llms-full.txt']) {
    const source = file.endsWith('.html') ? text(parse(String(files.get(file) ?? ''))) : String(files.get(file) ?? '');
    if (/optionally signing|signatures? (?:is|are) optional|(?<!task\|)claim\|/i.test(source)) errors.push(`${file}: obsolete or optional task signature instructions`);
  }
  return errors;
}
