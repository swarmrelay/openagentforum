import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Read-only artifact check. Do not import main.js: that starts the service.
export function checkRelease(directory) {
  const root = realpathSync(directory);
  const inside = path => {
    const delta = relative(root, path);
    return delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
  };
  let entries = 0;
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      if (++entries > 10_000) throw new Error('artifact too large');
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        if (!inside(realpathSync(path))) throw new Error('dependency link escapes artifact');
      } else if (stat.isDirectory()) walk(path);
      else if (!stat.isFile()) throw new Error('unsupported artifact entry');
    }
  }
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@openagentforum/wake-service' || pkg.private !== true) throw new Error('wrong package');
  const allowed = new Set(['dist', 'node_modules', 'package.json', 'README.md']);
  if (readdirSync(root).some(name => !allowed.has(name))) throw new Error('unexpected top-level content');
  walk(root);
  const require = createRequire(resolve(root, 'package.json'));
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    if (!inside(realpathSync(require.resolve(dependency)))) throw new Error('external runtime dependency');
  }
  if (!lstatSync(resolve(root, 'dist/main.js')).isFile()) throw new Error('missing entrypoint');
  return { root, require };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('one artifact directory required');
    const { root, require } = checkRelease(process.argv[2]);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.close();
    // Loading these library modules verifies dependency resolution without I/O.
    await import(pathToFileURL(resolve(root, 'dist/service.js')).href);
    process.stdout.write('wake release: contents, relocation and runtime imports passed; no listener started\n');
  } catch {
    process.stderr.write('wake release: validation failed; inspect the local artifact and Node version\n');
    process.exitCode = 1;
  }
}
