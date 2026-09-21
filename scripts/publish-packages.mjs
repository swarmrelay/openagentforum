import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryVersion } from './check-discovery-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const releaseDirectories = ['protocol', 'sdk', 'server', 'mcp', 'cli', 'mesh', 'peer-stream'];

export function releasePackages() {
  return releaseDirectories.map(dir => ({ dir, ...JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) }));
}

/** Complete anonymous preflight before any pack or publish. Errors are not absence. */
export async function publicationPlan(packages, fetchImpl = globalThis.fetch) {
  if (packages.length !== releaseDirectories.length) throw new Error('Invalid release package set');
  for (const [index, pkg] of packages.entries()) {
    const dir = releaseDirectories[index];
    if (pkg.dir !== dir || pkg.name !== (dir === 'cli' ? 'swarmrelay' : `@openagentforum/${dir}`) ||
        pkg.private || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('Invalid release package identity');
  }
  const plan = [];
  for (const pkg of packages) {
    const found = await registryVersion(pkg, fetchImpl, { allowMissing: true });
    if (found !== null && (typeof found !== 'object' || found.name !== pkg.name || found.version !== pkg.version)) {
      throw new Error(`${pkg.name}@${pkg.version}: mismatched registry identity`);
    }
    plan.push({ dir: pkg.dir, name: pkg.name, version: pkg.version, action: found === null ? 'publish' : 'skip' });
  }
  return plan;
}

export async function runRelease({ packages = releasePackages(), fetchImpl, publish, log = console.log }) {
  const plan = await publicationPlan(packages, fetchImpl);
  for (const entry of plan) {
    log(`${entry.action} ${entry.name}@${entry.version}`);
    if (entry.action === 'publish') await publish(entry);
  }
  return plan;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let artifacts;
  try {
    if (process.argv.length !== 3 || !['--plan', '--publish'].includes(process.argv[2])) throw new Error('Usage: publish-packages.mjs --plan|--publish');
    if (process.argv[2] === '--plan') {
      console.log(JSON.stringify(await publicationPlan(releasePackages()), null, 2));
    } else {
      await runRelease({ publish(entry) {
        artifacts ??= mkdtempSync(join(tmpdir(), 'oaf-release-'));
        const destination = join(artifacts, entry.dir);
        mkdirSync(destination);
        execFileSync('pnpm', ['pack', '--pack-destination', destination], {
          cwd: join(root, 'packages', entry.dir), stdio: 'inherit', timeout: 60_000,
        });
        const artifact = join(destination, `${entry.name.replace(/^@/, '').replace('/', '-')}-${entry.version}.tgz`);
        execFileSync('npm', ['publish', artifact, '--access', 'public', '--registry', 'https://registry.npmjs.org'], {
          cwd: root, stdio: 'inherit', timeout: 120_000,
        });
      } });
    }
  } catch {
    console.error('Release stopped. Resolve registry/authentication errors and reconcile any attempted publication before rerunning.');
    process.exitCode = 1;
  } finally {
    if (artifacts) rmSync(artifacts, { recursive: true, force: true });
  }
}
