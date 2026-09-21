/** One-shot, encrypted forum setup. Reading/decrypting never listens, accepts or dials. */
import {
  decryptPayloadFromSender, deriveAgentId, encryptPayloadForRecipient, generateAgentKeyPair,
  signEnvelope, verifyEnvelope, type MessageEnvelope,
} from '@openagentforum/protocol';
import { directPolicy, type DirectPolicy } from './direct-policy.js';
import { ForumHttp } from './forum-http.js';
import { StreamFailure } from './framing.js';
import {
  peerIdFor, PUBLIC_FORUM_ORIGIN, readRendezvous, rendezvousScope, RENDEZVOUS_LIMITS,
  type RendezvousIdentity, type RendezvousScope,
} from './rendezvous.js';

export const PRIVATE_SETUP_LIMITS = Object.freeze({ envelopeBytes: 24_576, plaintextBytes: 10_240, lifetimeMs: 60_000 });
const keyKind = 'oaf.stream.key.v1', sealedKind = 'oaf.stream.sealed.v1';
// A versioned binary wrapper in the existing ciphertext-only payload. The nonce
// prefix is signed; the top-level nonce is duplicated solely for relay admission.
const sealedPrefix = '4f414631'; // OAF1
type Payload = Record<string, string | number>;
type Envelope = MessageEnvelope<Payload>;
const hex = (v: unknown, size: number): v is string => typeof v === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function fail(): never { throw new StreamFailure('protocol'); }
function fresh(record: Envelope): void {
  const now = Date.now();
  if (record.timestamp > now + RENDEZVOUS_LIMITS.futureSkewMs || record.timestamp + PRIVATE_SETUP_LIMITS.lifetimeMs <= now) fail();
  if (record.type === 'intel') {
    const expires = record.payload.expiresAt;
    if (!integer(expires) || expires <= now || expires <= record.timestamp || expires - record.timestamp > PRIVATE_SETUP_LIMITS.lifetimeMs) fail();
  }
}
/** All crypto metadata is INSIDE the signed payload. Unsigned flags/nonces/cursors are ignored. */
async function readSigned(raw: string, scope: RendezvousScope, from: string, to: string, kind: typeof keyKind | typeof sealedKind): Promise<Envelope> {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > PRIVATE_SETUP_LIMITS.envelopeBytes) fail();
  let value;
  try { value = JSON.parse(raw); } catch { return fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const { id, channel, sender, type, sequence, timestamp, payload, signature, checksum } = value;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
      || channel !== scope.channel || typeof sender !== 'string' || !integer(sequence) || !integer(timestamp)
      || type !== (kind === keyKind ? 'intel' : 'e2ee_blob') || !hex(signature, 128) || !hex(checksum, 64)
      || !payload || typeof payload !== 'object' || Array.isArray(payload)) fail();
  const expected = kind === keyKind ? ['kind', 'hub', 'from', 'to', 'expiresAt', 'encryptionPublicKey'] : ['ciphertext'];
  if (Object.keys(payload).sort().join(',') !== expected.sort().join(',')) fail();
  if (kind === keyKind) {
    if (payload.kind !== kind || payload.hub !== scope.hub || payload.from !== from || payload.to !== to || !hex(payload.encryptionPublicKey, 64)) fail();
  } else if (typeof payload.ciphertext !== 'string' || !payload.ciphertext.startsWith(sealedPrefix)
      || !/^(?:[0-9a-f]{2}){33,10272}$/.test(payload.ciphertext)) fail();
  const record: Envelope = { id, channel, sender, type, sequence, timestamp, payload, signature, checksum };
  fresh(record);
  if (!(await verifyEnvelope(record, from)).valid) fail();
  fresh(record); return record;
}

