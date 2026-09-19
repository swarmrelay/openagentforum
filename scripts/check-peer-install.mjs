/** Packed client consumer; npm downloads/audit, but all forum/TCP traffic is loopback-only. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runForumDemo } from '../packages/peer-stream/scripts/forum-demo.mjs';

const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'packages', 'peer-stream');
const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const protocol = JSON.parse(readFileSync(join(root, 'packages', 'protocol', 'package.json'), 'utf8'));
const registryProtocol = process.argv[2] === '--registry-protocol';
if (process.argv.length > 3 || (process.argv[2] !== undefined && !registryProtocol)) {
  console.error('Usage: node scripts/check-peer-install.mjs [--registry-protocol]'); process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'oaf-clean-peer-'));
const consumer = join(dir, 'consumer'), packed = join(dir, 'packed');
let phase = 'setup';
try {
  mkdirSync(consumer); mkdirSync(packed);
  const userConfig = join(dir, 'npmrc'), globalConfig = join(dir, 'global-npmrc');
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'oaf-clean-peer-fixture', private: true, type: 'module' }));
  // Installer and child peers receive no registry/operator tokens, NODE_PATH or
  // NODE_OPTIONS. Runtime dependencies must come from this consumer installation.
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  const npmOptions = ['--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', join(dir, 'npm-cache'),
    '--registry', 'https://registry.npmjs.org'];
  phase = 'pack candidate and inspect allowlist';
  await exec('pnpm', ['pack', '--pack-destination', packed], { cwd: source, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const artifact = join(packed, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`);
  assert(existsSync(artifact));
  const { stdout: listing } = await exec('tar', ['-tzf', artifact], { env, timeout: 10_000, maxBuffer: 64 * 1024 });
  const files = listing.trim().split('\n');
  const modules = ['client', 'index', 'framing', 'direct-policy', 'forum-http', 'forum-mailbox', 'private-mailbox', 'rendezvous'];
  const expected = ['package/package.json', 'package/LICENSE', ...pkg.files.filter(name => name !== 'dist').map(name => `package/${name}`),
    ...modules.flatMap(name => [`package/dist/${name}.js`, `package/dist/${name}.d.ts`])];
  assert.deepEqual(files.sort(), expected.sort(), 'Unexpected or missing packed files');
  const { stdout: license } = await exec('tar', ['-xOzf', artifact, 'package/LICENSE'], { env, timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.equal(license, readFileSync(join(root, 'LICENSE'), 'utf8'));
  const artifacts = [artifact];
  if (!registryProtocol) {
    // Pre-publication CI must also work when the protocol version is new.
    // Requiring it on npm here would make the release gate circular.
    phase = 'pack protocol dependency';
    await exec('pnpm', ['pack', '--pack-destination', packed],
      { cwd: join(root, 'packages/protocol'), env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const protocolArtifact = join(packed, `openagentforum-protocol-${protocol.version}.tgz`);
    assert(existsSync(protocolArtifact)); artifacts.push(protocolArtifact);
  }
  phase = 'install candidate and dependencies';
  await exec('npm', ['install', ...npmOptions, '--ignore-scripts=false', '--omit=dev', '--no-audit', '--no-fund', '--save-exact', ...artifacts],
    { cwd: consumer, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  phase = 'verify isolated dependency closure';
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  for (const [name, dependency] of Object.entries(lock.packages)) {
    assert(!dependency.link, 'Workspace link in consumer');
    assert(!/(?:^|\/)(?:better-sqlite3|node-gyp|prebuild-install|swarmrelay)$/.test(name), 'Unexpected runtime dependency');
    assert(!/node_modules\/@openagentforum\/(?:server|sdk|mcp)$/.test(name), 'Client must not install hub/SDK/MCP');
  }
  const installedRoot = join(consumer, 'node_modules', pkg.name);
  const installed = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installed.version, pkg.version);
  assert.equal(installed.dependencies['@openagentforum/protocol'], protocol.version);
  assert.equal(JSON.parse(readFileSync(join(consumer, 'node_modules', '@openagentforum/protocol', 'package.json'), 'utf8')).version, protocol.version);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const spec of Object.values(installed[field] ?? {})) assert(!String(spec).startsWith('workspace:'));
  }
  // The candidate is ESM-only. Resolve under ESM import conditions from the
  // consumer, rather than using CommonJS require.resolve's different conditions.
  const { stdout: resolved } = await exec(process.execPath, ['--input-type=module', '--eval',
    `console.log(import.meta.resolve(${JSON.stringify(pkg.name)}))`],
  { cwd: consumer, env, timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.equal(realpathSync(fileURLToPath(resolved.trim())), realpathSync(join(installedRoot, 'dist/client.js')));
  phase = 'package import, construction and natural exit';
  copyFileSync(join(source, 'test', 'consumer-import.mjs'), join(consumer, 'import.mjs'));
  const { stdout } = await exec(process.execPath, ['import.mjs'], { cwd: consumer, env, timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.deepEqual(JSON.parse(stdout), { ok: true, importAndConstructionOnly: true, privateDeepImportRejected: true });
  phase = 'installed TypeScript declarations';
  copyFileSync(join(source, 'test', 'consumer-types.ts'), join(consumer, 'consumer-types.ts'));
  await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'consumer-types.ts'],
  { cwd: consumer, env, timeout: 30_000, maxBuffer: 256 * 1024 });
  phase = 'two installed peers with encrypted loopback setup';
  const peerScript = join(consumer, 'peer.mjs');
  copyFileSync(join(source, 'scripts', 'forum-peer.mjs'), peerScript);
  const journey = await runForumDemo({ privateSetup: true, peerScript, peerCwd: consumer, peerEnv: env });
  assert.equal(journey.encryptedInvitations, true); assert.equal(journey.publicPosts, 0);
  phase = 'consumer dependency audit';
  await exec('npm', ['audit', ...npmOptions, '--omit=dev', '--audit-level=low'],
    { cwd: consumer, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  console.log(JSON.stringify({ ok: true, package: pkg.name, version: pkg.version, published: false,
    protocol: { version: protocol.version, source: registryProtocol ? 'registry' : 'packed' }, workspaceLinks: false, installedTypes: true,
    importSideEffects: false, consumerAudit: true, journey }));
} catch {
  console.error(`Clean peer client check failed during: ${phase}. No subprocess output was printed.`);
  process.exitCode = 1;
} finally {
  // Only this invocation's freshly allocated fixture directory and dependencies.
  rmSync(dir, { recursive: true, force: true });
}
