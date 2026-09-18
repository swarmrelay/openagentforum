import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkLiveOnboarding, checkDeployedOnboarding } from './check-live-onboarding.mjs';
import { firstVisitCliVersion, firstVisitSteps, firstVisitTroubleshooting, firstVisitEvidence, renderFirstVisitMarkdown } from '../src/data/first-visit.mjs';

const packagePin = `swarmrelay@${firstVisitCliVersion}`;

const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const start = '<article>' + firstVisitSteps.map(step => `<section id="${step.id}"><h2>${step.title}</h2><p>${step.boundary}</p>${step.paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}<pre><code>${escape(step.code)}</code></pre>${step.note ? `<p>${escape(step.note)}</p>` : ''}</section>`).join('')
  + firstVisitTroubleshooting.map(([title, body]) => `<h3>${title}</h3><p>${body}</p>`).join('') + `<p>${firstVisitEvidence}</p></article>`;
function fixture(transform = text => text, header = 'public, max-age=0, no-transform', markdown = renderFirstVisitMarkdown()) {
  return async (url, options) => {
    assert.equal(new URL(url).origin, 'https://openagentforum.com');
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const path = new URL(url).pathname;
    assert.ok(['/', '/start/', '/llms-full.txt'].includes(path));
    const body = path === '/' ? '<a href="/start/">Start</a>' : path === '/start/' ? transform(start) : markdown;
    return new Response(body, { headers: { 'Content-Type': path.endsWith('.txt') ? 'text/plain' : 'text/html', 'Cache-Control': header } });
  };
}

test('checks all five delivered commands and machine text using only fixed anonymous reads', async () => {
  assert.deepEqual(await checkLiveOnboarding(fixture()), { ok: true, checked: 3, errors: [] });
});
test('fails if edge email protection rewrites package pins, even when the build was correct', async () => {
  const result = await checkLiveOnboarding(fixture(html => html.replaceAll(packagePin, '<a class="__cf_email__" data-cfemail="00">[email&#160;protected]</a>')));
  assert.equal(result.ok, false);
  assert.equal(result.errors.filter(error => error.includes('command differs')).length, 5);
});
test('fails on absent transform protection or a version mismatch', async () => {
  assert.equal((await checkLiveOnboarding(fixture(text => text, 'max-age=0'))).ok, false);
  assert.equal((await checkLiveOnboarding(fixture(text => text.replaceAll(packagePin, 'swarmrelay@0.0.0')))).ok, false);
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
  const workflow = readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /timeout-minutes: 3\n\s+run: node apps\/web\/scripts\/check-live-onboarding\.mjs --after-deploy\n/);
});

// Mock delays and complete rounds: these tests never contact the hub or sleep.
const stale = () => fixture(undefined, undefined, 'previous deployment: untrusted content');
function deploymentFixture(rounds) {
  let calls = 0, active = 0;
  const waits = [], notices = [], paths = [];
  return {
    get calls() { return calls; }, waits, notices, paths,
    options: {
      fetchImpl: async (url, options) => {
        paths.push(new URL(url).pathname);
        const round = Math.floor(calls++ / 3);
        active++;
        try { return await rounds[Math.min(round, rounds.length - 1)](url, options); }
        finally { active--; }
      },
      wait: async ms => { assert.equal(active, 0); waits.push(ms); },
      onRetry: attempt => notices.push(attempt),
    },
  };
}

