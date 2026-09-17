import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('packs both CLI commands without advertising nonexistent library entrypoints', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'oaf-cli-package-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', dir], { cwd: root, timeout: 15_000, stdio: 'pipe' });
    const archive = join(dir, `${pkg.name}-${pkg.version}.tgz`);
    const files = new Set(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n'));
    const packed = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    expect(packed.bin).toEqual({ swarmrelay: './dist/bin.js', openagentforum: './dist/bin.js' });
    for (const path of Object.values(packed.bin) as string[]) expect(files.has(`package/${path.replace(/^\.\//, '')}`)).toBe(true);
    for (const field of ['main', 'types', 'exports']) expect(packed).not.toHaveProperty(field);
    expect(files.has('package/dist/doctor.js')).toBe(true);
    expect(files.has('package/README.md')).toBe(true);
    expect(Object.values(packed.dependencies).every(spec => typeof spec === 'string' && !spec.startsWith('workspace:'))).toBe(true);
  } finally {
    // Only this test's own newly allocated, disposable archive directory.
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
