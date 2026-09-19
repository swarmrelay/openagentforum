import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as client from '../src/client.js';

it('keeps the candidate unpublished with one typed entry point and no executable/install hooks', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(pkg.name).toBe('@openagentforum/peer-stream');
  expect(pkg.private).toBe(true);
  expect(pkg.exports).toEqual({ '.': { types: './dist/client.d.ts', import: './dist/client.js' } });
  expect(pkg.bin).toBeUndefined();
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']) expect(pkg.scripts[hook]).toBeUndefined();
  expect(pkg.files).toEqual(['dist', 'README.md', 'PRIVATE_RENDEZVOUS.md', 'DIRECT_TEST.md', 'RENDEZVOUS.md', 'PACKAGING.md']);
  const release = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
  expect(release).toContain('node scripts/check-peer-install.mjs');
  expect(release.match(/for dir in .*; do/)?.[0]).not.toContain('packages/peer-stream');
});

it('exports the existing bounded APIs, not a command runner or raw HTTP writer', () => {
  expect(Object.keys(client).sort()).toEqual([
    'ForumMailbox', 'ForumRendezvous', 'FramedStream', 'LocalPeerStream', 'PRIVATE_SETUP_LIMITS',
    'PUBLIC_FORUM_ORIGIN', 'PrivateForumMailbox', 'RENDEZVOUS_LIMITS', 'STREAM_LIMITS', 'STREAM_PROTOCOL',
    'StreamFailure', 'peerIdFor', 'readRendezvous', 'rendezvousScope',
  ].sort());
  expect(() => new client.ForumMailbox(client.PUBLIC_FORUM_ORIGIN, 'fixture')).toThrow();
});
