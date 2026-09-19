/** Clean packed consumer, no workspace links, no public forum traffic or publication. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runAgentJourney } from './agent-journey.mjs';

const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'oaf-clean-cli-'));
const consumer = join(dir, 'consumer'), packed = join(dir, 'packed');
let phase = 'setup';
try {
  mkdirSync(consumer); mkdirSync(packed);
  const userConfig = join(dir, 'npmrc'), globalConfig = join(dir, 'global-npmrc');
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'oaf-clean-consumer-fixture', private: true, type: 'module' }));
  // No registry/operator tokens in installer subprocesses. Keep just runtime/tool lookup.
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  env.npm_config_build_from_source = 'true';
  env.NODE_GYP_FORCE_PYTHON = join(dir, 'unavailable-python');
  const npmOptions = ['--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', join(dir, 'npm-cache'),
    '--registry', 'https://registry.npmjs.org'];
  const artifacts = [], versions = {};
  phase = 'pack source runtime closure';
  for (const name of ['protocol', 'sdk', 'server', 'mcp', 'cli']) {
    const cwd = join(root, 'packages', name), pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    versions[pkg.name] = pkg.version;
    await exec('pnpm', ['pack', '--pack-destination', packed], { cwd, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const artifact = join(packed, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`);
    assert(existsSync(artifact)); artifacts.push(artifact);
  }
  phase = 'install with source builds forced and Python unavailable';
  await exec('npm', ['install', ...npmOptions, '--ignore-scripts=false', '--no-audit', '--no-fund', '--save-exact', ...artifacts],
    { cwd: consumer, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  phase = 'inspect installed dependency closure';
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  for (const [name, pkg] of Object.entries(lock.packages)) {
    assert(!/(?:^|\/)(?:better-sqlite3|node-gyp|prebuild-install)$/.test(name), 'Native SQLite build dependency reintroduced');
    assert(!pkg.link, 'Consumer must not use workspace links');
  }
  const require = createRequire(join(consumer, 'package.json'));
  const cliRoot = join(consumer, 'node_modules', 'swarmrelay');
  const cliPackage = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(versions)) {
    const pkg = JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(pkg.version, version);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, spec] of Object.entries(pkg[field] ?? {})) {
        assert(!String(spec).startsWith('workspace:'));
        if (versions[dependency]) assert.equal(spec, versions[dependency]);
      }
    }
  }
  phase = 'both executable aliases and offline diagnostics';
  assert.deepEqual(Object.keys(cliPackage.bin).sort(), ['openagentforum', 'swarmrelay']);
  for (const name of Object.keys(cliPackage.bin)) {
    const executable = join(consumer, 'node_modules', '.bin', name);
    const { stdout, stderr } = await exec(process.execPath, [executable, 'doctor', '--offline', '--json',
      '--hub', 'https://openagentforum.com', '--identity', join(dir, 'absent-identity')],
    { cwd: consumer, env, timeout: 10_000, maxBuffer: 256 * 1024 });
    assert.equal(stderr, '');
    const report = JSON.parse(stdout);
    assert.equal(report.schemaVersion, 1); assert.equal(report.mode, 'offline'); assert.equal(report.exitCode, 0);
    assert.equal(report.versions.swarmrelay, versions.swarmrelay);
    assert.equal(report.versions['@openagentforum/server'], versions['@openagentforum/server']);
  }
  assert(!existsSync(join(dir, 'absent-identity')));
  phase = 'doctor with an unavailable unrelated command dependency';
  const mcp = join(consumer, 'node_modules', '@openagentforum', 'mcp'), heldMcp = join(dir, 'held-mcp-fixture');
  renameSync(mcp, heldMcp);
  try {
    const { stdout, stderr } = await exec(process.execPath, [join(cliRoot, cliPackage.bin.swarmrelay),
      'doctor', '--offline', '--json', '--hub', 'https://openagentforum.com', '--identity', join(dir, 'absent-identity')],
    { cwd: consumer, env, timeout: 10_000, maxBuffer: 256 * 1024 });
    assert.equal(stderr, '');
    const report = JSON.parse(stdout);
    assert.equal(report.exitCode, 0);
    assert(report.checks.some(check => check.id === 'packages' && check.code === 'version_unavailable'));
  } finally { renameSync(heldMcp, mcp); }
  phase = 'installed client journey against loopback relay';
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const [{ createStandaloneServer }, { serve }, { SwarmClient }, { verifyEnvelope }] = await Promise.all([
    load('@openagentforum/server/standalone'), load('@hono/node-server'), load('@openagentforum/sdk'), load('@openagentforum/protocol'),
  ]);
  const journey = await runAgentJourney({ cliPath: join(cliRoot, cliPackage.bin.swarmrelay),
    createStandaloneServer, serve, SwarmClient, verifyEnvelope });
  phase = 'clean consumer dependency audit';
  await exec('npm', ['audit', ...npmOptions, '--omit=dev', '--audit-level=low'],
    { cwd: consumer, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  console.log(JSON.stringify({ ok: true, versions, sourceBuildForced: true, pythonUnavailable: true,
    installScriptsEnabled: true, nativeSqliteAddonAbsent: true, aliases: 2, doctorWithoutMcp: true, consumerAudit: true, journey }));
} catch {
  // Package managers and subprocesses can include paths or environment diagnostics.
  console.error(`Clean CLI check failed during: ${phase}. No subprocess output was printed.`);
  process.exitCode = 1;
} finally {
  // Only the temporary directory allocated by this invocation, never a supplied path.
  rmSync(dir, { recursive: true, force: true });
}
