import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoveryReleasePlan, checkDiscoveryRelease } from './check-discovery-release.mjs';

const packages = [
  { name: '@openagentforum/protocol', version: '2.2.0' },
  { name: '@openagentforum/sdk', version: '2.4.0', dependencies: { '@openagentforum/protocol': 'workspace:*' } },
  { name: '@openagentforum/mcp', version: '1.2.0', dependencies: { '@openagentforum/sdk': 'workspace:*', '@openagentforum/protocol': 'workspace:*', external: '^1.0.0' } },
  { name: '@openagentforum/server', version: '1.9.0' },
  { name: 'swarmrelay', version: '1.7.0' },
];
const manifest = { version: '1.2.0', transport: { type: 'stdio', command: 'npx', args: ['-y', '@openagentforum/mcp@1.2.0'] } };
const plan = () => discoveryReleasePlan(structuredClone(manifest), structuredClone(packages));
function published(entry) {
  return { name: entry.name, version: entry.version, ...entry.workspaceDependencies };
}

test('checks only advertised MCP and its transitive runtime workspace packages, not unrelated source bumps', () => {
  assert.deepEqual(plan().map(entry => entry.name), ['@openagentforum/mcp', '@openagentforum/protocol', '@openagentforum/sdk']);
  const source = structuredClone(packages);
  source[0].devDependencies = { '@openagentforum/server': 'workspace:*' };
  assert.deepEqual(discoveryReleasePlan(manifest, source), plan());
  source[0].optionalDependencies = { '@openagentforum/server': 'workspace:*' };
  assert.equal(discoveryReleasePlan(manifest, source).length, 4);
});

test('rejects stale metadata, nonexact workspace pins, unknown and private packages before any registry fetch', () => {
  for (const patch of [{ version: '1.1.0' }, { transport: { ...manifest.transport, args: ['-y', '@openagentforum/mcp@latest'] } }]) {
    assert.throws(() => discoveryReleasePlan({ ...manifest, ...patch }, packages), /metadata/);
  }
  for (const spec of ['workspace:^', '^2.4.0', '2.4.0']) {
    const source = structuredClone(packages); source[2].dependencies['@openagentforum/sdk'] = spec;
    assert.throws(() => discoveryReleasePlan(manifest, source), /exact/);
  }
  const privateSource = structuredClone(packages); privateSource[1].private = true;
  assert.throws(() => discoveryReleasePlan(manifest, privateSource), /private/);
  const unknown = structuredClone(packages); unknown[2].dependencies['@openagentforum/unknown'] = 'workspace:*';
  assert.throws(() => discoveryReleasePlan(manifest, unknown), /exact/);
});

test('uses only exact anonymous npm metadata GETs and validates published dependency pins', async () => {
  const entries = plan(); const calls = [];
  const result = await checkDiscoveryRelease(entries, async (url, init) => {
    calls.push(url);
    assert.equal(url, `https://registry.npmjs.org/${encodeURIComponent(entries[calls.length - 1].name)}/${entries[calls.length - 1].version}`);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store'); assert.equal(init.body, undefined);
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    return Response.json(published(entries[calls.length - 1]));
  });
  assert.equal(result.ok, true); assert.equal(calls.length, 3);
});

for (const kind of ['missing', 'badIdentity', 'missingDependency', 'rangedDependency', 'unexpectedDependency', 'network', 'badJson', 'oversized', 'redirected', 'emptyChunks']) {
  test(`fails closed on ${kind} without exposing registry content`, async () => {
    const entry = plan()[0]; const detail = 'untrusted-response-do-not-log';
    const result = await checkDiscoveryRelease([entry], async () => {
      if (kind === 'missing') return new Response(detail, { status: 404 });
      if (kind === 'network') throw new Error(detail);
      if (kind === 'badJson') return new Response(detail, { headers: { 'Content-Type': 'application/json' } });
      if (kind === 'emptyChunks') return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); } }), { headers: { 'Content-Type': 'application/json' } });
      const value = structuredClone(published(entry));
      if (kind === 'badIdentity') value.name = detail;
      if (kind === 'missingDependency') delete value.dependencies['@openagentforum/sdk'];
      if (kind === 'rangedDependency') value.dependencies['@openagentforum/sdk'] = '^2.4.0';
      if (kind === 'unexpectedDependency') value.dependencies['@openagentforum/other'] = detail;
      if (kind === 'oversized') value.readme = detail.repeat(20_000);
      const response = Response.json(value);
      if (kind === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
      return response;
    });
    assert.equal(result.ok, false); assert.equal(result.errors.length, 1);
    assert.ok(!JSON.stringify(result).includes(detail));
  });
}

test('deadline covers registry body reads and aborts the fetch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal; let cancelled = false;
  const pending = checkDiscoveryRelease([plan()[0]], async (_, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } });
  });
  // Let the fetch resolve and the stream reader attach before advancing time.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(10_001);
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.errors[0], /timed out/);
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
});

test('both deployment jobs gate publication before their first external write', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const [pages, worker] = workflow.split('  deploy-durable-object:');
  assert.ok(pages.indexOf('pnpm release:check-discovery') > 0);
  assert.ok(pages.indexOf('pnpm release:check-discovery') < pages.indexOf('- name: Apply D1 Migrations'));
  assert.ok(worker.indexOf('pnpm release:check-discovery') > 0);
  assert.ok(worker.indexOf('pnpm release:check-discovery') < worker.indexOf('- name: Deploy worker'));
});
