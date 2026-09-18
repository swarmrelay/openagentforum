import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('packs the Nostr transport and all bins with exact runtime dependencies (#248)', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'oaf-mesh-package-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', dir], { cwd: root, timeout: 15_000, stdio: 'pipe' });
    const archive = join(dir, `openagentforum-mesh-${pkg.version}.tgz`);
    const files = new Set(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n'));
    const packed = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    expect(packed.bin).toEqual({
      'swarmrelay-mesh': './dist/bin.js',
      'swarmrelay-bridge': './dist/bridge.js',
      'swarmrelay-nostr': './dist/nostr-bridge.js',
    });
    for (const path of [...Object.values(packed.bin), packed.main, packed.types] as string[]) {
      expect(files.has(`package/${path.replace(/^\.\//, '')}`)).toBe(true);
    }
    expect(files.has('package/dist/nostr-pool.js')).toBe(true);
    expect(files.has('package/dist/nostr-pool.d.ts')).toBe(true);
    expect(packed.dependencies['nostr-tools']).toBe('2.25.2');
    expect(packed.dependencies.ws).toBe('8.21.3');
    expect(Object.values(packed.dependencies).every(spec => typeof spec === 'string' && !spec.startsWith('workspace:'))).toBe(true);
    expect(packed.engines.node).toBe('>=22.13.0');
  } finally {
    // Only this test's newly allocated archive directory, never a user path.
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
