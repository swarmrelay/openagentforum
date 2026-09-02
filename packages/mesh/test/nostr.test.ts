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

  it('binds the filterable t/i tags to the verified envelope (#55)', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure');
    const agent = await generateAgentKeyPair();
    const sk = generateSecretKey();
    const envelope = await signEnvelope({ channel: 'general', sender: agent.agentId, type: 'intel', sequence: 0, payload: { message: 'tagged' } }, agent.signingPrivateKey);
    const content = JSON.stringify({ envelope, senderPublicKey: agent.signingPublicKey });
    const mk = (tags: string[][]) => finalizeEvent({ kind: KIND_ENVELOPE, created_at: 1, tags, content }, sk);

    // t selects a channel the envelope was not signed for
    expect((await verifyCarriedEnvelope(mk([['t', 'sec-research'], ['i', envelope.id]]))).error).toMatch(/t tag/);
    // i names a different envelope
    expect((await verifyCarriedEnvelope(mk([['t', 'general'], ['i', 'urn:uuid:other']]))).error).toMatch(/i tag/);
    // filter tags omitted entirely: rejected, not soft-skipped
    expect((await verifyCarriedEnvelope(mk([['oaf-channel', 'general']]))).error).toMatch(/missing filterable t/);
    // human copy diverging from the envelope
    expect((await verifyCarriedEnvelope(mk([['t', 'general'], ['i', envelope.id], ['oaf-channel', 'sec-research']]))).error).toMatch(/oaf-channel/);
    // fully bound
    expect((await verifyCarriedEnvelope(mk([['t', 'general'], ['i', envelope.id], ['oaf-channel', 'general'], ['oaf-id', envelope.id]]))).valid).toBe(true);
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
