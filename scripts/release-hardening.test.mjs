import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicationPlan, releaseDirectories, runRelease } from './publish-packages.mjs';
import { assertDeployRevision } from './check-deploy-revision.mjs';

const packages = () => releaseDirectories.map(dir => ({ dir, name: dir === 'cli' ? 'swarmrelay' : `@openagentforum/${dir}`, version: '1.2.3' }));
const published = pkg => Response.json({ name: pkg.name, version: pkg.version });

test('plans every exact anonymous registry read before publishing only definitive missing versions', async () => {
  const source = packages(), events = [];
  const plan = await runRelease({ packages: source, log() {},
    fetchImpl: async (url, init) => {
      const pkg = source[events.length];
      assert.equal(url, `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/1.2.3`);
      assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      assert.deepEqual(init.headers, { Accept: 'application/json' });
      assert.equal(init.body, undefined);
      events.push('read');
      return pkg.dir === 'mcp' ? new Response('not found', { status: 404 }) : published(pkg);
    },
    publish(entry) { assert.equal(events.length, 7); assert.equal(entry.dir, 'mcp'); events.push('publish'); },
  });
  assert.equal(plan.filter(p => p.action === 'publish').length, 1);
  assert.deepEqual(events, [...Array(7).fill('read'), 'publish']);
});

for (const failure of [401, 403, 429, 500, 503, 'network', 'malformed', 'identity', 'redirected-404', 'oversized']) {
  test(`an earlier missing version cannot publish if any later preflight has ${failure}`, async () => {
    let reads = 0, writes = 0;
    await assert.rejects(runRelease({ packages: packages(), log() {}, publish() { writes++; },
      fetchImpl: async () => {
        if (reads++ === 0) return new Response(null, { status: 404 });
        if (typeof failure === 'number') return new Response('untrusted', { status: failure });
        if (failure === 'network') throw new Error('untrusted');
        if (failure === 'malformed') return new Response('untrusted', { headers: { 'content-type': 'application/json' } });
        if (failure === 'identity') return Response.json({ name: 'untrusted', version: '1.2.3' });
        if (failure === 'oversized') return Response.json({ padding: 'x'.repeat(300_000) });
        const response = new Response(null, { status: 404 });
        Object.defineProperty(response, 'redirected', { value: true });
        return response;
      },
    }), error => !error.message.includes('untrusted'));
    assert.equal(writes, 0);
  });
}

test('validates the whole fixed release scope before sending requests', async () => {
  for (const mutation of [p => p.pop(), p => p.reverse(), p => { p[6].dir = '../other'; },
    p => { p[6].name = '@another/package'; }, p => { p[6].private = true; }, p => { p[6].version = 'latest'; }]) {
    const source = packages(); mutation(source);
    let calls = 0;
    await assert.rejects(publicationPlan(source, async () => { calls++; }));
    assert.equal(calls, 0);
  }
});

test('publication errors stop the plan without retrying or attempting later packages', async () => {
  const attempts = [];
  await assert.rejects(runRelease({ packages: packages(), log() {},
    fetchImpl: async () => new Response(null, { status: 404 }),
    publish(entry) { attempts.push(entry.dir); throw new Error('uncertain publish'); },
  }));
  assert.deepEqual(attempts, ['protocol']);
});

test('stalled preflight is bounded and never starts publication', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, writes = 0;
  const result = runRelease({ packages: packages(), log() {}, publish() { writes++; },
    fetchImpl: async (_, init) => {
      signal = init.signal;
      return new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } });
    },
  });
  const rejected = assert.rejects(result, /timed out/);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  t.mock.timers.tick(10_001);
  await rejected;
  assert.equal(writes, 0); assert.equal(signal.aborted, true);
});

test('production guard rejects non-main, stale, mismatched and unavailable revisions', () => {
  const current = { ref: 'refs/heads/main', sha: 'a'.repeat(40), checkout: 'a'.repeat(40), main: 'a'.repeat(40) };
  assert.doesNotThrow(() => assertDeployRevision(current));
  for (const patch of [{ ref: 'refs/heads/topic' }, { ref: 'refs/tags/v1.2.3' }, { sha: '' },
    { checkout: 'b'.repeat(40) }, { main: 'b'.repeat(40) }, { main: undefined }]) {
    assert.throws(() => assertDeployRevision({ ...current, ...patch }));
  }
});

test('both independent uploads require shared validation and check freshness before writes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const validation = workflow.split('  validate:')[1].split('\n  deploy:')[0];
  for (const gate of ['pnpm security:audit', 'pnpm build', 'pnpm test', 'test:browser', 'pnpm release:check-discovery']) assert(validation.includes(gate));
  assert(validation.includes("if: github.ref == 'refs/heads/main'"));
  assert(!validation.includes('secrets.'));
  for (const [job, write] of [['deploy', '- name: Apply D1 Migrations'], ['deploy-durable-object', '- name: Deploy worker']]) {
    const body = workflow.split(`\n  ${job}:`)[1].split(/\n  [a-z][a-z-]*:/)[0];
    assert.match(body, /^\n    needs: validate\n/);
    assert(!body.includes('always()') && !body.includes('continue-on-error'));
    const guard = body.indexOf('node scripts/check-deploy-revision.mjs');
    assert(guard > 0 && guard < body.indexOf(write));
  }
});

test('deploy/release runs serialize separately without cancelling active side effects', () => {
  for (const [file, group] of [['deploy.yml', 'oaf-production-deploy'], ['release.yml', 'oaf-npm-publication']]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert(workflow.includes(`\nconcurrency:\n  group: ${group}\n  cancel-in-progress: false\n`));
  }
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert(release.includes('node scripts/publish-packages.mjs --publish'));
  assert(!release.includes('npm view') && !release.includes('|| true'));
});
