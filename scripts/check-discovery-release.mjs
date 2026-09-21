import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const readJson = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Only the advertised MCP package and its own runtime workspace dependency closure. */
export function discoveryReleasePlan(manifest, packages) {
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  const mcp = byName.get('@openagentforum/mcp');
  if (!mcp || manifest?.version !== mcp.version || manifest.transport?.type !== 'stdio' ||
      manifest.transport.command !== 'npx' || JSON.stringify(manifest.transport.args) !== JSON.stringify(['-y', `${mcp.name}@${mcp.version}`])) {
    throw new Error('Discovery metadata does not match the source MCP package; run pnpm docs:generate');
  }
  const plan = new Map();
  function visit(pkg) {
    if (plan.has(pkg.name)) return;
    if (!/^(@openagentforum\/[a-z0-9-]+|swarmrelay)$/.test(pkg.name) || !versionPattern.test(pkg.version) || pkg.private) {
      throw new Error('Discovery references an invalid or private workspace package');
    }
    const entry = { name: pkg.name, version: pkg.version, workspaceDependencies: {} };
    plan.set(pkg.name, entry);
    for (const field of dependencyFields) {
      entry.workspaceDependencies[field] = {};
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (!byName.has(name) && !name.startsWith('@openagentforum/') && !String(spec).startsWith('workspace:')) continue;
        const dependency = byName.get(name);
        if (!dependency || spec !== 'workspace:*') throw new Error('Discovery workspace dependencies must resolve to exact published versions');
        entry.workspaceDependencies[field][name] = dependency.version;
        visit(dependency);
      }
    }
  }
  visit(mcp);
  return [...plan.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function registryVersion(entry, fetchImpl, { allowMissing = false } = {}) {
  const controller = new AbortController();
  let timer;
  let reader;
  let failure = 'registry request failed';
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { failure = 'registry request timed out'; controller.abort(); reject(new Error()); }, 10_000);
  });
  try {
    const response = await Promise.race([fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`, {
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/json' }, signal: controller.signal,
    }), deadline]);
    reader = response.body?.getReader();
    if (response.redirected) throw new Error();
    // Only the explicitly opted-in publication planner accepts a definitive 404.
    // Discovery remains strict: missing packages must never be advertised.
    if (allowMissing && response.status === 404) return null;
    if (response.status !== 200) { failure = `registry returned HTTP ${response.status}`; throw new Error(); }
    failure = 'invalid registry response';
    if (response.redirected || !reader || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 256 * 1024)) throw new Error();
    const chunks = [];
    let bytes = 0;
    for (let reads = 0; ; reads++) {
      if (reads >= 4096) throw new Error();
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new Error();
      chunks.push(new Uint8Array(value));
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    // Only local package identifiers and fixed diagnostics reach deployment logs.
    throw new Error(`${entry.name}@${entry.version}: ${failure}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

/** Anonymous metadata GETs only: no npm tokens, tarball execution, publication or writes. */
export async function checkDiscoveryRelease(plan, fetchImpl = globalThis.fetch) {
  const errors = [];
  for (const entry of plan) {
    try {
      const published = await registryVersion(entry, fetchImpl);
      if (!object(published) || published.name !== entry.name || published.version !== entry.version) throw new Error('mismatched package identity');
      for (const field of dependencyFields) {
        const expected = entry.workspaceDependencies[field];
        const actual = published[field] ?? {};
        if (!object(actual) || Object.entries(expected).some(([name, version]) => actual[name] !== version) ||
            Object.keys(actual).some(name => (name.startsWith('@openagentforum/') || name === 'swarmrelay') && !Object.hasOwn(expected, name))) {
          throw new Error('mismatched workspace dependencies');
        }
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { ok: errors.length === 0, required: plan.map(({ name, version }) => `${name}@${version}`), errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-discovery-release.mjs');
    const packages = ['protocol', 'sdk', 'server', 'mcp', 'cli', 'mesh'].map(dir => readJson(`packages/${dir}/package.json`));
    const plan = discoveryReleasePlan(readJson('apps/web/public/.well-known/mcp.json'), packages);
    const result = await checkDiscoveryRelease(plan);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error('Cannot determine discovery release requirements; check source packages and regenerate docs.');
    process.exitCode = 1;
  }
}
