import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseDirectories } from './publish-packages.mjs';
import {
  MCP_NAMESPACE, MCP_REGISTRY, PUBLISHER_RELEASE,
  assertCurrentMainForRegistry, assertServerMetadata, installPublisherArchive,
  planMcpRegistryPublication, publisherAsset, sha256Hex, shouldConsiderRegistryVersion,
} from './mcp-registry.mjs';

const root = new URL('../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const pkg = () => read('packages/mcp/package.json');
const server = () => read('packages/mcp/server.json');
const current = 'a'.repeat(40);

test('server.json stays aligned with the MCP package and the registry schema limits', () => {
  const manifest = pkg();
  const metadata = server();
  assert.equal(manifest.mcpName, MCP_NAMESPACE);
  assert.equal(metadata.version, manifest.version);
  assert.equal(metadata.packages[0].version, manifest.version);
  assert.doesNotThrow(() => assertServerMetadata(manifest, metadata));
  for (const extra of [
    { version: '0.0.1' },
    { name: 'io.github.example/other' },
    { description: 'x'.repeat(101) },
    { description: 'task bounties for agents' },
    { remotes: [{ type: 'streamable-http', url: 'https://openagentforum.com/mcp' }] },
  ]) {
    assert.throws(() => assertServerMetadata(manifest, { ...metadata, ...extra }));
  }
  assert.throws(() => assertServerMetadata({ ...manifest, version: '9.9.9' }, metadata), /version/);
  assert.throws(() => assertServerMetadata({ ...manifest, mcpName: 'io.github.example/other' }, metadata), /mcpName/);
  const requiredHub = structuredClone(metadata);
  requiredHub.packages[0].environmentVariables[0].isRequired = true;
  assert.throws(() => assertServerMetadata(manifest, requiredHub), /SWARM_HUB_URL/);
});

test('published package descriptions and readmes do not advertise task bounties', () => {
  for (const dir of releaseDirectories) {
    const manifest = JSON.parse(readFileSync(new URL(`packages/${dir}/package.json`, root), 'utf8'));
    const readme = readFileSync(new URL(`packages/${dir}/README.md`, root), 'utf8');
    assert.doesNotMatch(manifest.description, /bount/i, manifest.name);
    assert.doesNotMatch(readme, /task bount/i, manifest.name);
  }
});

test('registry publication accepts only the current main commit, including a tag of that commit', () => {
  assert.doesNotThrow(() => assertCurrentMainForRegistry({
    ref: 'refs/heads/main', sha: current, checkout: current, main: current,
  }));
  assert.doesNotThrow(() => assertCurrentMainForRegistry({
    ref: 'refs/tags/v1.2.3', sha: current, checkout: current, main: current,
  }));
  for (const patch of [
    { ref: 'refs/heads/topic' }, { ref: 'refs/tags/release' }, { sha: 'b'.repeat(40) },
    { checkout: 'b'.repeat(40) }, { main: 'b'.repeat(40) }, { main: undefined },
  ]) {
    assert.throws(() => assertCurrentMainForRegistry({ ref: 'refs/heads/main', sha: current, checkout: current, main: current, ...patch }));
  }
});

test('unchanged MCP versions skip registry publication before any network call', () => {
  assert.equal(shouldConsiderRegistryVersion({ current: '1.2.3', previous: '1.2.3', onlyIfChanged: true }), false);
  assert.equal(shouldConsiderRegistryVersion({ current: '1.2.3', previous: '1.2.2', onlyIfChanged: true }), true);
  assert.equal(shouldConsiderRegistryVersion({ current: '1.2.3', previous: '1.2.3', onlyIfChanged: false }), true);
});

test('plans a registry publish only after npm has the matching mcpName and the version is absent', async () => {
  const manifest = pkg();
  const metadata = server();
  const calls = [];
  const plan = await planMcpRegistryPublication({ pkg: manifest, server: metadata, fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    if (calls.length === 1) {
      assert.equal(url, `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${manifest.version}`);
      return Response.json({ name: manifest.name, version: manifest.version, mcpName: manifest.mcpName });
    }
    assert.equal(url, `${MCP_REGISTRY}/v0/servers/${encodeURIComponent(MCP_NAMESPACE)}/versions/${manifest.version}`);
    return new Response(JSON.stringify({ title: 'Not Found', status: 404 }), { status: 404, headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(plan, { action: 'publish', version: manifest.version, url: calls[1] });
  assert.equal(calls.length, 2);
});

test('skips when the registry already has the version and does not publish when npm lacks it', async () => {
  const manifest = pkg();
  const metadata = server();
  let registryCalls = 0;
  const present = await planMcpRegistryPublication({ pkg: manifest, server: metadata, fetchImpl: async (url) => {
    if (url.startsWith(MCP_REGISTRY)) {
      registryCalls++;
      return Response.json({ server: { name: metadata.name, version: metadata.version } });
    }
    return Response.json({ name: manifest.name, version: manifest.version, mcpName: manifest.mcpName });
  } });
  assert.equal(present.action, 'skip');
  assert.equal(registryCalls, 1);
  const missing = await planMcpRegistryPublication({ pkg: manifest, server: metadata, fetchImpl: async () => new Response('no', { status: 404 }) });
  assert.equal(missing.action, 'blocked');
});

test('registry plan failures stay closed and do not echo response bodies', async () => {
  const manifest = pkg();
  const metadata = server();
  const detail = 'untrusted-registry-body';
  await assert.rejects(planMcpRegistryPublication({ pkg: manifest, server: metadata, fetchImpl: async (url) => {
    if (url.startsWith('https://registry.npmjs.org/')) return Response.json({ name: manifest.name, version: manifest.version, mcpName: manifest.mcpName });
    return new Response(detail, { status: 503, headers: { 'content-type': 'text/plain' } });
  } }), error => !String(error).includes(detail) && /HTTP 503/.test(error.message));
  await assert.rejects(planMcpRegistryPublication({ pkg: manifest, server: metadata, fetchImpl: async () => Response.json({
    name: manifest.name, version: manifest.version, mcpName: 'io.github.example/other',
  }) }), /does not match/);
});

test('publisher install accepts only the pinned checksum and a regular binary member', () => {
  const asset = publisherAsset('linux', 'x64');
  assert.equal(asset.url, `https://github.com/modelcontextprotocol/registry/releases/download/${PUBLISHER_RELEASE}/mcp-publisher_linux_amd64.tar.gz`);
  assert.doesNotMatch(asset.url, /latest/);
  assert.throws(() => publisherAsset('darwin', 'arm64'));
  const work = mkdtempSync(join(tmpdir(), 'mcp-reg-'));
  try {
    const source = join(work, 'src');
    const dest = join(work, 'dest');
    execFileSync('mkdir', ['-p', source, dest]);
    writeFileSync(join(source, 'mcp-publisher'), '#!/bin/sh\necho ok\n');
    const archive = join(work, 'mcp-publisher.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', source, 'mcp-publisher']);
    const bytes = readFileSync(archive);
    const installed = installPublisherArchive({ bytes, expectedSha256: sha256Hex(bytes), directory: dest });
    assert.equal(readFileSync(installed, 'utf8'), '#!/bin/sh\necho ok\n');
    assert.throws(() => installPublisherArchive({ bytes, expectedSha256: '0'.repeat(64), directory: dest }), /checksum/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('registry publication is isolated from Pages deploy and runs only after npm publication', () => {
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const registry = readFileSync(new URL('../.github/workflows/mcp-registry.yml', import.meta.url), 'utf8');
  const job = release.split('\n  publish-mcp-registry:')[1];
  assert.match(job, /^\n    name: Publish MCP registry metadata\n    needs: publish\n/);
  assert.match(job, /continue-on-error: true/);
  assert.match(job, /github\.ref == 'refs\/heads\/main'/);
  assert.match(job, /MCP_REGISTRY_REQUIRE_NPM: '1'/);
  assert.match(job, /node scripts\/mcp-registry\.mjs/);
  assert.doesNotMatch(job, /\|\| true/);
  assert.doesNotMatch(release.split('\n  publish-mcp-registry:')[0], /publish-mcp-registry\.mjs/);
  assert.doesNotMatch(deploy, /mcp-publisher|publish-mcp-registry/);
  assert.match(registry, /branches:\n\s+- main/);
  assert.match(registry, /MCP_REGISTRY_ONLY_IF_CHANGED: \$\{\{ github\.event_name == 'push' && '1' \|\| '0' \}\}/);
  assert.doesNotMatch(registry, /pull_request/);
  assert.match(registry, /id-token: write/);
  assert.match(registry, /cancel-in-progress: false/);
});
