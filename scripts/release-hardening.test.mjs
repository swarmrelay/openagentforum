import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicationPlan, releaseDirectories, runRelease } from './publish-packages.mjs';
import { assertDeployRevision } from './check-deploy-revision.mjs';
import { REGISTRY_RETRY, notYetServed, withRegistryRetry } from './lib/registry-retry.mjs';

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
    publish(entry) { assert.equal(events.length, 8); assert.equal(entry.dir, 'mcp'); events.push('publish'); },
  });
  assert.equal(plan.filter(p => p.action === 'publish').length, 1);
  assert.deepEqual(events, [...Array(8).fill('read'), 'publish']);
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
  for (const mutation of [p => p.pop(), p => p.reverse(), p => { p[7].dir = '../other'; },
    p => { p[7].name = '@another/package'; }, p => { p[7].private = true; }, p => { p[7].version = 'latest'; }]) {
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

test('existing package versions cannot hide an unpublished dependency fix or a moved workspace pin', async () => {
  const source = packages();
  const cli = source.find(pkg => pkg.dir === 'cli');
  cli.dependencies = { '@hono/node-server': '^2.1.5', '@openagentforum/server': 'workspace:*' };
  for (const actual of [
    { '@hono/node-server': '^1.13.8', '@openagentforum/server': '1.2.3' },
    { '@hono/node-server': '^2.1.5', '@openagentforum/server': '1.2.2' },
    { '@hono/node-server': '^2.1.5' },
    { '@hono/node-server': '^2.1.5', '@openagentforum/server': '1.2.3', unexpected: '1.0.0' },
  ]) {
    let writes = 0;
    await assert.rejects(runRelease({ packages: source, log() {}, publish() { writes++; },
      fetchImpl: async url => {
        const pkg = source.find(candidate => url.includes(encodeURIComponent(candidate.name) + '/'));
        if (pkg.dir === 'mcp') return new Response(null, { status: 404 });
        return Response.json({ name: pkg.name, version: pkg.version, ...(pkg === cli ? { dependencies: actual } : {}) });
      },
    }), /published runtime dependencies differ/);
    assert.equal(writes, 0, 'an earlier missing package is not published after any later mismatch');
  }
  const plan = await publicationPlan(source, async url => {
    const pkg = source.find(candidate => url.includes(encodeURIComponent(candidate.name) + '/'));
    return Response.json({ name: pkg.name, version: pkg.version, ...(pkg === cli ? {
      dependencies: { '@openagentforum/server': '1.2.3', '@hono/node-server': '^2.1.5' },
    } : {}) });
  });
  assert(plan.every(entry => entry.action === 'skip'), 'dependency key order does not affect equality');
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

const npmFailure = code => Object.assign(new Error('Command failed'), { stderr: `npm error code ${code}\nnpm error PRIVATE_INSTALLER_TEXT` });

test('registry checks retry only a not-yet-served version, a bounded number of times', async () => {
  assert.equal(notYetServed(npmFailure('ETARGET')), true);
  assert.equal(notYetServed(npmFailure('E404')), true);
  assert.equal(notYetServed(npmFailure('E403')), false);
  assert.equal(notYetServed(npmFailure('EINTEGRITY')), false);
  assert.equal(notYetServed(new Error('no stderr')), false);

  let calls = 0, resets = 0;
  const slept = [], logs = [];
  const result = await withRegistryRetry(async () => { if (++calls < 3) throw npmFailure('ETARGET'); return 'installed'; },
    { reset: () => resets++, sleep: async ms => { slept.push(ms); }, log: line => logs.push(line) });
  assert.equal(result, 'installed'); assert.equal(calls, 3); assert.equal(resets, 2);
  assert.deepEqual(slept, [REGISTRY_RETRY.delayMs, REGISTRY_RETRY.delayMs]);
  assert.ok(logs.every(line => !line.includes('PRIVATE_INSTALLER_TEXT')), 'retry notices never echo installer output');

  calls = 0;
  await assert.rejects(withRegistryRetry(async () => { calls++; throw npmFailure('ETARGET'); }, { sleep: async () => {} }));
  assert.equal(calls, REGISTRY_RETRY.attempts, 'gives up after the fixed attempt count');
  assert.ok(REGISTRY_RETRY.attempts * REGISTRY_RETRY.delayMs <= 180_000, 'total wait stays bounded');

  calls = 0;
  await assert.rejects(withRegistryRetry(async () => { calls++; throw npmFailure('E403'); }, { sleep: async () => {} }));
  assert.equal(calls, 1, 'authorization and integrity failures are never retried');
});

