import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';

const workerdPath = workerd.default;

let mf;
let caller;
let scratch;
const outbound = [];
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;

function worker(name, contents, env = {}) {
  return {
    config: {
      type: 'worker', name, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
      workersDev: false, previewUrls: false, domains: [], triggers: [], env,
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents } } },
    },
    dev: {
      unsafeRegisterWorker: false,
      outboundService: {
        type: 'fetcher',
        handler(request) {
          // No network forwarding. Only fixed, empty-response fixtures exist.
          outbound.push({ url: request.url, method: request.method });
          if (request.url === 'https://receiver.example.invalid/redirect') {
            return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
          }
          if (request.url === 'https://192.0.2.1/wake') return new Response(null, { status: 204 });
          throw new Error('unexpected outbound request in offline probe');
        },
      },
    },
  };
}

before(async () => {
  // Pin the runtime independently of Miniflare's transitive binary.
  assert.equal(typeof workerdPath, 'string');
  process.env.MINIFLARE_WORKERD_PATH = workerdPath;
  scratch = await mkdtemp(join(tmpdir(), 'oaf-wake-feasibility-'));
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../probe.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'],
  });
  const forwarder = `export default {
      async fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (!path.startsWith('/test-only/')) return new Response(null, { status: 404 });
        if (!env.PROBE) return Response.json({ kind: 'no_binding' });
        return Response.json(await env.PROBE.inspect(path.slice('/test-only/'.length)));
      }
    }`;
  mf = new Miniflare({
    host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
    telemetry: { enabled: false }, logRequests: false,
    resourceTmpPath: join(scratch, 'runtime'),
    workers: [
      worker('caller', forwarder, { PROBE: { type: 'worker', worker: 'probe' } }),
      worker('probe', bundle.outputFiles[0].text),
      worker('unbound', forwarder),
    ],
  });
  await mf.ready;
  caller = await mf.getWorker('caller');
});

async function inspect(name, handle = caller) {
  const response = await handle.fetch(`https://local.invalid/test-only/${name}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json(); // Fixed tiny probe results, no callback response bodies.
}

after(async () => {
  await mf?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
  else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
});

test('uses the recorded workerd binary, not the legacy production Wrangler runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const date = manifest.devDependencies.workerd.split('.')[1];
  assert.equal(execFileSync(workerdPath, ['--version'], { encoding: 'utf8' }).trim(), `workerd ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`);
});

test('private service binding works; the probe rejects direct HTTP requests', async () => {
  assert.deepEqual(await inspect('not-a-probe'), { kind: 'refused' });
  assert.deepEqual(await inspect('not-a-probe', await mf.getWorker('unbound')), { kind: 'no_binding' });
  assert.equal((await (await mf.getWorker('probe')).fetch('https://local.invalid/test-only/production-options')).status, 404);
  for (const name of ['caller', 'probe', 'unbound']) {
    const handle = await mf.getWorker(name);
    assert.equal((await handle.fetch('https://local.invalid/internal/deliver', { method: 'POST' })).status, 404);
    assert.equal((await handle.fetch('https://local.invalid/inspect')).status, 404);
  }
});

for (const name of ['production-options', 'custom-lookup', 'custom-connection']) {
  test(`negative capability: ${name} is rejected before fetch`, async () => {
    const count = outbound.length;
    assert.deepEqual(await inspect(name), { kind: 'error', code: 'ERR_OPTION_NOT_IMPLEMENTED', socketEvents: 0, identityChecks: 0 });
    assert.equal(outbound.length, count);
  });
}

test('removing the rejected header cap does not restore TLS/socket controls', async () => {
  const count = outbound.length;
  assert.deepEqual(await inspect('tls-options-without-header-cap'), { kind: 'response', status: 204, socketEvents: 0, identityChecks: 0 });
  assert.deepEqual(outbound.slice(count), [{ url: 'https://192.0.2.1/wake', method: 'POST' }]);
  // This is an intercepted fetch, NOT a successful TLS certificate test.
});

test('manual redirect handling does not request the metadata address', async () => {
  const count = outbound.length;
  assert.deepEqual(await inspect('manual-redirect'), { status: 302 });
  assert.deepEqual(outbound.slice(count), [{ url: 'https://receiver.example.invalid/redirect', method: 'POST' }]);
});

test('existing mixed/private DNS rejection executes inside workerd without dialing', async () => {
  const count = outbound.length;
  assert.deepEqual(await inspect('unsafe-dns'), { dialCalls: 0, results: Array(8).fill('unsafe_address') });
  assert.equal(outbound.length, count);
});
