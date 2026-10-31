import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import { options, decorate, lane } from './helpers.mjs';

let bundle;
export async function native(t, policy = {}) {
  const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  const scratch = await mkdtemp(join(tmpdir(), 'oaf-task-d1-'));
  bundle ??= await build({ entryPoints: [fileURLToPath(new URL('./fixtures/d1-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', metafile: true });
  assert(Object.values(bundle.metafile.outputs).every(o => o.imports.length === 0));
  assert(Object.keys(bundle.metafile.inputs).every(path => !/sqlite|noise|libsodium/.test(path)));
  const pages = JSON.parse(await readFile(new URL('../../../apps/web/wrangler.jsonc', import.meta.url), 'utf8'));
  let outbound = 0;
  const config = { host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
    telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'), resourcePersistencePath: join(scratch, 'state'),
    workers: [{ config: { name: 'task-leases-test', compatibilityDate: pages.compatibility_date, compatibilityFlags: [],
      workersDev: false, previewUrls: false, domains: [], triggers: [],
      env: { DB: { type: 'd1', id: 'local-task-leases-test', dev: { remote: false } } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { outbound++; throw new Error('No outbound requests'); } } } }],
  };
  let mf, worker;
  const start = async () => { mf = new Miniflare(config); await mf.ready; worker = await mf.getWorker('task-leases-test'); };
  t.after(async () => { await mf?.dispose(); await rm(scratch, { recursive: true, force: true });
    if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
    assert.equal(outbound, 0); });
  await start();
  const opts = options(policy), actors = await Promise.all(Array.from({ length: 3 }, () => generateAgentKeyPair()));
  const call = async (path, body = {}) => {
    const text = JSON.stringify({ options: opts, ...body }); assert(Buffer.byteLength(text) <= 2 * 1024 * 1024);
    const response = await worker.fetch(`https://fixture.invalid/test-only/${path}`, { method: 'POST', body: text, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200); assert.equal(outbound, 0); return response.json();
  };
  await call('init', { keys: actors.map(a => a.signingPublicKey), now: Date.now() });
  const value = result => { if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code }); return result.value; };
  const f = { options: opts, actors, call,
    fixtureUrl: async () => String(await mf.ready),
    apply: async (wire, extra = {}) => value(await call('apply', { wire, lane: lane(wire), ...extra })),
    recover: async wire => value(await call('recover', { wire })), read: async id => value(await call('read', { id })),
    inspect: () => call('inspect'), sql: async (sql, values = []) => value(await call('sql', { sql, values })),
    age: (id, ms = 60001) => call('age', { id, ms }),
    restart: async () => { await mf.dispose(); await start(); },
  };
  return decorate(f);
}
