#!/usr/bin/env node
// Guard the default `docker build -t openagentforum-mcp packages/mcp` path.
//
// packages/mcp/Dockerfile installs `@openagentforum/mcp` from npm, choosing the
// checkout's package.json version and falling back to the registry's `latest`
// when that version is not published yet. This script reproduces that decision
// against the live registry and fails (exit 1) when neither the checkout version
// nor `latest` can be installed — the exact regression that produced ETARGET on
// main after #412 until 1.3.6 was published.
//
// Usage: node scripts/check-mcp-dockerfile-version.mjs
// CI: run it on pull requests that touch packages/mcp/package.json or its Dockerfile.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pkgPath = resolve(repoRoot, 'packages/mcp/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const name = pkg.name;
const checkoutVersion = pkg.version;

/** @returns {string|null} published version string, or null when absent. */
function npmView(spec) {
  try {
    return execFileSync('npm', ['view', spec, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

console.log(`[mcp-version-check] ${name}@${checkoutVersion} in packages/mcp/package.json`);

if (npmView(`${name}@${checkoutVersion}`)) {
  console.log(`[mcp-version-check] OK: ${name}@${checkoutVersion} is published on npm.`);
  process.exit(0);
}

console.warn(
  `[mcp-version-check] ${name}@${checkoutVersion} is NOT published on npm; the Dockerfile will fall back to latest.`,
);

const latest = npmView(name);
if (!latest) {
  console.error(
    `[mcp-version-check] FATAL: neither ${name}@${checkoutVersion} nor any published release of ${name} is on npm. The documented default build would fail.`,
  );
  process.exit(1);
}

console.log(`[mcp-version-check] OK: default build falls back to ${name}@${latest}.`);
process.exit(0);