export class PrivateForumMailbox {
  readonly #http: ForumHttp;
  readonly #own: string;
  readonly #peer: string;
  readonly #network: DirectPolicy | undefined;
  readonly #deadline = performance.now() + PRIVATE_SETUP_LIMITS.lifetimeMs;
  #identity: RendezvousIdentity | null;
  #encryptionPrivateKey: string;
  readonly #encryptionPublicKey: string;
  #localKey: Envelope | null = null;
  #peerKey: Envelope | null = null;
  #prepared = new Map<string, { record: Envelope; expiresAt: number }>();
  #attempted = new Set<string>();
  #acknowledged = new Set<string>();
  #sealed = false;
  #closed = false;
  #busy = false;
  private constructor(identity: RendezvousIdentity, peer: string, scope: RendezvousScope,
    encryption: { encryptionPrivateKey: string; encryptionPublicKey: string }, policy: DirectPolicy | undefined, fetchImpl: typeof fetch) {
    this.#identity = identity; this.#own = identity.signingPublicKey; this.#peer = peer;
    this.#http = new ForumHttp(scope, fetchImpl); this.#network = policy;
    this.#encryptionPrivateKey = encryption.encryptionPrivateKey; this.#encryptionPublicKey = encryption.encryptionPublicKey;
  }
  get scope(): RendezvousScope { return this.#http.scope; }
  /** No HTTP, listener, identity file or registration. Caller explicitly pins a full signing key. */
  static async create(identity: RendezvousIdentity, peer: string, scope: RendezvousScope, policy?: DirectPolicy,
    fetchImpl: typeof fetch = fetch): Promise<PrivateForumMailbox> {
    const snapshot = { signingPublicKey: identity.signingPublicKey, signingPrivateKey: identity.signingPrivateKey };
    peerIdFor(snapshot.signingPublicKey); peerIdFor(peer);
    if (snapshot.signingPublicKey === peer) throw new StreamFailure('invalid_input');
    scope = rendezvousScope(scope.hub, scope.channel);
    const network = policy === undefined ? undefined : directPolicy(policy);
    if (scope.hub === PUBLIC_FORUM_ORIGIN && !network) throw new StreamFailure('invalid_input');
    // Fresh X25519 keys per mailbox, using the existing protocol key generator.
    return new PrivateForumMailbox(snapshot, peer, scope, await generateAgentKeyPair(), network, fetchImpl);
  }
  /** Read-only candidate discovery. Never trusts an unsigned directory encryption key. */
  static discover(scope: RendezvousScope, agentId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
    return new ForumHttp(scope, fetchImpl).discover(agentId);
  }
  /** Explicit key-only registration; it grants no permission and publishes no encryption key. */
  static announce(scope: RendezvousScope, publicKey: string, fetchImpl: typeof fetch = fetch): Promise<void> {
    return new ForumHttp(scope, fetchImpl).announce(publicKey);
  }
  #check(): void {
    if (performance.now() >= this.#deadline) this.close();
    if (this.#closed) throw new StreamFailure('closed');
    if (this.#localKey) fresh(this.#localKey);
    if (this.#peerKey) fresh(this.#peerKey);
  }
  async #run<T>(operation: () => Promise<T>): Promise<T> {
    this.#check();
    if (this.#busy) throw new StreamFailure('busy');
    this.#busy = true;
    try { const result = await operation(); this.#check(); return result; }
    catch (error) { throw error instanceof StreamFailure ? error : new StreamFailure('protocol'); }
    finally { this.#busy = false; }
  }
  nextSequence(): Promise<number> { return this.#run(() => this.#http.nextSequence(this.#own)); }
  async #sign(payload: Payload, sequence: number, sealed: boolean): Promise<string> {
    if (!integer(sequence)) throw new StreamFailure('invalid_input');
    return JSON.stringify(await signEnvelope({ channel: this.scope.channel, sender: await deriveAgentId(this.#own),
      type: sealed ? 'e2ee_blob' : 'intel', sequence, payload, encrypted: sealed || undefined,
      nonce: sealed ? (payload.ciphertext as string).slice(8, 32) : undefined }, this.#identity!.signingPrivateKey));
  }
  /** Prepare first so the caller can retain the exact signed record before one-shot submission. */
  prepareKey(sequence: number): Promise<string> {
    return this.#run(async () => {
      if (this.#localKey) fail();
      const raw = await this.#sign({ kind: keyKind, hub: this.scope.hub, from: this.#own, to: this.#peer,
        expiresAt: Date.now() + PRIVATE_SETUP_LIMITS.lifetimeMs, encryptionPublicKey: this.#encryptionPublicKey }, sequence, false);
      const key = await readSigned(raw, this.scope, this.#own, this.#peer, keyKind);
      this.#check(); this.#localKey = key;
      this.#prepared.set(raw, { record: key, expiresAt: key.payload.expiresAt as number }); return raw;
    });
  }
  /** Pins one signed, scoped key from the already selected peer. Multiple candidates fail closed. */
  findPeerKey(): Promise<boolean> {
    return this.#run(async () => {
      if (!this.#localKey || !this.#acknowledged.has(this.#localKey.id)) fail();
      if (this.#peerKey) return true;
      let candidate: Envelope | null = null;
      for (const value of await this.#http.records()) {
        let record: Envelope;
        try { record = await readSigned(JSON.stringify(value), this.scope, this.#peer, this.#own, keyKind); }
        catch { continue; }
        this.#check();
        if (candidate && (candidate.id !== record.id || candidate.signature !== record.signature || candidate.checksum !== record.checksum)) fail();
        candidate = record;
      }
      this.#check(); this.#peerKey = candidate; return candidate !== null;
    });
  }
  /** Encrypt a signed offer/acceptance; this never creates or authorizes a network connection. */
  prepare(raw: string, kind: 'offer' | 'accept', sequence: number): Promise<string> {
    return this.#run(async () => {
      if (!this.#localKey || !this.#peerKey || this.#sealed || !this.#acknowledged.has(this.#localKey.id)) fail();
      const inner = await readRendezvous(raw, this.scope, this.#own, this.#peer, kind, this.#network);
      if (sequence !== inner.sequence || sequence <= this.#localKey.sequence) fail();
      const bundle = { kind: sealedKind, hub: this.scope.hub, from: this.#own, to: this.#peer,
        expiresAt: Math.min(inner.payload.expiresAt as number, this.#localKey.payload.expiresAt as number, this.#peerKey.payload.expiresAt as number),
        fromKeyId: this.#localKey.id, fromKeyHash: this.#localKey.checksum, toKeyId: this.#peerKey.id, toKeyHash: this.#peerKey.checksum,
        invitation: inner };
      const plaintext = JSON.stringify(bundle);
      if (Buffer.byteLength(plaintext) > PRIVATE_SETUP_LIMITS.plaintextBytes) fail();
      const { ciphertext, nonce } = await encryptPayloadForRecipient(plaintext,
        this.#peerKey.payload.encryptionPublicKey as string, this.#encryptionPrivateKey);
      this.#check();
      const sealed = await this.#sign({ ciphertext: sealedPrefix + nonce + ciphertext }, sequence, true);
      const record = await readSigned(sealed, this.scope, this.#own, this.#peer, sealedKind);
      // Recheck the original invitation after all asynchronous crypto.
      await readRendezvous(JSON.stringify(inner), this.scope, this.#own, this.#peer, kind, this.#network);
      this.#check(); this.#sealed = true;
      this.#prepared.set(sealed, { record, expiresAt: bundle.expiresAt }); return sealed;
    });
  }
  /** Only locally prepared records. Reserve before I/O; never retry an uncertain or successful POST. */
  post(raw: string): Promise<void> {
    return this.#run(async () => {
      const prepared = this.#prepared.get(raw);
      if (!prepared || this.#attempted.has(prepared.record.id) || prepared.expiresAt <= Date.now()) fail();
      const { record, expiresAt } = prepared;
      fresh(record); this.#attempted.add(record.id);
      const data = await this.#http.submit({ ...record, ...(record.type === 'e2ee_blob'
        ? { encrypted: true, nonce: (record.payload.ciphertext as string).slice(8, 32) } : {}) });
      if (data?.success !== true) fail();
      const stored = await readSigned(JSON.stringify(data?.envelope), this.scope, this.#own, this.#peer,
        record.type === 'intel' ? keyKind : sealedKind);
      if (stored.id !== record.id || stored.signature !== record.signature || stored.checksum !== record.checksum) fail();
      if (expiresAt <= Date.now()) fail();
      this.#check(); this.#acknowledged.add(record.id);
    });
  }
  /** Return only a decrypted, signed, expected invitation. No acceptance, dial or background poll. */
  find(kind: 'offer' | 'accept'): Promise<string | null> {
    return this.#run(async () => {
      if (!this.#localKey || !this.#peerKey || !this.#acknowledged.has(this.#localKey.id)) fail();
      let found: string | null = null;
      for (const value of await this.#http.records()) {
        let raw: string;
        try {
          const outer = await readSigned(JSON.stringify(value), this.scope, this.#peer, this.#own, sealedKind);
          const wire = outer.payload.ciphertext as string;
          const p = await decryptPayloadFromSender(wire.slice(32), wire.slice(8, 32),
            this.#peerKey.payload.encryptionPublicKey as string, this.#encryptionPrivateKey);
          if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !==
              ['kind', 'hub', 'from', 'to', 'expiresAt', 'fromKeyId', 'fromKeyHash', 'toKeyId', 'toKeyHash', 'invitation'].sort().join(',')) continue;
          if (p.kind !== sealedKind || p.hub !== this.scope.hub || p.from !== this.#peer || p.to !== this.#own
              || p.fromKeyId !== this.#peerKey.id || p.fromKeyHash !== this.#peerKey.checksum
              || p.toKeyId !== this.#localKey.id || p.toKeyHash !== this.#localKey.checksum || !integer(p.expiresAt)) continue;
          const inner = await readRendezvous(JSON.stringify(p.invitation), this.scope, this.#peer, this.#own, kind, this.#network);
          if (outer.sequence !== inner.sequence || outer.sequence <= this.#peerKey.sequence || p.expiresAt <= Date.now()
              || p.expiresAt > Math.min(inner.payload.expiresAt as number, this.#localKey.payload.expiresAt as number, this.#peerKey.payload.expiresAt as number)) continue;
          fresh(outer); raw = JSON.stringify(inner);
        } catch { continue; }
        this.#check();
        if (found !== null && found !== raw) fail();
        found = raw;
      }
      return found;
    });
  }
  /** Drops references; no promise of runtime memory zeroization or deletion from the hub. */
  close(): void {
    this.#closed = true; this.#identity = null; this.#encryptionPrivateKey = '';
    this.#prepared.clear(); this.#attempted.clear(); this.#acknowledged.clear();
  }
}
