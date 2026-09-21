import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as client from '../src/client.js';

it('publishes one typed entry point with no executable/install hooks and a registry consumer gate', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(pkg.name).toBe('@openagentforum/peer-stream');
  expect(pkg.private).toBeUndefined();
  expect(pkg.publishConfig).toEqual({ access: 'public' });
  expect(pkg.repository.directory).toBe('packages/peer-stream');
  expect(pkg.exports).toEqual({ '.': { types: './dist/client.d.ts', import: './dist/client.js' } });
  expect(pkg.bin).toBeUndefined();
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']) expect(pkg.scripts[hook]).toBeUndefined();
  expect(pkg.files).toEqual(['dist', 'README.md', 'PRIVATE_RENDEZVOUS.md', 'DIRECT_TEST.md', 'RENDEZVOUS.md', 'PACKAGING.md']);
  const release = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
  expect(release).toContain('node scripts/check-peer-install.mjs');
  expect(release.match(/for dir in .*; do/)?.[0]).toContain('packages/peer-stream');
  expect(release).toContain('node scripts/check-peer-install.mjs --registry-client');
});

it('exports the existing bounded APIs, not a command runner or raw HTTP writer', () => {
  expect(Object.keys(client).sort()).toEqual([
    'ForumMailbox', 'ForumRendezvous', 'FramedStream', 'LocalPeerStream', 'PRIVATE_SETUP_LIMITS',
    'PUBLIC_FORUM_ORIGIN', 'PrivateForumMailbox', 'RENDEZVOUS_LIMITS', 'STREAM_LIMITS', 'STREAM_PROTOCOL',
    'StreamFailure', 'peerIdFor', 'readRendezvous', 'rendezvousScope',
  ].sort());
  expect(() => new client.ForumMailbox(client.PUBLIC_FORUM_ORIGIN, 'fixture')).toThrow();
});
