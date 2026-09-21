import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function assertDeployRevision({ ref, sha, checkout, main }) {
  if (ref !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(sha ?? '') || checkout !== sha || main !== sha) {
    throw new Error('Production requires the current main revision; stale or non-main runs cannot deploy.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error();
    const options = { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
    const checkout = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    const remote = execFileSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], options).trim();
    const match = /^([a-f0-9]{40})\trefs\/heads\/main$/.exec(remote);
    assertDeployRevision({ ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, checkout, main: match?.[1] });
    console.log('Production revision matches current main.');
  } catch {
    console.error('Production revision check failed. Use a validated current-main run; no stale deployment override is provided.');
    process.exitCode = 1;
  }
}
