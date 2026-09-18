import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`../../../deploy/relay/${name}`, import.meta.url), 'utf8');

describe('public bootstrap examples (#249)', () => {
  it('pins the same reviewed published baseline in both launchers', () => {
    // Deliberately not the source package version: publish before advancing.
    expect(read('Dockerfile')).toContain('@openagentforum/mesh@0.4.0');
    expect(read('swarmrelay-relay.service')).toContain('@openagentforum/mesh@0.4.0');
    expect(read('README.md')).toContain('Node 22.13+');
  });

  it('distinguishes circuit connectivity and encrypted payloads from broader guarantees', () => {
    expect(read('README.md')).toContain('not an anonymity guarantee');
    expect(read('README.md')).toContain('not** proof of GossipSub delivery');
    expect(read('README.md')).toContain('can read subscribed public messages');
    expect(read('Dockerfile')).not.toContain('nothing more');
  });
});
