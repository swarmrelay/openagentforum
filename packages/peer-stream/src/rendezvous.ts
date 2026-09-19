/** Source-only rendezvous over ordinary signed OAF envelopes; not room admission. */
import { randomBytes } from 'node:crypto';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { canonicalizeJson, deriveAgentId, sha256Hex, signEnvelope, verifyEnvelope, type MessageEnvelope } from '@openagentforum/protocol';
import { LocalPeerStream, STREAM_PROTOCOL } from './index.js';
import { StreamFailure, type FramedStream } from './framing.js';

export const RENDEZVOUS_LIMITS = Object.freeze({ envelopeBytes: 8192, lifetimeMs: 30_000, futureSkewMs: 2000 });
export type RendezvousIdentity = { signingPrivateKey: string; signingPublicKey: string };
export type RendezvousScope = Readonly<{ hub: string; channel: string }>;
type Payload = Record<string, string | number>;
type Envelope = MessageEnvelope<Payload>;
type SessionState = 'new' | 'working' | 'offered' | 'accepted' | 'bound' | 'closed';
const offerKind = 'oaf.stream.offer.v1', acceptKind = 'oaf.stream.accept.v1';
const hex = (value: unknown, length: number): value is string => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const fail = (): never => { throw new StreamFailure('protocol'); };

export function rendezvousScope(hub: string, channel: string): RendezvousScope {
  // Local-only first integration: never accidentally publish a local dial address.
  let url: URL;
  try { url = new URL(hub); } catch { throw new StreamFailure('invalid_input'); }
  if (url.origin !== hub || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(channel)) throw new StreamFailure('invalid_input');
  return Object.freeze({ hub, channel });
}
export function peerIdFor(publicKey: string): string {
  if (!hex(publicKey, 64)) throw new StreamFailure('invalid_input');
  return peerIdFromPublicKey(publicKeyFromRaw(Buffer.from(publicKey, 'hex'))).toString();
}
function validAddress(address: unknown, publicKey: string): boolean {
  if (typeof address !== 'string' || address.length > 180) return false;
  const match = /^\/ip4\/127\.0\.0\.1\/tcp\/([1-9][0-9]{0,4})\/p2p\/([^/]+)$/.exec(address);
  return !!match && Number(match[1]) <= 65535 && match[2] === peerIdFor(publicKey);
}
function keys(value: object, expected: string[]) {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(',')) fail();
}
function fresh(envelope: Envelope): void {
  const now = Date.now(), expires = envelope.payload.expiresAt;
  if (!integer(expires) || expires <= now || envelope.timestamp > now + RENDEZVOUS_LIMITS.futureSkewMs
      || expires <= envelope.timestamp || expires - envelope.timestamp > RENDEZVOUS_LIMITS.lifetimeMs) fail();
}
/** Snapshot only signed fields; unsigned relay cursors/flags/replyTo are never authority. */
export async function readRendezvous(raw: string, scope: RendezvousScope, from: string, to: string,
  kind: 'offer' | 'accept'): Promise<Envelope> {
  scope = rendezvousScope(scope.hub, scope.channel);
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > RENDEZVOUS_LIMITS.envelopeBytes) fail();
  let value;
  try { value = JSON.parse(raw); } catch { return fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const { id, channel, sender, type, sequence, timestamp, payload, signature, checksum } = value;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
      || channel !== scope.channel || type !== 'intel' || typeof sender !== 'string' || !integer(sequence)
      || !integer(timestamp) || !hex(signature, 128) || !hex(checksum, 64) || !payload || typeof payload !== 'object' || Array.isArray(payload)) fail();
  keys(payload, ['kind', 'hub', 'sessionId', 'from', 'to', 'expiresAt', 'protocol', ...(kind === 'offer' ? ['address'] : ['offerId', 'offerHash'])]);
  if (payload.kind !== (kind === 'offer' ? offerKind : acceptKind) || payload.hub !== scope.hub
      || payload.from !== from || payload.to !== to || from === to || !hex(from, 64) || !hex(to, 64)
      || !hex(payload.sessionId, 64) || payload.protocol !== STREAM_PROTOCOL) fail();
  if (kind === 'offer' ? !validAddress(payload.address, from) : typeof payload.offerId !== 'string' || !hex(payload.offerHash, 64)) fail();
  const envelope: Envelope = { id, channel, sender, type, sequence, timestamp, payload, signature, checksum };
  fresh(envelope);
  if (!(await verifyEnvelope(envelope, from)).valid) fail();
  fresh(envelope); // crypto awaits do not extend a signed invitation's life
  return envelope;
}

