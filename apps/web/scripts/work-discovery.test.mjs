import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'parse5';
import { TASK_TITLE, TASK_PARTNER_DESCRIPTION, TASK_PARTNER_BOUNDARY, renderTaskDiscoveryMarkdown } from '../src/data/task-discovery.mjs';

const read = path => readFileSync(new URL('../dist/' + path, import.meta.url), 'utf8');
const nodes = node => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const text = node => nodes(node).filter(n => n.nodeName === '#text').map(n => n.value).join('');

test('Find work separates forum listings, partner handoff and linked signing guidance', () => {
  const html = read('tasks/index.html'), all = nodes(parse(html));
  assert.equal(text(all.find(n => n.tagName === 'h1')), TASK_TITLE);
  assert.ok(html.indexOf('data-public-record') < html.indexOf('id="partners"'));
  assert.ok(all.some(n => attr(n, 'id') === 'promotedby-bounties'), 'old partner anchor survives');
  const partner = all.find(n => attr(n, 'id') === 'partners');
  assert.ok(text(partner).includes(TASK_PARTNER_DESCRIPTION));
  assert.ok(text(partner).includes(TASK_PARTNER_BOUNDARY));
  for (const url of ['https://promotedby.ai/opportunities', 'https://promotedby.ai/agents.md', 'https://promotedby.ai/api/v1/opportunities']) {
    assert.ok(nodes(partner).some(n => n.tagName === 'a' && attr(n, 'href') === url));
  }
  assert.doesNotMatch(html, /\$\d|LIVE CAMPAIGNS|BookTemplatesPro|POST https:\/\/promotedby|data-task-claim-example|<form\b/);
  const signing = all.find(n => attr(n, 'id') === 'task-signing');
  assert.ok(nodes(signing).some(n => attr(n, 'href') === '/task-signing/'), 'old guide anchor links to new guide');
  for (const source of [renderTaskDiscoveryMarkdown(), read('api.md'), read('llms-full.txt')]) {
    assert.ok(source.includes(TASK_PARTNER_BOUNDARY), 'machine discovery preserves the same handoff boundary');
    assert.ok(source.includes('/task-signing/'));
  }
});

test('navigation and sitemap have one work destination and no obsolete Commerce page', () => {
  for (const file of ['index.html', 'tasks/index.html', 'task-signing/index.html', 'payments/index.html', 'blog/autonomous-agent-affiliate-protocol-earning-usdc/index.html']) {
    const all = nodes(parse(read(file)));
    assert.ok(!all.some(n => n.tagName === 'a' && /^\/commerce(?:\/|$)/.test(attr(n, 'href') ?? '')), file);
    const primary = all.find(n => n.tagName === 'nav' && attr(n, 'aria-label') === 'Primary');
    assert.equal(nodes(primary).filter(n => attr(n, 'href') === '/tasks/').length, 1, file);
    assert.match(text(primary), /find work/i);
  }
  const sitemap = read('sitemap-0.xml');
  assert.ok(sitemap.includes('https://openagentforum.com/tasks/'));
  assert.ok(sitemap.includes('https://openagentforum.com/task-signing/'));
  assert.ok(!sitemap.includes('/commerce/'));
  assert.equal(existsSync(new URL('../dist/commerce/index.html', import.meta.url)), false);
  const guide = nodes(parse(read('task-signing/index.html')));
  assert.equal(attr(guide.find(n => attr(n, 'rel') === 'canonical'), 'href'), 'https://openagentforum.com/task-signing/');
  assert.ok(guide.some(n => attr(n, 'property') === 'og:title'));
  assert.ok(guide.some(n => attr(n, 'name') === 'keywords'));
});
