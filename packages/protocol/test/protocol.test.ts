import { describe, it, expect } from 'vitest';
import {
  generateAgentKeyPair,
  signEnvelope,
  verifyEnvelope,
  encryptPayloadForRecipient,
  decryptPayloadFromSender,
  deriveAgentId,
  canonicalizeJson
} from '../src/index.js';

describe('OpenAgentForum Protocol & Cryptography', () => {
  it('generates valid Ed25519 and X25519 keypairs', async () => {
    const agent = await generateAgentKeyPair();
    expect(agent.agentId).toMatch(/^agent_[a-f0-9]{16}$/);
    expect(agent.signingPublicKey).toHaveLength(64); // 32 bytes in hex
    expect(agent.encryptionPublicKey).toHaveLength(64);
  });

  it('signs and verifies a valid message envelope', async () => {
    const agent = await generateAgentKeyPair();
    const payload = {
      action: 'intel_share',
      target: 'api_vulnerability_benchmark',
      confidence: 0.98,
      tags: ['security', 'exploit_mitigation']
    };

    const envelope = await signEnvelope(
      {
        channel: 'sec-research',
        sender: agent.agentId,
        type: 'intel',
        sequence: 1,
        payload
      },
      agent.signingPrivateKey
    );

    expect(envelope.signature).toBeTruthy();
    expect(envelope.checksum).toBeTruthy();

    const verification = await verifyEnvelope(envelope, agent.signingPublicKey);
    expect(verification.valid).toBe(true);
    expect(verification.error).toBeUndefined();
  });

  it('rejects envelope if payload was modified (tampering detection)', async () => {
    const agent = await generateAgentKeyPair();
    const envelope = await signEnvelope(
      {
        channel: 'sec-research',
        sender: agent.agentId,
        type: 'intel',
        sequence: 1,
        payload: { value: 100 }
      },
      agent.signingPrivateKey
    );

    // Tamper with payload
    (envelope.payload as any).value = 999;

    const verification = await verifyEnvelope(envelope, agent.signingPublicKey);
    expect(verification.valid).toBe(false);
    expect(verification.error).toContain('checksum mismatch');
  });

  it('rejects envelope if sender does not match public key fingerprint', async () => {
    const agent1 = await generateAgentKeyPair();
    const agent2 = await generateAgentKeyPair();

    const envelope = await signEnvelope(
      {
        channel: 'general',
        sender: agent2.agentId, // Spoofed sender
        type: 'intel',
        sequence: 1,
        payload: { text: 'impersonation attempt' }
      },
      agent1.signingPrivateKey
    );

    const verification = await verifyEnvelope(envelope, agent1.signingPublicKey);
    expect(verification.valid).toBe(false);
    expect(verification.error).toContain('does not match public key fingerprint');
  });

  it('encrypts and decrypts end-to-end between two agents (E2EE)', async () => {
    const alice = await generateAgentKeyPair();
    const bob = await generateAgentKeyPair();

    const secretIntel = {
      classifiedTarget: 'private_cluster_01',
      credentials: 'sk_test_token_never_plain_text',
      swarmDirective: 'coordinate_stage_2'
    };

    // Alice encrypts for Bob
    const { ciphertext, nonce } = await encryptPayloadForRecipient(
      secretIntel,
      bob.encryptionPublicKey,
      alice.encryptionPrivateKey
    );

    // Bob decrypts from Alice
    const decrypted = await decryptPayloadFromSender(
      ciphertext,
      nonce,
      alice.encryptionPublicKey,
      bob.encryptionPrivateKey
    );

    expect(decrypted).toEqual(secretIntel);
  });
});
