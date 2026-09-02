import { describe, it, expect } from 'vitest';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';
import {
  envelopeToEvent, verifyCarriedEnvelope, createAttestationEvent, attestationPayload, verifyLink,
  generateSecretKey, getPublicKey, nip19, KIND_ENVELOPE,
} from '../src/nostr.js';

describe('SwarmRelay over Nostr: carried envelopes and mutual attestation', () => {
  it('carries an envelope in a kind-9911 event and verifies both signatures', async () => {
    const agent = await generateAgentKeyPair();
    const sk = generateSecretKey();
    const envelope = await signEnvelope({ channel: 'general', sender: agent.agentId, type: 'intel', sequence: 0, payload: { message: 'over nostr' } }, agent.signingPrivateKey);
    const ev = envelopeToEvent(envelope, agent.signingPublicKey, sk);
    expect(ev.kind).toBe(KIND_ENVELOPE);
    expect(ev.pubkey).toBe(getPublicKey(sk));
    const ok = await verifyCarriedEnvelope(ev);
    expect(ok.valid).toBe(true);
    expect(ok.wire?.envelope.id).toBe(envelope.id);

    // the relayer cannot tamper with what it carries
    const tampered = { ...ev, content: JSON.stringify({ envelope: { ...envelope, payload: { message: 'forged' } }, senderPublicKey: agent.signingPublicKey }) };
    const bad = await verifyCarriedEnvelope(tampered as any);
    expect(bad.valid).toBe(false); // nostr signature no longer matches content
  });

  it('links a forum identity and a nostr identity only when both halves hold', async () => {
    const agent = await generateAgentKeyPair();
    const sk = generateSecretKey();
    const npub = nip19.npubEncode(getPublicKey(sk));
    const nostrEvent = createAttestationEvent(sk, agent.agentId, agent.signingPublicKey);
    const forumEnvelope = await signEnvelope(
      { channel: 'general', sender: agent.agentId, type: 'attest', sequence: 0, payload: attestationPayload(npub, nostrEvent.id) },
      agent.signingPrivateKey
    );
    const good = await verifyLink({ agentId: agent.agentId, agentPublicKey: agent.signingPublicKey, npub, forumEnvelope, nostrEvent });
    expect(good.linked).toBe(true);

    // a different nostr key claiming the same agent: forum half does not name it
    const impostorSk = generateSecretKey();
    const impostorNpub = nip19.npubEncode(getPublicKey(impostorSk));
    const impostorEvent = createAttestationEvent(impostorSk, agent.agentId, agent.signingPublicKey);
    const bad = await verifyLink({ agentId: agent.agentId, agentPublicKey: agent.signingPublicKey, npub: impostorNpub, forumEnvelope, nostrEvent: impostorEvent });
    expect(bad.linked).toBe(false);
    expect(bad.reasons.join(' ')).toMatch(/does not name this npub/);
  });
});
