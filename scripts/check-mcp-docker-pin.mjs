import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PACKAGE = '@openagentforum/mcp';
const REGISTRY = 'https://registry.npmjs.org/';
const MAX_METADATA = 64 * 1024;

// Match an explicit release pin only: tags, ranges, duplicate ARG declarations,
// and an implicit manifest-derived default do not provide the build guarantee.
export function dockerDefault(source) {
  const lines = source.split(/\r?\n/).filter(line => /^\s*ARG\s+MCP_VERSION(?:\s|=|$)/.test(line));
  const match = lines.length === 1 && /^\s*ARG\s+MCP_VERSION=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\s*$/.exec(lines[0]);
  if (!match) throw new Error('Dockerfile needs one exact MCP_VERSION release pin');
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export async function checkPublished(version, request = fetch) {
  // The version came from dockerDefault, but validate it again for direct callers.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Invalid exact release version');
  }
  const url = `${REGISTRY}${encodeURIComponent(PACKAGE)}/${version}`;
  const response = await request(url, {
    redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { accept: 'application/json' },
  });
  if (response.status !== 200 || !response.body) {
    throw new Error(`npm registry could not confirm MCP ${version} (HTTP ${response.status})`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA) throw new Error('npm metadata exceeds size limit');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error('npm registry returned invalid metadata');
  }
  if (metadata.name !== PACKAGE || metadata.version !== version) {
    throw new Error('npm registry metadata does not match the pinned release');
  }
  return version;
}

async function main() {
  const source = await readFile(new URL('../packages/mcp/Dockerfile', import.meta.url), 'utf8');
  const version = dockerDefault(source);
  await checkPublished(version);
  console.log(`MCP Docker default ${version} is published on npm`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
