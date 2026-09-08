import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';

let mf;
let worker;
let scratch;
let outbound = 0;
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
before(async () => {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  scratch = await mkdtemp(join(tmpdir(), 'oaf-control-workerd-'));
  const pagesConfig = JSON.parse(await readFile(new URL('../../../apps/web/wrangler.jsonc', import.meta.url), 'utf8'));
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/control-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', metafile: true, loader: { '.sql': 'text' }, external: ['node:*', 'cloudflare:*'] });
  assert.ok(Object.values(bundle.metafile.outputs).every(output => output.imports.length === 0), 'control handler must bundle without Node or platform imports');
  mf = new Miniflare({ host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
    telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'),
    workers: [{ config: {
      type: 'worker', name: 'control-test', compatibilityDate: pagesConfig.compatibility_date, compatibilityFlags: [],
      workersDev: false, previewUrls: false, domains: [], triggers: [],
      env: { DB: { type: 'd1', id: 'local-wake-control-test', dev: { remote: false } } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { outbound++; throw new Error('no control-plane callback fetch allowed'); } } } }],
  });
  await mf.ready;
  worker = await mf.getWorker('control-test');
});
after(async () => {
  await mf?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
  else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
});
async function inspect(name) {
  const response = await worker.fetch(`https://local.invalid/test-only/${name}`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.equal(outbound, 0);
  return response.json();
}
test('native HMAC authentication works in workerd without nodejs_compat; unauthorized calls do not touch D1 admission', async () => {
  assert.deepEqual(await inspect('auth'), { denied: 401, before: 0, accepted: 200, body: { ref: null, after: null } });
});
test('local D1 atomic admission remains bounded across concurrent adapters and clock rollback', async () => {
  assert.deepEqual(await inspect('admission'), { admitted: 8, rollback: false, rows: 1 });
});
test('actual encrypted manager, local D1 scanner and HTTP control complete/replay verification without outbound fetch', async () => {
  assert.deepEqual(await inspect('lifecycle'), { refKeys: ['agentId', 'jobId', 'kind'], authorized: true, sameAck: true, afterCompletion: { job: null }, secretInPoll: false });
});
test('actual Pages routing and SQL trigger connect signed registration, stored messages and metadata-only wake on local D1', async () => {
  assert.deepEqual(await inspect('pages'), { verification: 'verify', outbox: 1, kind: 'wake', cursor: 1,
    sameRecord: true, contentInHint: false, verifiedRecord: true });
});
