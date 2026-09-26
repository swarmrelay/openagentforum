/** Packed candidate only: anonymous npm downloads/audit, then loopback-only room traffic. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { roomFailureFromOutput } from '../packages/room-admission/test/fixtures/room-diagnostics.mjs';

const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 2) { console.error('Usage: node scripts/check-room-install.mjs'); process.exit(2); }
const source = join(root, 'packages/room-client');
const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const protocol = JSON.parse(readFileSync(join(root, 'packages/protocol/package.json'), 'utf8'));
const nodeTypes = JSON.parse(readFileSync(join(root, 'node_modules/@types/node/package.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'oaf-clean-room-'));
const consumer = join(dir, 'consumer'), packed = join(dir, 'packed');
let phase = 'setup';
try {
  mkdirSync(consumer); mkdirSync(packed);
  const userConfig = join(dir, 'npmrc'), globalConfig = join(dir, 'global-npmrc');
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'oaf-clean-room-fixture', private: true, type: 'module' }));
  // No operator credentials, NODE_PATH/NODE_OPTIONS or ambient npm configuration.
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  const npmOptions = ['--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', join(dir, 'npm-cache'),
    '--registry', 'https://registry.npmjs.org'];
  phase = 'pack candidate and protocol';
  for (const directory of [source, join(root, 'packages/protocol')]) {
    await exec('pnpm', ['pack', '--pack-destination', packed], { cwd: directory, env, timeout: 30000, maxBuffer: 1024 * 1024 });
  }
  const artifact = join(packed, `openagentforum-room-client-${pkg.version}.tgz`);
  const protocolArtifact = join(packed, `openagentforum-protocol-${protocol.version}.tgz`);
  phase = 'inspect exact packed contents';
  const manifest = JSON.parse(readFileSync(join(source, 'dist/build-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.commands).sort(), ['cli-driver.mjs', 'cli-io.mjs', 'cli.mjs']);
  const expected = ['package.json', 'README.md', 'dist/LICENSE', 'dist/index.js', 'dist/build-manifest.json',
    ...Object.keys(manifest.commands).map(name => `dist/${name}`),
    ...manifest.declarations.map(name => `dist/types/${name}.d.ts`)];
  const { stdout: listing } = await exec('tar', ['-tzf', artifact], { env, timeout: 10000, maxBuffer: 64 * 1024 });
  assert.deepEqual(listing.trim().split('\n').sort(), expected.map(file => 'package/' + file).sort());
  const { stdout: packedJson } = await exec('tar', ['-xOzf', artifact, 'package/package.json'], { env, timeout: 10000, maxBuffer: 64 * 1024 });
  const packedManifest = JSON.parse(packedJson);
  assert.equal(packedManifest.private, true);
  assert.deepEqual(packedManifest.bin, { 'oaf-room': './dist/cli.mjs' });
  assert.equal(packedManifest.dependencies['@openagentforum/protocol'], protocol.version);
  for (const spec of Object.values(packedManifest.dependencies)) assert(!spec.startsWith('workspace:'));
  phase = 'install candidate and native crypto dependencies';
  // Crypto uses sodium-native. This is deliberately NOT an addon-free claim.
  await exec('npm', ['install', ...npmOptions, '--ignore-scripts=false', '--omit=dev', '--no-audit', '--no-fund', '--save-exact',
    artifact, protocolArtifact, `@types/node@${nodeTypes.version}`],
  { cwd: consumer, env, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  phase = 'verify isolated runtime and declaration closure';
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  for (const [name, dependency] of Object.entries(lock.packages)) {
    assert(!dependency.link, 'Workspace link in clean consumer');
    assert(!/node_modules\/@openagentforum\/(?:room-admission|server|sdk|cli|mcp|mcp-remote)$/.test(name), 'Hub/workspace package installed');
    assert(!/(?:^|\/)(?:better-sqlite3|swarmrelay|workerd|miniflare)$/.test(name), 'Unexpected client runtime');
    if (name && !['node_modules/@openagentforum/room-client', 'node_modules/@openagentforum/protocol'].includes(name)) {
      assert(dependency.resolved?.startsWith('https://registry.npmjs.org/'), 'Non-registry dependency in clean consumer');
    }
  }
  const installedRoot = join(consumer, 'node_modules', pkg.name);
  for (const file of expected.filter(file => file !== 'package.json')) {
    assert(readFileSync(join(installedRoot, file)).equals(readFileSync(join(source, file))), 'Installed artifact differs from source build');
  }
  assert.deepEqual(JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')), packedManifest);
  assert.equal(JSON.parse(readFileSync(join(consumer, 'node_modules/@openagentforum/protocol/package.json'), 'utf8')).version, protocol.version);
  const { stdout: resolved } = await exec(process.execPath, ['--input-type=module', '--eval',
    'console.log(import.meta.resolve("@openagentforum/room-client"))'], { cwd: consumer, env, timeout: 10000, maxBuffer: 65536 });
  assert.equal(realpathSync(fileURLToPath(resolved.trim())), realpathSync(join(installedRoot, 'dist/index.js')));
  const commandPath = join(consumer, 'node_modules/.bin/oaf-room');
  assert.equal(realpathSync(commandPath), realpathSync(join(installedRoot, 'dist/cli.mjs')));
  assert.equal(statSync(commandPath).mode & 0o111, 0o111);
  const { stdout: commandHelp } = await exec(commandPath, ['--help'], { cwd: consumer, env, timeout: 10000, maxBuffer: 65536 });
  assert.match(commandHelp, /unpublished optional private-room command/);
  phase = 'installed import and natural exit';
  copyFileSync(join(source, 'test/consumer-import.mjs'), join(consumer, 'import.mjs'));
  const { stdout } = await exec(process.execPath, ['import.mjs'], { cwd: consumer, env, timeout: 10000, maxBuffer: 65536 });
  assert.deepEqual(JSON.parse(stdout), { ok: true, deepImportRejected: true });
  phase = 'installed declarations without skipLibCheck';
  copyFileSync(join(source, 'test/consumer-types.ts'), join(consumer, 'consumer-types.ts'));
  await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--types', 'node',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'consumer-types.ts'],
  { cwd: consumer, env, timeout: 30000, maxBuffer: 256 * 1024 });
  phase = 'two installed agents through local Pages/D1';
  const fixtureRoot = join(root, 'packages/room-admission/test/fixtures');
  const sourceAgent = readFileSync(join(fixtureRoot, 'invitation-agent.mjs'), 'utf8');
  const sourceImport = "from '../../dist/client-entry.js'";
  assert.equal(sourceAgent.split(sourceImport).length, 2, 'Expected exactly one source entry point');
  const agent = sourceAgent.replace(sourceImport, "from '@openagentforum/room-client'");
  assert(!/\.\.\//.test(agent), 'Source fallback in packed agent');
  const agentScript = join(consumer, 'agent.mjs'); writeFileSync(agentScript, agent);
  copyFileSync(join(fixtureRoot, 'http-config.mjs'), join(consumer, 'http-config.mjs'));
  copyFileSync(join(fixtureRoot, 'room-diagnostics.mjs'), join(consumer, 'room-diagnostics.mjs'));
  // Keep a process-level deadline around the native parent too (including startup
  // and teardown). Only this test parent imports checkout code; its two agents
  // import solely from the installed consumer above. No fallback or silent skip.
  const journeyImport = new URL('../packages/room-admission/test/invitation-native.mjs', import.meta.url).href;
  writeFileSync(join(consumer, 'journey.mjs'), `import { test } from 'node:test';
import { runInvitationJourney } from ${JSON.stringify(journeyImport)};
test('packed room client journey', { timeout: 45000 }, async () => {
  const result = await runInvitationJourney({ agentScript: ${JSON.stringify(agentScript)}, agentCwd: ${JSON.stringify(consumer)}, agentEnv: process.env, restart: true });
  console.log('OAF_ROOM_JOURNEY ' + JSON.stringify(result));
});\n`);
  const { stdout: journeyOutput } = await exec(process.execPath, ['--test', '--test-timeout=60000', 'journey.mjs'],
    { cwd: consumer, env, timeout: 75000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 });
  const records = journeyOutput.split('\n').filter(line => line.startsWith('# OAF_ROOM_JOURNEY '));
  assert.equal(records.length, 1); assert.match(journeyOutput, /# pass 1\r?\n/); assert.match(journeyOutput, /# skipped 0\r?\n/);
  const journey = JSON.parse(records[0].slice('# OAF_ROOM_JOURNEY '.length));
  assert.deepEqual(journey, { independentAgents: 2, explicitConsent: true, encryptedInvitations: true,
    independentProcessRestart: true, freshSession: true, membershipControlsUnchanged: true,
    encryptedPackets: 12, uncertainWriteRecovery: true, localReopen: true,
    oldSessionRefused: true, closed: true, naturalExit: true, publicPosts: 0 });
  phase = 'two installed commands through local Pages/D1';
  // Same native parent, but these agents drive the installed executable through
  // pipes. The test-only network preload cannot enter the packed runtime.
  for (const name of ['cli-agent.mjs', 'cli-network.mjs']) {
    const text = readFileSync(join(source, 'test/fixtures', name), 'utf8');
    assert(!/\.\.\//.test(text), 'Source fallback in command fixture');
    copyFileSync(join(source, 'test/fixtures', name), join(consumer, name));
  }
  writeFileSync(join(consumer, 'command-journey.mjs'), `import { test } from 'node:test';
import { runInvitationJourney } from ${JSON.stringify(journeyImport)};
test('packed room command journey', { timeout: 45000 }, async () => {
  const result = await runInvitationJourney({ agentScript: ${JSON.stringify(join(consumer, 'cli-agent.mjs'))}, agentCwd: ${JSON.stringify(consumer)},
    agentEnv: { ...process.env, OAF_ROOM_FIXTURE_BIN: ${JSON.stringify(commandPath)} }, restart: true });
  console.log('OAF_ROOM_COMMAND_JOURNEY ' + JSON.stringify(result));
});\n`);
  const { stdout: commandOutput } = await exec(process.execPath, ['--test', '--test-timeout=60000', 'command-journey.mjs'],
    { cwd: consumer, env, timeout: 75000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 });
  const commandRecords = commandOutput.split('\n').filter(line => line.startsWith('# OAF_ROOM_COMMAND_JOURNEY '));
  assert.equal(commandRecords.length, 1); assert.match(commandOutput, /# pass 1\r?\n/); assert.match(commandOutput, /# skipped 0\r?\n/);
  const commandJourney = JSON.parse(commandRecords[0].slice('# OAF_ROOM_COMMAND_JOURNEY '.length));
  assert.deepEqual(commandJourney, journey);
  phase = 'consumer dependency audit';
  await exec('npm', ['audit', ...npmOptions, '--omit=dev', '--audit-level=low'],
    { cwd: consumer, env, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  console.log(JSON.stringify({ ok: true, package: pkg.name, version: pkg.version, published: false,
    clientSource: 'packed', protocolSource: 'packed', workspaceLinks: false, installedTypes: true, installedCommand: true,
    consumerAudit: true, journey, commandJourney }));
} catch (error) {
  // Fixed diagnostics only: installer output may contain local paths or server
  // text, so never echo it. Distinguish availability from an artifact assertion.
  const code = /npm (?:ERR!|error) code ([A-Z0-9_]+)\b/.exec(String(error?.stderr ?? ''))?.[1];
  const allowed = ['EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'E429', 'E500', 'E502', 'E503', 'E504',
    'E401', 'E403', 'E404', 'EINTEGRITY', 'ERESOLVE', 'EBADENGINE', 'EBADPLATFORM', 'ENEEDAUTH', 'ENOSPC'];
  const category = error?.killed ? 'subprocess_deadline' : error?.code === 'ERR_ASSERTION' ? 'artifact_or_contract_mismatch'
    : allowed.includes(code) ? code : 'subprocess_or_verification_failure';
  console.error(`Clean room client check failed during: ${phase} (${category}). No raw subprocess output was printed.`);
  const diagnostic = ['two installed agents through local Pages/D1', 'two installed commands through local Pages/D1'].includes(phase)
    ? roomFailureFromOutput(error?.stdout) : null;
  if (diagnostic) console.error(diagnostic);
  process.exitCode = 1;
} finally {
  // Only this invocation's newly allocated fixture, its generated identities and installed dependencies.
  rmSync(dir, { recursive: true, force: true });
}