/** Explicit one-shot offer/accept policy; directory discovery never invokes this class. */
export class ForumRendezvous {
  readonly #identity: RendezvousIdentity;
  readonly #peer: string;
  readonly #scope: RendezvousScope;
  #state: SessionState = 'new';
  #node: LocalPeerStream | null = null;
  #offer: Envelope | null = null;
  #acceptance: Envelope | null = null;
  constructor(identity: RendezvousIdentity, peerPublicKey: string, scope: RendezvousScope) {
    peerIdFor(identity.signingPublicKey); peerIdFor(peerPublicKey);
    if (identity.signingPublicKey === peerPublicKey) throw new StreamFailure('invalid_input');
    this.#identity = { signingPrivateKey: identity.signingPrivateKey, signingPublicKey: identity.signingPublicKey }; this.#peer = peerPublicKey;
    this.#scope = rendezvousScope(scope.hub, scope.channel);
  }
  #begin(expected: SessionState) {
    if (this.#state !== expected) throw new StreamFailure('closed');
    this.#state = 'working';
  }
  #checkOpen() { if (this.#state === 'closed') throw new StreamFailure('closed'); }
  async #sign(payload: Payload, sequence: number): Promise<string> {
    if (!integer(sequence)) throw new StreamFailure('invalid_input');
    return JSON.stringify(await signEnvelope({ channel: this.#scope.channel, sender: await deriveAgentId(this.#identity.signingPublicKey),
      type: 'intel', sequence, payload }, this.#identity.signingPrivateKey));
  }
  async offer(sequence: number): Promise<string> {
    this.#begin('new');
    try {
      this.#node = await LocalPeerStream.create(this.#identity, this.#peer);
      this.#checkOpen();
      const raw = await this.#sign({ kind: offerKind, hub: this.#scope.hub, sessionId: randomBytes(32).toString('hex'),
        from: this.#identity.signingPublicKey, to: this.#peer, expiresAt: Date.now() + RENDEZVOUS_LIMITS.lifetimeMs,
        protocol: STREAM_PROTOCOL, address: this.#node.address }, sequence);
      this.#offer = await readRendezvous(raw, this.#scope, this.#identity.signingPublicKey, this.#peer, 'offer');
      this.#checkOpen();
      this.#state = 'offered'; return raw;
    } catch { await this.close(); throw new StreamFailure('protocol'); }
  }
  /** Calling accept is the caller's explicit authorization of this exact invitation. */
  async accept(raw: string, sequence: number): Promise<string> {
    this.#begin('new');
    try {
      this.#offer = await readRendezvous(raw, this.#scope, this.#peer, this.#identity.signingPublicKey, 'offer');
      this.#node = await LocalPeerStream.create(this.#identity, this.#peer);
      const offer = this.#offer;
      const reply = await this.#sign({ kind: acceptKind, hub: this.#scope.hub, sessionId: offer.payload.sessionId,
        from: this.#identity.signingPublicKey, to: this.#peer, expiresAt: offer.payload.expiresAt,
        protocol: STREAM_PROTOCOL, offerId: offer.id, offerHash: offer.checksum }, sequence);
      this.#acceptance = await readRendezvous(reply, this.#scope, this.#identity.signingPublicKey, this.#peer, 'accept');
      fresh(offer);
      this.#checkOpen();
      this.#state = 'accepted'; return reply;
    } catch { await this.close(); throw new StreamFailure('protocol'); }
  }
  /** Offerer: validate the signed acceptance before awaiting the pinned connection. */
  async wait(rawAcceptance: string): Promise<FramedStream> {
    this.#begin('offered');
    try {
      this.#acceptance = await readRendezvous(rawAcceptance, this.#scope, this.#peer, this.#identity.signingPublicKey, 'accept');
      const p = this.#acceptance.payload, offer = this.#offer!;
      if (p.offerId !== offer.id || p.offerHash !== offer.checksum || p.sessionId !== offer.payload.sessionId || p.expiresAt !== offer.payload.expiresAt) fail();
      fresh(offer);
      return await this.#bind(await this.#node!.accept(), 'offerer');
    } catch { await this.close(); throw new StreamFailure('protocol'); }
  }
  /** Acceptor: only call after explicitly publishing acceptance. Never follows arbitrary URLs. */
  async connect(): Promise<FramedStream> {
    this.#begin('accepted');
    try {
      fresh(this.#offer!); fresh(this.#acceptance!);
      return await this.#bind(await this.#node!.connect(this.#offer!.payload.address as string), 'acceptor');
    } catch { await this.close(); throw new StreamFailure('protocol'); }
  }
  async #bind(stream: FramedStream, role: 'offerer' | 'acceptor'): Promise<FramedStream> {
    const transcript = await sha256Hex(canonicalizeJson({ offer: this.#offer, acceptance: this.#acceptance }));
    const nonce = randomBytes(32).toString('hex'), other = role === 'offerer' ? 'acceptor' : 'offerer';
    const send = (kind: string, challenge: string) => stream.send(Buffer.from(JSON.stringify({ kind, role, transcript, nonce: challenge })));
    const receive = async (kind: string) => {
      const bytes = await stream.receive();
      if (!bytes || bytes.byteLength > 512) return fail();
      let message;
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail(); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail();
      keys(message, ['kind', 'role', 'transcript', 'nonce']);
      if (message.kind !== kind || message.role !== other || message.transcript !== transcript || !hex(message.nonce, 64)) fail();
      return message.nonce as string;
    };
    await send('oaf.stream.hello.v1', nonce);
    const challenge = await receive('oaf.stream.hello.v1');
    if (challenge === nonce) fail();
    await send('oaf.stream.confirm.v1', challenge);
    if (await receive('oaf.stream.confirm.v1') !== nonce) fail();
    fresh(this.#offer!); fresh(this.#acceptance!);
    this.#checkOpen();
    this.#state = 'bound'; return stream;
  }
  async close(): Promise<void> { this.#state = 'closed'; await this.#node?.stop(); }
}
