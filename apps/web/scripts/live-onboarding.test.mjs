import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkLiveOnboarding } from './check-live-onboarding.mjs';
import { firstVisitSteps, firstVisitTroubleshooting, firstVisitEvidence, renderFirstVisitMarkdown } from '../src/data/first-visit.mjs';

const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const start = '<article>' + firstVisitSteps.map(step => `<section id="${step.id}"><h2>${step.title}</h2><p>${step.boundary}</p>${step.paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}<pre><code>${escape(step.code)}</code></pre>${step.note ? `<p>${escape(step.note)}</p>` : ''}</section>`).join('')
  + firstVisitTroubleshooting.map(([title, body]) => `<h3>${title}</h3><p>${body}</p>`).join('') + `<p>${firstVisitEvidence}</p></article>`;
function fixture(transform = text => text, header = 'public, max-age=0, no-transform') {
  return async (url, options) => {
    assert.equal(new URL(url).origin, 'https://openagentforum.com');
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const path = new URL(url).pathname;
    assert.ok(['/', '/start/', '/llms-full.txt'].includes(path));
    const body = path === '/' ? '<a href="/start/">Start</a>' : path === '/start/' ? transform(start) : renderFirstVisitMarkdown();
    return new Response(body, { headers: { 'Content-Type': path.endsWith('.txt') ? 'text/plain' : 'text/html', 'Cache-Control': header } });
  };
}

test('checks all five delivered commands and machine text using only fixed anonymous reads', async () => {
  assert.deepEqual(await checkLiveOnboarding(fixture()), { ok: true, checked: 3, errors: [] });
});
test('fails if edge email protection rewrites package pins, even when the build was correct', async () => {
  const result = await checkLiveOnboarding(fixture(html => html.replaceAll('swarmrelay@1.6.0', '<a class="__cf_email__" data-cfemail="00">[email&#160;protected]</a>')));
  assert.equal(result.ok, false);
  assert.equal(result.errors.filter(error => error.includes('command differs')).length, 5);
});
test('fails on absent transform protection or a version mismatch', async () => {
  assert.equal((await checkLiveOnboarding(fixture(text => text, 'max-age=0'))).ok, false);
  assert.equal((await checkLiveOnboarding(fixture(text => text.replaceAll('swarmrelay@1.6.0', 'swarmrelay@0.0.0')))).ok, false);
});
test('bounds streamed response bodies and cancels oversized streams', async () => {
  let cancelled = 0;
  const result = await checkLiveOnboarding(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled++; },
  }), { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-transform' } }));
  assert.equal(result.ok, false); assert.equal(cancelled, 3);
});
test('network errors and wrong response types fail without logging remote details', async () => {
  const failed = await checkLiveOnboarding(async () => { throw new Error('untrusted remote text'); });
  assert.equal(failed.ok, false); assert.ok(!JSON.stringify(failed).includes('untrusted remote text'));
  assert.equal((await checkLiveOnboarding(async () => new Response('not HTML'))).ok, false);
});
test('Pages protects root, canonical nested HTML paths and direct HTML paths without changing asset caching', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  for (const pattern of ['/', '/*/', '/*.html']) assert.ok(headers.includes(`${pattern}\n  Cache-Control: no-transform`));
  assert.ok(!headers.includes('/*\n  Cache-Control: no-transform'));
  assert.match(readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8'), /run: node apps\/web\/scripts\/check-live-onboarding\.mjs/);
});
