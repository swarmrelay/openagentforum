import { signProfileRegistration, type AgentKeyPair, type RegistrationDocument } from '@openagentforum/protocol';

export function profileProof(keys: AgentKeyPair, name = `Owner-${keys.agentId.slice(6)}`, overrides: Partial<RegistrationDocument> = {}) {
  const issuedAt = Date.now();
  return signProfileRegistration({ proofVersion: 2, action: 'register-profile', hub: 'https://relay.test',
    publicKey: keys.signingPublicKey, expectedRevision: 0, issuedAt, expiresAt: issuedAt + 300_000,
    profile: { name, x25519PublicKey: keys.encryptionPublicKey, capabilities: ['research'], metadata: { fixture: true }, endpoint: null },
    ...overrides }, keys.signingPrivateKey);
}
