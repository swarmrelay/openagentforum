import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './check-release.mjs';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));

/** This deliberately handles only the current two-package, zero-external-dep
 * runtime. Fail closed if dependencies change; do not silently omit any. */
export function buildRelease(directory) {
  const root = resolve(directory);
  if (existsSync(root)) throw new Error('target must not exist');
  const wake = json(resolve(checkout, 'packages/wake-service/package.json'));
  const protocol = json(resolve(checkout, 'packages/protocol/package.json'));
  if (wake.name !== '@openagentforum/wake-service' || wake.private !== true ||
      protocol.name !== '@openagentforum/protocol' ||
      JSON.stringify(Object.keys(wake.dependencies ?? {})) !== JSON.stringify(['@openagentforum/protocol']) ||
      wake.dependencies['@openagentforum/protocol'] !== 'workspace:*' ||
      Object.keys(protocol.dependencies ?? {}).length || Object.keys(protocol.optionalDependencies ?? {}).length ||
      Object.keys(wake.optionalDependencies ?? {}).length || Object.keys(wake.peerDependencies ?? {}).length ||
      Object.keys(protocol.peerDependencies ?? {}).length) throw new Error('unsupported runtime dependency graph');
  for (const name of ['wake-service', 'protocol']) {
    if (!existsSync(resolve(checkout, `packages/${name}/dist/${name === 'protocol' ? 'index' : 'main'}.js`))) throw new Error('build packages first');
  }
  // Non-recursive root creation: caller supplies a private existing parent.
  // Never overwrite an existing release or automatically delete partial output.
  mkdirSync(root, { mode: 0o755 });
  for (const [name, pkg, destination] of [
    ['wake-service', wake, root],
    ['protocol', protocol, resolve(root, 'node_modules/@openagentforum/protocol')],
  ]) {
    mkdirSync(destination, { recursive: true, mode: 0o755 });
    cpSync(resolve(checkout, `packages/${name}/dist`), resolve(destination, 'dist'), { recursive: true, errorOnExist: true, force: false });
    cpSync(resolve(checkout, `packages/${name}/README.md`), resolve(destination, 'README.md'), { errorOnExist: true, force: false });
    const { devDependencies: _dev, scripts: _scripts, ...runtime } = pkg;
    if (name === 'wake-service') runtime.dependencies = { '@openagentforum/protocol': protocol.version };
    writeFileSync(resolve(destination, 'package.json'), JSON.stringify(runtime, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  }
  checkRelease(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('one new artifact directory required');
    buildRelease(process.argv[2]);
    process.stdout.write('wake release: local artifact prepared; nothing installed or deployed\n');
  } catch {
    process.stderr.write('wake release: build refused; check built packages, dependency graph and a new target directory; any partial output was left for inspection\n');
    process.exitCode = 1;
  }
}