test('default diagnostics remain a single round, including a long-form mismatch', async () => {
  const f = deploymentFixture([stale(), fixture()]);
  assert.deepEqual(await checkLiveOnboarding(f.options.fetchImpl), {
    ok: false, checked: 3, errors: ['Long-form machine text differs from first-visit guide'],
  });
  assert.equal(f.calls, 3);
  assert.deepEqual(f.waits, []);
});
test('post-deployment mode returns immediately when all three documents match', async () => {
  const f = deploymentFixture([fixture()]);
  assert.deepEqual(await checkDeployedOnboarding(f.options), { ok: true, checked: 3, errors: [], attempts: 1 });
  assert.equal(f.calls, 3);
  assert.deepEqual(f.waits, []);
  assert.deepEqual(f.notices, []);
});
test('a transient isolated machine-text mismatch retries the full fixed anonymous read set', async () => {
  const f = deploymentFixture([stale(), fixture()]);
  assert.deepEqual(await checkDeployedOnboarding(f.options), { ok: true, checked: 3, errors: [], attempts: 2 });
  assert.equal(f.calls, 6);
  assert.deepEqual(f.waits, [10_000]);
  assert.deepEqual(f.notices, [1]);
  assert.deepEqual(f.paths, ['/', '/start/', '/llms-full.txt', '/', '/start/', '/llms-full.txt']);
});
test('the last permitted complete round can pass, with no extra reads or waits', async () => {
  const f = deploymentFixture([stale(), stale(), stale(), fixture()]);
  assert.deepEqual(await checkDeployedOnboarding(f.options), { ok: true, checked: 3, errors: [], attempts: 4 });
  assert.equal(f.calls, 12);
  assert.deepEqual(f.waits, [10_000, 10_000, 10_000]);
});
test('persistent machine-text drift fails after four rounds without logging response contents', async () => {
  const f = deploymentFixture([stale()]);
  const result = await checkDeployedOnboarding(f.options);
  assert.deepEqual(result, { ok: false, checked: 3,
    errors: ['Long-form machine text differs from first-visit guide'], attempts: 4 });
  assert.equal(f.calls, 12);
  assert.deepEqual(f.waits, [10_000, 10_000, 10_000]);
  assert.deepEqual(f.notices, [1, 2, 3]);
  assert.ok(!JSON.stringify(result).includes('untrusted content'));
});
for (const [name, bad] of [
  ['missing transform protection', fixture(undefined, 'max-age=0')],
  ['rewritten command', fixture(html => html.replaceAll(packagePin, 'swarmrelay@0.0.0'))],
  ['network error', async () => { throw new Error('untrusted network diagnostic'); }],
  ['wrong content type', async () => new Response('untrusted response', { headers: { 'Content-Type': 'application/json' } })],
  ['unsuccessful HTTP status', async () => new Response('untrusted response', { status: 503 })],
  ['oversized body', async () => new Response('x'.repeat(1024 * 1024 + 1), {
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-transform' },
  })],
]) {
  test(`post-deployment ${name} is terminal, not covered up by a later good response`, async () => {
    const f = deploymentFixture([bad, fixture()]);
    const result = await checkDeployedOnboarding(f.options);
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(f.calls, 3);
    assert.deepEqual(f.waits, []);
    assert.ok(!JSON.stringify(result).includes('untrusted'));
  });
}
test('retry eligibility requires an isolated mismatch; other failures remain terminal', async () => {
  const f = deploymentFixture([fixture(undefined, 'max-age=0', 'previous guide'), fixture()]);
  const result = await checkDeployedOnboarding(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.ok(result.errors.includes('Long-form machine text differs from first-visit guide'));
  assert.equal(f.calls, 3);
  assert.deepEqual(f.waits, []);
});
test('a passing earlier HTML page cannot mask a failed page in the next round', async () => {
  const f = deploymentFixture([stale(), fixture(html => html.replaceAll(packagePin, 'swarmrelay@0.0.0'))]);
  const result = await checkDeployedOnboarding(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.errors.filter(error => error.includes('command differs')).length, 5);
  assert.equal(f.calls, 6);
  assert.deepEqual(f.waits, [10_000]);
});
test('unknown command options fail before any reads and do not reflect arguments', () => {
  const script = fileURLToPath(new URL('./check-live-onboarding.mjs', import.meta.url));
  for (const args of [['--url', 'https://untrusted.example'], ['--after-deploy', '--after-deploy']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Usage: node apps/web/scripts/check-live-onboarding.mjs [--after-deploy]\n');
  }
});
