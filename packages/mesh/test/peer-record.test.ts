import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from 'libp2p';
import { MeshNode } from '../src/index.js';

// Exercise the peer store used by MeshNode, not a second test-only installation.
// Resolve matching wire helpers from that same runtime dependency tree.
const requireHere = createRequire(import.meta.url);
const requireLibp2p = createRequire(requireHere.resolve('libp2p'));
const requireStore = createRequire(requireLibp2p.resolve('@libp2p/peer-store'));
const { PeerRecord, RecordEnvelope } = await import(pathToFileURL(requireStore.resolve('@libp2p/peer-record')).href);
const { peerIdFromPrivateKey } = await import(pathToFileURL(requireLibp2p.resolve('@libp2p/peer-id')).href);

async function fixture() {
  const mesh = await MeshNode.create({ listen: [] });
  const node = Reflect.get(mesh, 'node') as Libp2p;
  const signerKey = await generateKeyPair('Ed25519');
  const victimKey = await generateKeyPair('Ed25519');
  const signer = peerIdFromPrivateKey(signerKey);
  const victim = peerIdFromPrivateKey(victimKey);
  const legitimate = multiaddr('/ip4/127.0.0.1/tcp/4001');
  const forged = multiaddr('/ip4/127.0.0.1/tcp/4002');
  const record = async (key: typeof signerKey, peerId: typeof signer, address = legitimate, sequence = 1n) => {
    const payload = new PeerRecord({ peerId, multiaddrs: [address], seqNumber: sequence });
    return (await RecordEnvelope.seal(payload, key)).marshal();
  };
  return { mesh, store: node.peerStore, signerKey, victimKey, signer, victim, legitimate, forged, record };
}

describe('peer-record signer binding (GHSA-vrf4-mx87-p53w)', () => {
  it('accepts an authentic record and rejects an older authentic record', async () => {
    const f = await fixture();
    try {
      const current = await f.record(f.victimKey, f.victim, f.legitimate, 2n);
      expect(await f.store.consumePeerRecord(current, { expectedPeer: f.victim })).toBe(true);
      const before = await f.store.get(f.victim);
      expect(before.addresses.map(a => [a.multiaddr.toString(), a.isCertified])).toEqual([[f.legitimate.toString(), true]]);
      expect(await f.store.consumePeerRecord(await f.record(f.victimKey, f.victim, f.forged, 1n))).toBe(false);
      expect(await f.store.get(f.victim)).toEqual(before);
    } finally { await f.mesh.stop(); }
  });

  for (const expected of ['absent', 'signer', 'victim'] as const) {
    it(`does not create another peer's entry from a mismatched signer (expected peer: ${expected})`, async () => {
      const f = await fixture();
      try {
        const bytes = await f.record(f.signerKey, f.victim, f.forged, 999n);
        const options = expected === 'absent' ? {} : { expectedPeer: f[expected] };
        expect(await f.store.consumePeerRecord(bytes, options)).toBe(false);
        expect(await f.store.has(f.victim)).toBe(false);
        expect(await f.store.has(f.signer)).toBe(false);
      } finally { await f.mesh.stop(); }
    });
  }

  it('preserves an existing certified record and its sequence after a forged high-sequence update', async () => {
    const f = await fixture();
    try {
      expect(await f.store.consumePeerRecord(await f.record(f.victimKey, f.victim))).toBe(true);
      const before = await f.store.get(f.victim);
      const bytes = await f.record(f.signerKey, f.victim, f.forged, 999n);
      expect(await f.store.consumePeerRecord(bytes, { expectedPeer: f.signer })).toBe(false);
      expect(await f.store.get(f.victim)).toEqual(before);
      expect(await f.store.has(f.signer)).toBe(false);
      const next = await f.record(f.victimKey, f.victim, f.legitimate, 2n);
      expect(await f.store.consumePeerRecord(next, { expectedPeer: f.victim })).toBe(true);
    } finally { await f.mesh.stop(); }
  });
});
