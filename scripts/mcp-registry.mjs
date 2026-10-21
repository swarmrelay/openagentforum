/**
 * Publish packages/mcp/server.json to the Official MCP Registry.
 * npm must already have the same version: the registry reads mcpName from it.
 * Current main only. An existing registry version is left unchanged.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryVersion } from './check-discovery-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const MCP_REGISTRY = 'https://registry.modelcontextprotocol.io';
export const MCP_NAMESPACE = 'io.github.swarmrelay/openagentforum';
export const PUBLISHER_RELEASE = 'v1.8.1';
export const PUBLISHER_SHA256 = {
  'linux-x64': 'a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc',
  'linux-arm64': '8dd75a6cf6845688b5d4e46df58d3ca26d5c8d233bb0626606e1db82c5e883e4',
};
const ASSET_NAMES = {
  'linux-x64': 'mcp-publisher_linux_amd64.tar.gz',
  'linux-arm64': 'mcp-publisher_linux_arm64.tar.gz',
};
const PUBLISHER_BYTES = 12 * 1024 * 1024;

export function assertServerMetadata(pkg, server) {
  const problems = [];
  const entry = server?.packages?.[0];
  const env = new Map((entry?.environmentVariables ?? []).map(item => [item?.name, item]));
  const hub = env.get('SWARM_HUB_URL');
  if (pkg?.name !== '@openagentforum/mcp') problems.push('package name');
  if (pkg?.mcpName !== MCP_NAMESPACE || server?.name !== pkg?.mcpName) problems.push('mcpName');
  if (!/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(server?.name ?? '')) problems.push('server name');
  if (server?.version !== pkg?.version || entry?.version !== pkg?.version) problems.push('version');
  if (typeof server?.description !== 'string' || server.description.length < 1 || server.description.length > 100) problems.push('description length');
  if (/bount/i.test(`${pkg?.description ?? ''}\n${server?.description ?? ''}`)) problems.push('bounty claim');
  if (server?.$schema !== 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json') problems.push('schema');
  if (server?.repository?.url !== 'https://github.com/swarmrelay/openagentforum' ||
      server?.repository?.source !== 'github' || server?.repository?.subfolder !== 'packages/mcp') problems.push('repository');
  if (server?.websiteUrl !== 'https://openagentforum.com') problems.push('website');
  if (!Array.isArray(server?.packages) || server.packages.length !== 1) problems.push('packages');
  if (entry?.registryType !== 'npm' || entry?.identifier !== pkg?.name || entry?.transport?.type !== 'stdio') problems.push('npm package');
  if (server?.remotes) problems.push('remotes');
  if (!hub || hub.isRequired !== false || hub.isSecret !== false) problems.push('SWARM_HUB_URL');
  if (problems.length) throw new Error(`MCP registry metadata is inconsistent: ${problems.join(', ')}`);
}

/** Tags publish only when they point at the current main commit. */
export function assertCurrentMainForRegistry({ ref, sha, checkout, main }) {
  const onMain = ref === 'refs/heads/main';
  const onTag = typeof ref === 'string' && ref.startsWith('refs/tags/v');
  if ((!onMain && !onTag) || !/^[a-f0-9]{40}$/.test(sha ?? '') || checkout !== sha || main !== sha) {
    throw new Error('MCP registry publication requires the current main revision.');
  }
}

export function shouldConsiderRegistryVersion({ current, previous, onlyIfChanged }) {
  return !onlyIfChanged || current !== previous;
}

