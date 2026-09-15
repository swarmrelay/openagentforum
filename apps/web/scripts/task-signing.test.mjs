import test from 'node:test';
import assert from 'node:assert/strict';
import { taskActionString, taskActionChecksum, TASK_ACTION_SKEW_MS } from '@openagentforum/protocol';
import { taskSigningTitle, taskSigningReference, taskSigningProof, taskSigningParagraphs, taskSigningActions,
  taskSigningFailures, taskClaimExampleIntro, taskClaimExample, taskClaimExampleBoundary,
  taskSigningPaymentBoundary, renderTaskSigningMarkdown, updateTaskSigningBlock } from '../src/data/task-signing.mjs';
import { validateTaskSigning } from './check-task-signing.mjs';

const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function fixture() {
  const html = `<section id="task-signing"><h2>${taskSigningTitle}</h2>`
    + [...taskSigningParagraphs, taskSigningFailures, taskClaimExampleIntro, taskClaimExampleBoundary, taskSigningPaymentBoundary].map(p => `<p>${escape(p)}</p>`).join('')
    + `<pre><code>${escape(taskSigningProof)}</code></pre><pre><code>${escape(taskClaimExample)}</code></pre>`
    + taskSigningActions.map(a => `<div data-task-action="${a.action}">${a.label}<p>${escape(a.detail)}</p>${[a.route, a.payload, a.body].map(c => `<code>${escape(c)}</code>`).join('')}</div>`).join('')
    + `<a href="${taskSigningReference}">Reference</a><a href="/payments/">Payments</a></section>`;
  return new Map([['tasks/index.html', html], ['agent.md', renderTaskSigningMarkdown()], ['llms-full.txt', renderTaskSigningMarkdown()]]);
}

test('shared task guide matches the signed protocol format for all three actions', async () => {
  assert.equal(TASK_ACTION_SKEW_MS, 5 * 60 * 1000, 'Update the documented freshness window when the protocol changes');
  const cases = {
    create: { title: 'Local example', description: 'Test documentation', requiredCapabilities: [], timeoutMs: 3600000, reward: null },
    claim: {}, submit: { resultPayload: { message: 'Local result' } },
  };
  assert.deepEqual(taskSigningActions.map(a => a.action), Object.keys(cases));
  for (const [action, payload] of Object.entries(cases)) {
    const params = { action, taskId: action === 'create' ? '-' : 'task_fixture', agentId: 'agent_fixture', timestamp: 1700000000000, payload };
    const values = { ...params, checksum: await taskActionChecksum(payload) };
    const fromDocumentation = taskSigningProof.replace(/<(\w+)>/g, (_, key) => String(values[key]));
    assert.equal(fromDocumentation, await taskActionString(params));
  }
});

test('task guidance build gate accepts matching rendered and machine guidance', () => {
  assert.deepEqual(validateTaskSigning(fixture()), []);
});

test('task guidance gate detects missing sections, boundaries and reference links', () => {
  for (const value of ['id="task-signing"', taskSigningParagraphs[0], taskSigningParagraphs[1], taskSigningPaymentBoundary, `href="${taskSigningReference}"`]) {
    const files = fixture(); files.set('tasks/index.html', files.get('tasks/index.html').replace(value, 'removed'));
    assert.ok(validateTaskSigning(files).some(e => e.startsWith('tasks/index.html:')), value);
  }
});

test('task guidance gate checks every action payload, route and body', () => {
  for (const action of taskSigningActions) for (const value of [action.route, action.payload, action.body]) {
    const files = fixture(); files.set('tasks/index.html', files.get('tasks/index.html').replace(`<code>${escape(value)}</code>`, '<code>wrong contract</code>'));
    assert.ok(validateTaskSigning(files).some(e => e.includes('task action contract differs')), `${action.action}: ${value}`);
  }
});

test('task proof and executable excerpt must survive HTML escaping unchanged', () => {
  for (const value of [taskSigningProof, taskClaimExample]) {
    const files = fixture(); files.set('tasks/index.html', files.get('tasks/index.html').replace(escape(value), 'different bytes'));
    assert.ok(validateTaskSigning(files).some(e => e.includes('proof or claim example differs')));
  }
});

test('task guide cannot be satisfied by hidden or script-only content', () => {
  for (const wrap of [html => `<script>${html}</script>`, html => `<template>${html}</template>`, html => `<div hidden>${html}</div>`, html => `<div aria-hidden="true">${html}</div>`]) {
    const files = fixture(); files.set('tasks/index.html', wrap(files.get('tasks/index.html')));
    assert.ok(validateTaskSigning(files).some(e => e.includes('expected one task-signing section')));
  }
});

test('machine guidance must appear exactly once in both agent and long-form text', () => {
  for (const file of ['agent.md', 'llms-full.txt']) for (const value of ['', 'stale text', renderTaskSigningMarkdown().repeat(2)]) {
    const files = fixture(); files.set(file, value);
    assert.ok(validateTaskSigning(files).some(e => e.startsWith(`${file}: task signing differs`)));
  }
});

test('stale instructions fail even when correct task guidance is also present', () => {
  for (const file of ['tasks/index.html', 'agent.md', 'llms-full.txt']) for (const stale of ['optionally signing', 'signature is optional', 'claim|taskId|agentId|timestamp']) {
    const files = fixture(); files.set(file, files.get(file) + `<p>${stale}</p>`);
    assert.ok(validateTaskSigning(files).some(e => e.startsWith(`${file}: obsolete`)));
  }
});

test('task-signing generation preserves surrounding prose and is idempotent', () => {
  const start = '<!-- BEGIN GENERATED TASK SIGNING -->', end = '<!-- END GENERATED TASK SIGNING -->';
  const result = updateTaskSigningBlock(`before\n${start}\nstale\n${end}\nafter\n`);
  assert.equal(result, `before\n${start}\n${renderTaskSigningMarkdown()}${end}\nafter\n`);
  assert.equal(updateTaskSigningBlock(result), result);
  for (const source of ['', start, end, end + start, start + start + end, start + end + end]) {
    assert.throws(() => updateTaskSigningBlock(source), /exactly one ordered/);
  }
});
