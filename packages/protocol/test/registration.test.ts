import { describe, it, expect } from 'vitest';
import { generateAgentKeyPair, isRegistrationDocument, signProfileRegistration, verifyProfileRegistration,
  registrationDigest, type RegistrationDocument } from '../src/index.js';

describe('bound registration proofs', () => {
  async function fixture() {
    const keys = await generateAgentKeyPair();
    const issuedAt = Date.now();
    const document: RegistrationDocument = { proofVersion: 2, action: 'register-profile', hub: 'https://relay.test',
      publicKey: keys.signingPublicKey, expectedRevision: 0, issuedAt, expiresAt: issuedAt + 300_000,
      profile: { name: 'Fixture', x25519PublicKey: keys.encryptionPublicKey, capabilities: ['research'], metadata: { b: 2, a: 1 }, endpoint: null } };
    return { keys, document };
  }
  it('canonicalizes every signed field and snapshots before async signing', async () => {
    const { keys, document } = await fixture();
    const pending = signProfileRegistration(document, keys.signingPrivateKey);
    document.profile.name = 'Changed after signing started';
    const proof = await pending;
    expect(proof.profile.name).toBe('Fixture');
    expect(await verifyProfileRegistration(proof, document.hub)).toEqual(proof);
    const reordered = { ...proof, profile: { ...proof.profile, metadata: { a: 1, b: 2 } } };
    expect(await verifyProfileRegistration(reordered, document.hub)).not.toBeNull();
    expect(await registrationDigest(reordered)).toBe(await registrationDigest(proof));
    expect(await verifyProfileRegistration(proof, 'https://other.test')).toBeNull();
    expect(await verifyProfileRegistration({ ...proof, other: true }, document.hub)).toBeNull();
  });
  it('bounds JSON shape, keys, numbers, metadata depth and size before crypto work', async () => {
    const { document } = await fixture();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const invalid = [
      { ...document, expectedRevision: -1 }, { ...document, expectedRevision: Number.MAX_SAFE_INTEGER },
      { ...document, expiresAt: document.expiresAt + 1 }, { ...document, publicKey: 'not-a-key' },
      { ...document, hub: 'https://user:password@relay.test' }, { ...document, hub: 'https://relay.test/' },
      ...[cyclic, { v: undefined }, { v: NaN }, { v: new Date() }, { v: 'x'.repeat(2049) }].map(metadata => ({ ...document, profile: { ...document.profile, metadata } })),
      { ...document, profile: { ...document.profile, capabilities: Array(33).fill('research') } },
      { ...document, profile: { ...document.profile, endpoint: 'javascript:alert(1)' } },
      { ...document, profile: { ...document.profile, x25519PublicKey: 'xyz' } },
    ];
    for (const value of invalid) expect(isRegistrationDocument(value)).toBe(false);
  });
});
