/** Clean packed consumer, no workspace links, no public forum traffic or publication. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
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
  phase = 'installed request-allowance exports and contract';
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const [budget, sqliteBudget] = await Promise.all([
    load('@openagentforum/server/public-write-budget'), load('@openagentforum/server/public-write-budget/sqlite'),
  ]);
  const serverRoot = join(consumer, 'node_modules', '@openagentforum', 'server');
  const polls = await load('@openagentforum/server/polls');
  assert.equal(polls.POLL_WORK_LIMITS.records, 1024);
  assert.equal(typeof polls.createD1PollStore({ withSession() { throw new Error('Constructor must not access D1'); } }).getPoll, 'function');
  assert(existsSync(join(serverRoot, 'POLLS.md')), 'Installed poll contract is missing');
  for (const file of ['PUBLIC_WRITE_BUDGET.md', 'dist/public-write-budget.d.ts', 'dist/public-write-budget-sqlite.d.ts']) {
    assert(existsSync(join(serverRoot, file)), 'Installed request-allowance contract is missing');
  }
  phase = 'strict installed request-allowance TypeScript consumer';
  writeFileSync(join(consumer, 'budget-consumer.mts'), `
import { createD1PublicWriteAdmission, type PublicWriteBudgetOptions } from '@openagentforum/server/public-write-budget';
import { createSQLitePublicWriteAdmission } from '@openagentforum/server/public-write-budget/sqlite';
import { DatabaseSync } from 'node:sqlite';
import { createD1PollStore, createSqlPollStore, handlePollRead } from '@openagentforum/server/polls';
import { SwarmClient, type PollCatalog } from '@openagentforum/sdk';
declare const client: SwarmClient;
const catalog: Promise<PollCatalog> = client.listPollCatalog('general', 'open');
declare const options: PublicWriteBudgetOptions;
declare const d1: Parameters<typeof createD1PublicWriteAdmission>[0];
createD1PublicWriteAdmission(d1, options);
createSQLitePublicWriteAdmission(new DatabaseSync(':memory:'), options);
declare const pollDb: Parameters<typeof createD1PollStore>[0];
handlePollRead(new Request('https://relay.test/v1/polls'), createD1PollStore(pollDb));
createSqlPollStore(async () => []);
`);
  const compiler = join(root, 'node_modules/typescript/lib/tsc.js');
  const typeArgs = ['--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022',
    '--types', 'node', '--typeRoots', join(root, 'node_modules/@types')];
  await exec(process.execPath, [compiler, ...typeArgs, 'budget-consumer.mts'],
    { cwd: consumer, env, timeout: 30000, maxBuffer: 256 * 1024 });
  // Separately prove that a real Cloudflare D1 binding fits the published structural surface.
  writeFileSync(join(consumer, 'budget-worker-consumer.mts'), `
import type { D1Database } from ${JSON.stringify(join(root, 'packages/server/node_modules/@cloudflare/workers-types/index.js'))};
import { createD1PublicWriteAdmission, type PublicWriteBudgetOptions } from '@openagentforum/server/public-write-budget';
import { createD1PollStore } from '@openagentforum/server/polls';
declare const db: D1Database;
declare const options: PublicWriteBudgetOptions;
createD1PublicWriteAdmission(db, options);
createD1PollStore(db);
`);
  await exec(process.execPath, [compiler, ...typeArgs, 'budget-worker-consumer.mts'],
    { cwd: consumer, env, timeout: 30000, maxBuffer: 256 * 1024 });
  phase = 'installed request-allowance behavior';
  const config = { origin: 'https://relay.test', generation: 'a'.repeat(64), policy: {
    windowMs: 86_400_000, ordinary: { requests: 1, inputBytes: 262144 }, completion: { requests: 1, inputBytes: 262144 },
    operations: Object.fromEntries(Object.keys(budget.PUBLIC_WRITE_COSTS).map(op => [op, 1])),
  } };
  assert.equal(typeof budget.createD1PublicWriteAdmission({ withSession() { throw new Error('Constructor must not access D1'); } }, config).run, 'function');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(budget.PUBLIC_WRITE_BUDGET_SCHEMA);
    const seed = budget.publicWriteBudgetSeed(config);
    db.prepare('INSERT INTO public_write_request_budget VALUES (1, 1, ?, ?, ?, ?)')
      .run(seed.origin, seed.generation, seed.policy, seed.state);
    const request = () => new Request('https://relay.test/v1/channels', { method: 'POST', body: '{}' });
    let callbacks = 0;
    await sqliteBudget.createSQLitePublicWriteAdmission(db, config).run(request(), 'channel', async () => { callbacks++; });
    await assert.rejects(sqliteBudget.createSQLitePublicWriteAdmission(db, config).run(request(), 'channel', async () => { callbacks++; }),
      error => error instanceof budget.PublicWriteBudgetError && error.code === 'public_write_rate_limited');
    assert.equal(callbacks, 1);
  } finally { db.close(); }
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
  const [{ createStandaloneServer }, { serve }, { SwarmClient }, { verifyEnvelope }] = await Promise.all([
    load('@openagentforum/server/standalone'), load('@hono/node-server'), load('@openagentforum/sdk'), load('@openagentforum/protocol'),
  ]);
  const journey = await runAgentJourney({ cliPath: join(cliRoot, cliPackage.bin.swarmrelay),
    createStandaloneServer, serve, SwarmClient, verifyEnvelope });
  phase = 'installed SDK and MCP unavailable catalog handling';
  const catalogFixture = { polls: [], unavailable: [{ pollId: 'large-poll', channel: 'general', status: 'unavailable', code: 'poll_work_limit' }] };
  const catalogFetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/v1/polls'); assert.equal(init?.method ?? 'GET', 'GET');
    return Response.json(catalogFixture);
  };
  const reader = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false, fetch: catalogFetch });
  assert.deepEqual(await reader.listPollCatalog(), catalogFixture);
  await assert.rejects(reader.listPolls(), /listPollCatalog/);
  const [{ createSwarmMcpServer }, { Client }, { InMemoryTransport }] = await Promise.all([
    load('@openagentforum/mcp'), load('@modelcontextprotocol/sdk/client/index.js'), load('@modelcontextprotocol/sdk/inMemory.js'),
  ]);
  const savedFetch = globalThis.fetch, identityPath = join(dir, 'absent-mcp-identity');
  const catalogMcp = createSwarmMcpServer({ hubUrl: 'https://relay.test', identityPath });
  const peer = new Client({ name: 'packed-catalog-fixture', version: '1.0.0' });
  try {
    globalThis.fetch = catalogFetch;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await catalogMcp.server.connect(serverTransport); await peer.connect(clientTransport);
    const result = await peer.callTool({ name: 'list_polls', arguments: {} });
    assert.notEqual(result.isError, true); assert.match(JSON.stringify(result.content), /UNAVAILABLE/);
    assert.doesNotMatch(JSON.stringify(result.content), /No polls/); assert(!existsSync(identityPath));
  } finally { globalThis.fetch = savedFetch; await peer.close(); await catalogMcp.server.close(); }
  phase = 'clean consumer dependency audit';
  await exec('npm', ['audit', ...npmOptions, '--omit=dev', '--audit-level=low'],
    { cwd: consumer, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  console.log(JSON.stringify({ ok: true, versions, sourceBuildForced: true, pythonUnavailable: true,
    installScriptsEnabled: true, nativeSqliteAddonAbsent: true, aliases: 2, doctorWithoutMcp: true,
    publicWriteBudgetExports: true, publicWriteBudgetTypes: true, unavailableCatalogClients: true, consumerAudit: true, journey }));
} catch {
  // Package managers and subprocesses can include paths or environment diagnostics.
  console.error(`Clean CLI check failed during: ${phase}. No subprocess output was printed.`);
  process.exitCode = 1;
} finally {
  // Only the temporary directory allocated by this invocation, never a supplied path.
  rmSync(dir, { recursive: true, force: true });
}
