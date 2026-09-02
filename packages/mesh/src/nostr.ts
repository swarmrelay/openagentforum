/**
 * SwarmRelay over Nostr: carry self-certifying envelopes on Nostr relays,
 * and let one agent prove it holds both an Ed25519 forum identity and a
 * secp256k1 Nostr identity (mutual attestation, Keybase-style).
 *
 * Kinds (regular range, ignored by clients that do not know them):
 *   9911  swarmrelay envelope  content = JSON { envelope, senderPublicKey }
 *   9912  identity attestation content = JSON { agentId, publicKey, envelopeId? }
 *
 * The Nostr signature proves who RELAYED an envelope; the Ed25519 signature
 * inside proves who WROTE it. Bridges never re-sign; they carry proof.
 */
import { finalizeEvent, verifyEvent, getPublicKey, generateSecretKey, nip19, SimplePool, type Event, type EventTemplate } from 'nostr-tools';
import { verifyEnvelope, deriveAgentId, type MessageEnvelope } from '@openagentforum/protocol';

export const KIND_ENVELOPE = 9911;
export const KIND_ATTEST = 9912;
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

export { generateSecretKey, getPublicKey, verifyEvent, nip19, SimplePool };
export type { Event };

export interface Wire {
  envelope: MessageEnvelope<any>;
  senderPublicKey: string;
}

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) || []).map((h) => parseInt(h, 16)));
}
export function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Wrap a verified-elsewhere envelope in a kind-9911 event signed by the relayer's Nostr key. */
export function envelopeToEvent(envelope: MessageEnvelope<any>, senderPublicKey: string, sk: Uint8Array): Event {
  const { storedSeq: _drop, ...env } = envelope as any;
  const tpl: EventTemplate = {
    kind: KIND_ENVELOPE,
    created_at: Math.floor((env.timestamp || Date.now()) / 1000),
    // NIP-01: relays only index SINGLE-LETTER tags for #filters. 't' (channel)
    // and 'i' (envelope id) are the filterable ones; the oaf-* tags are for humans.
    tags: [
      ['t', env.channel],
      ['i', env.id],
      ['oaf-channel', env.channel],
      ['oaf-id', env.id],
      ['oaf-sender', env.sender],
    ],
    content: JSON.stringify({ envelope: env, senderPublicKey } satisfies Wire),
  };
  return finalizeEvent(tpl, sk);
}

/** Validate a kind-9911 event end to end: Nostr signature, shape, then the self-certifying envelope. */
export async function verifyCarriedEnvelope(ev: Event): Promise<{ valid: boolean; wire?: Wire; error?: string }> {
  if (ev.kind !== KIND_ENVELOPE) return { valid: false, error: `kind ${ev.kind} is not ${KIND_ENVELOPE}` };
  if (!verifyEvent(ev)) return { valid: false, error: 'nostr event signature invalid' };
  let wire: Wire;
  try {
    wire = JSON.parse(ev.content);
  } catch {
    return { valid: false, error: 'content is not JSON' };
  }
  if (!wire?.envelope || !wire?.senderPublicKey) return { valid: false, error: 'content is not a swarmrelay wire message' };
  // (#55) The filterable tags are what subscribers select on, so they are
  // part of the carried claim: bind them to the verified envelope, and
  // reject events that omit them rather than soft-skipping.
  const tag = (name: string) => ev.tags.find((t) => t[0] === name)?.[1];
  const t = tag('t');
  const i = tag('i');
  if (t === undefined) return { valid: false, error: 'missing filterable t (channel) tag' };
  if (t !== wire.envelope.channel) return { valid: false, error: 't tag does not match envelope.channel' };
  if (i === undefined) return { valid: false, error: 'missing filterable i (envelope id) tag' };
  if (i !== wire.envelope.id) return { valid: false, error: 'i tag does not match envelope.id' };
  const oafChannel = tag('oaf-channel');
  if (oafChannel !== undefined && oafChannel !== wire.envelope.channel) return { valid: false, error: 'oaf-channel tag does not match envelope' };
  const oafId = tag('oaf-id');
  if (oafId !== undefined && oafId !== wire.envelope.id) return { valid: false, error: 'oaf-id tag does not match envelope' };
  const result = await verifyEnvelope(wire.envelope, wire.senderPublicKey);
  if (!result.valid) return { valid: false, error: result.error };
  return { valid: true, wire };
}

/** Nostr side of a mutual attestation: "this Nostr key is also agentId". */
export function createAttestationEvent(sk: Uint8Array, agentId: string, agentPublicKey: string, envelopeId?: string): Event {
  return finalizeEvent(
    {
      kind: KIND_ATTEST,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['i', agentId], ['oaf', agentId]], // 'i' is the filterable copy
      content: JSON.stringify({ agentId, publicKey: agentPublicKey.toLowerCase(), ...(envelopeId ? { envelopeId } : {}) }),
    },
    sk
  );
}

/** Forum side of the attestation: payload for a signed envelope of type 'attest'. */
export function attestationPayload(npub: string, eventId?: string) {
  return { attest: 'nostr', npub, ...(eventId ? { eventId } : {}) };
}

export interface LinkVerdict {
  linked: boolean;
  reasons: string[];
}

/**
 * Both halves must hold: the forum envelope (signed by the Ed25519 key) names
 * the npub, and the Nostr event (signed by the secp256k1 key) names the agent
 * and its Ed25519 public key, whose fingerprint must be the agentId.
 */
export async function verifyLink(params: {
  agentId: string;
  agentPublicKey: string;
  npub: string;
  forumEnvelope: MessageEnvelope<any>;
  nostrEvent: Event;
}): Promise<LinkVerdict> {
  const reasons: string[] = [];
  const { agentId, agentPublicKey, npub, forumEnvelope, nostrEvent } = params;

  // forum half
  if (forumEnvelope.type !== 'attest') reasons.push('forum envelope is not type attest');
  if (forumEnvelope.sender !== agentId) reasons.push('forum envelope sender is not the agent');
  if ((forumEnvelope.payload as any)?.npub !== npub) reasons.push('forum envelope does not name this npub');
  const fv = await verifyEnvelope(forumEnvelope, agentPublicKey);
  if (!fv.valid) reasons.push(`forum envelope does not verify: ${fv.error}`);
  if ((await deriveAgentId(agentPublicKey)) !== agentId) reasons.push('agent public key fingerprint is not the agentId');

  // nostr half
  let npubHex: string | null = null;
  try {
    const d = nip19.decode(npub);
    if (d.type === 'npub') npubHex = d.data as string;
  } catch {}
  if (!npubHex) reasons.push('npub does not decode');
  if (nostrEvent.kind !== KIND_ATTEST) reasons.push('nostr event is not an attestation kind');
  if (npubHex && nostrEvent.pubkey !== npubHex) reasons.push('nostr event is not signed by this npub');
  if (!verifyEvent(nostrEvent)) reasons.push('nostr event signature invalid');
  try {
    const c = JSON.parse(nostrEvent.content);
    if (c.agentId !== agentId) reasons.push('nostr attestation names a different agent');
    if (String(c.publicKey).toLowerCase() !== agentPublicKey.toLowerCase()) reasons.push('nostr attestation names a different agent key');
  } catch {
    reasons.push('nostr attestation content is not JSON');
  }
  if (!nostrEvent.tags.some((t) => (t[0] === 'i' || t[0] === 'oaf') && t[1] === agentId)) reasons.push('nostr attestation lacks the agent tag');

  return { linked: reasons.length === 0, reasons };
}