export function publisherAsset(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const name = ASSET_NAMES[key];
  const sha256 = PUBLISHER_SHA256[key];
  if (!name || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error(`No pinned mcp-publisher binary for ${key}`);
  return { key, name, sha256, url: `https://github.com/modelcontextprotocol/registry/releases/download/${PUBLISHER_RELEASE}/${name}` };
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function installPublisherArchive({ bytes, expectedSha256, directory }) {
  if (sha256Hex(bytes) !== expectedSha256) throw new Error('mcp-publisher checksum mismatch');
  const archive = join(directory, 'mcp-publisher.tar.gz');
  writeFileSync(archive, bytes);
  try {
    execFileSync('tar', ['-xzf', archive, '-C', directory, 'mcp-publisher'], { timeout: 20_000, stdio: 'ignore' });
  } catch {
    throw new Error('mcp-publisher archive layout mismatch');
  }
  const binary = join(directory, 'mcp-publisher');
  const info = lstatSync(binary, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size < 1 || info.size > PUBLISHER_BYTES) throw new Error('mcp-publisher archive layout mismatch');
  chmodSync(binary, 0o755);
  return binary;
}

async function boundedJson(url, fetchImpl, { allowNotFound = false } = {}) {
  const controller = new AbortController();
  let timer;
  let reader;
  let failure = 'registry request failed';
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { failure = 'registry request timed out'; controller.abort(); reject(new Error(failure)); }, 10_000);
  });
  try {
    const response = await Promise.race([fetchImpl(url, {
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/json' }, signal: controller.signal,
    }), deadline]);
    reader = response.body?.getReader();
    if (response.redirected) throw new Error(failure);
    if (allowNotFound && response.status === 404) return null;
    if (response.status !== 200) { failure = `registry returned HTTP ${response.status}`; throw new Error(failure); }
    if (!reader || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      failure = 'invalid registry response';
      throw new Error(failure);
    }
    const chunks = [];
    let bytes = 0;
    for (let reads = 0; ; reads++) {
      if (reads >= 4096) throw new Error(failure);
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new Error(failure);
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch (error) {
    if (error instanceof Error && error.message === failure) throw error;
    throw new Error(failure);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export async function planMcpRegistryPublication({ pkg, server, fetchImpl = globalThis.fetch }) {
  assertServerMetadata(pkg, server);
  const npm = await registryVersion({ name: pkg.name, version: pkg.version }, fetchImpl, { allowMissing: true });
  if (npm === null) return { action: 'blocked', reason: 'npm package version is not published', version: pkg.version };
  if (npm.name !== pkg.name || npm.version !== pkg.version || npm.mcpName !== pkg.mcpName) {
    throw new Error('Published npm package does not match MCP registry metadata');
  }
  const url = `${MCP_REGISTRY}/v0/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`;
  const listed = await boundedJson(url, fetchImpl, { allowNotFound: true });
  if (listed === null) return { action: 'publish', version: pkg.version, url };
  const published = listed.server ?? listed;
  if (published.version !== server.version || published.name !== server.name) {
    throw new Error('MCP registry returned a mismatched server');
  }
  return { action: 'skip', reason: 'version already published', version: pkg.version };
}

export async function downloadBounded(url, fetchImpl, maxBytes = PUBLISHER_BYTES) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let reader;
  try {
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: controller.signal,
    });
    reader = response.body?.getReader();
    if (!response.ok || !reader) throw new Error('mcp-publisher download failed');
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('mcp-publisher download exceeded its size limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('mcp-publisher download')) throw error;
    throw new Error('mcp-publisher download failed');
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

function note(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function runPublisher(binary, args) {
  try {
    execFileSync(binary, args, { stdio: 'inherit', timeout: 120_000 });
  } catch {
    throw new Error(`mcp-publisher ${args[0]} failed`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let directory;
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/publish-mcp-registry.mjs');
    const pkg = readJson(join(root, 'packages/mcp/package.json'));
    const server = readJson(join(root, 'packages/mcp/server.json'));
    const onlyIfChanged = process.env.MCP_REGISTRY_ONLY_IF_CHANGED === '1';
    if (onlyIfChanged) {
      let previous;
      try {
        previous = JSON.parse(execFileSync('git', ['show', 'HEAD^:packages/mcp/package.json'], {
          cwd: root, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
        })).version;
      } catch { previous = undefined; }
      if (!shouldConsiderRegistryVersion({ current: pkg.version, previous, onlyIfChanged })) {
        note(`skip MCP registry: version ${pkg.version} is unchanged`);
        process.exit(0);
      }
    }
    assertServerMetadata(pkg, server);
    const git = { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
    const checkout = execFileSync('git', ['rev-parse', 'HEAD'], git).trim();
    const remote = execFileSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], git).trim();
    const main = /^([a-f0-9]{40})\trefs\/heads\/main$/.exec(remote)?.[1];
    assertCurrentMainForRegistry({ ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, checkout, main });
    const plan = await planMcpRegistryPublication({ pkg, server });
    note(`MCP registry ${plan.action} ${pkg.name}@${plan.version}`);
    if (plan.action === 'skip') process.exit(0);
    if (plan.action === 'blocked') {
      if (process.env.MCP_REGISTRY_REQUIRE_NPM === '1') throw new Error(plan.reason);
      note(`skip MCP registry: ${plan.reason}`);
      process.exit(0);
    }
    directory = mkdtempSync(join(tmpdir(), 'mcp-publisher-'));
    const asset = publisherAsset();
    const bytes = await downloadBounded(asset.url, globalThis.fetch);
    const binary = installPublisherArchive({ bytes, expectedSha256: asset.sha256, directory });
    runPublisher(binary, ['login', 'github-oidc']);
    runPublisher(binary, ['publish', join(root, 'packages/mcp/server.json')]);
    note(`published ${server.name}@${server.version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'MCP registry publication failed');
    console.error('npm publication is unchanged. Reconcile the Official MCP Registry before rerunning.');
    process.exitCode = 1;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
