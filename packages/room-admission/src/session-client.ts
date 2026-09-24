/** Source-only Node client. No invitation acceptance, listener, polling loop or cipher persistence. */
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { RoomHttpClient, RoomHttpError } from './http-client.js';
import { createRoomNoiseSession, ROOM_NOISE_LIMITS, type RoomNoiseSession } from './handshake.js';
import { verifyRoomKeyBindings, type RoomKeyBundle, type RoomKeyPins, type RoomKeyBinding } from './key-bindings.js';
import { ROOM_PACKET_PROTOCOL, ROOM_PACKET_PROFILE, ROOM_PACKET_READ_PROTOCOL, ROOM_PACKET_RECOVERY_PROTOCOL,
  signRoomPacket, signRoomPacketRead, signRoomPacketRecovery, verifyHistoricalRoomPacketSignature,
  type RoomPacketWrite } from './packet-wire.js';
import type { RoomPacketReceipt } from './packet-storage-contract.js';

/** Trusted local adapter: durably retain exact ciphertext/proofs BEFORE any POST.
 * Store outside the checkout with restricted access and finite capacity. Neither
 * callback receives plaintext or private keys. A resolved promise means durable;
 * throws/uncertain local writes stop the session. This is not a supplied keystore. */
export interface RoomSessionJournal {
  retain(wire: string): Promise<void>;
  confirm(wire: string, receipt: Readonly<RoomPacketReceipt>): Promise<void>;
}
export interface RoomSessionClientOptions {
  role: 'owner' | 'peer';
  bundle: RoomKeyBundle;
  pins: RoomKeyPins;
  /** Fresh initiator-chosen ID, privately handed to and explicitly selected by the peer. */
  sessionId: string;
  signingPrivateKey: string;
  encryptionPrivateKey: string;
  http: RoomHttpClient;
  journal: RoomSessionJournal;
  now?: () => number;
  operationTimeoutMs?: number;
}
export interface UntrustedRoomMessage {
  readonly kind: 'untrusted-room-data';
  readonly roomId: string;
  readonly sessionId: string;
  readonly senderSigningPublicKey: string;
  readonly requestId: string;
  readonly bytes: Uint8Array;
}
type PollResult = { kind: 'idle' | 'progress' | 'outgoing' } | UntrustedRoomMessage;
type Code = 'room_session_invalid' | 'room_session_closed' | 'room_session_busy'
  | 'room_session_pending' | 'room_session_needs_recovery' | 'room_session_unavailable';
export class RoomSessionClientError extends Error {
  constructor(readonly code: Code) { super(`Room session: ${code}`); }
  readonly permitsReplacementMutation = false;
}
const id = () => randomBytes(16).toString('hex');
function fail(): never { throw new RoomSessionClientError('room_session_invalid'); }
type Pending = { wire: string; request: Readonly<RoomPacketWrite>; digest: string };

/** One selected, already accepted room/session. Historical bindings never authorize
 * HTTP access: every operation still uses fresh signed primary membership checks. */
export class RoomSessionClient {
  readonly #role: 'owner' | 'peer';
  readonly #binding: Readonly<RoomKeyBinding>;
  readonly #sessionId: string;
  readonly #http: RoomHttpClient;
  readonly #journal: RoomSessionJournal;
  readonly #noise: RoomNoiseSession;
  readonly #now: () => number;
  readonly #started: number;
  readonly #timeout: number;
  #highWater: number;
  #privateKey: string;
  #busy = false;
  #closed = false;
  #cursor = 0;
  #sendIndex = 0;
  #receiveIndex = 0;
  #pending: Pending | null = null;
  #delivery: { message: UntrustedRoomMessage; storedSeq: number } | null = null;
  // Bounded by two parties * (2 handshake + 1,024 data records); no other sessions retained.
  readonly #seen = new Set<string>();
  readonly #own = new Map<number, { digest: string; storedSeq?: number }>();

  private constructor(options: RoomSessionClientOptions, binding: Readonly<RoomKeyBinding>, noise: RoomNoiseSession) {
    this.#role = options.role; this.#binding = binding; this.#sessionId = options.sessionId;
    this.#privateKey = options.signingPrivateKey; this.#http = options.http;
    // Capture trusted callbacks so later mutation of the options object cannot switch storage.
    this.#journal = { retain: options.journal.retain.bind(options.journal), confirm: options.journal.confirm.bind(options.journal) };
    this.#noise = noise; this.#now = options.now ?? Date.now;
    this.#timeout = options.operationTimeoutMs ?? 20_000;
    this.#started = this.#highWater = this.#time();
  }

  static async create(options: RoomSessionClientOptions): Promise<RoomSessionClient> {
    let noise: RoomNoiseSession | undefined;
    try {
      if (!options || !['owner', 'peer'].includes(options.role) || typeof options.sessionId !== 'string'
        || !/^[0-9a-f]{32}$/.test(options.sessionId) || !(options.http instanceof RoomHttpClient)
        || typeof options.journal?.retain !== 'function' || typeof options.journal?.confirm !== 'function'
        || (options.now !== undefined && typeof options.now !== 'function')
        || (options.operationTimeoutMs !== undefined && (!Number.isSafeInteger(options.operationTimeoutMs)
          || options.operationTimeoutMs < 1 || options.operationTimeoutMs > 20_000))) fail();
      const snapshot = { ...options, pins: { ...options.pins }, bundle: { ...options.bundle },
        journal: { retain: options.journal.retain.bind(options.journal), confirm: options.journal.confirm.bind(options.journal) } };
      const binding = await verifyRoomKeyBindings(snapshot.bundle, snapshot.pins);
      if (typeof snapshot.signingPrivateKey !== 'string' || !/^(?:[0-9a-f]{2}){1,256}$/.test(snapshot.signingPrivateKey)) fail();
      const der = Buffer.from(snapshot.signingPrivateKey, 'hex');
      try {
        const key = createPrivateKey({ key: der, type: 'pkcs8', format: 'der' });
        const local = snapshot.role === 'owner' ? binding.owner : binding.peer;
        if (key.asymmetricKeyType !== 'ed25519'
          || Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url').toString('hex') !== local.signingPublicKey) fail();
      } finally { der.fill(0); }
      noise = await createRoomNoiseSession({ ...snapshot, now: snapshot.now ?? Date.now });
      return new RoomSessionClient(snapshot, binding, noise);
    } catch { noise?.close(); throw new RoomSessionClientError('room_session_invalid'); }
  }

  get ready(): boolean { return !this.#closed && this.#noise.phase === 'ready' && !this.#pending; }
  get closed(): boolean { return this.#closed; }
  /** For protected recovery only; never print this wire or put it in public logs. */
  get pendingWire(): string | null { return this.#pending?.wire ?? null; }
  get processedStoredSeq(): number { return this.#cursor; }
  #local() { return this.#role === 'owner' ? this.#binding.owner : this.#binding.peer; }
  #remote() { return this.#role === 'owner' ? this.#binding.peer : this.#binding.owner; }
  #time(): number {
    let now: number;
    try { now = this.#now(); } catch { return fail(); }
    if (!Number.isSafeInteger(now) || now < 0 || Object.is(now, -0)
      || now > Number.MAX_SAFE_INTEGER - ROOM_NOISE_LIMITS.sessionLifetimeMs) fail();
    return this.#highWater = Math.max(now, this.#highWater ?? now);
  }
  #check(): void {
    if (this.#closed) throw new RoomSessionClientError('room_session_closed');
    const limit = this.#noise.phase === 'ready' ? ROOM_NOISE_LIMITS.sessionLifetimeMs : ROOM_NOISE_LIMITS.handshakeLifetimeMs;
    if (this.#time() - this.#started >= limit) { this.dispose(); throw new RoomSessionClientError('room_session_closed'); }
  }
  #common() {
    const issuedAt = this.#time(); const local = this.#local();
    return { hub: this.#binding.hub, roomId: this.#binding.roomId, actor: local.agentId,
      signingPublicKey: local.signingPublicKey, issuedAt, expiresAt: issuedAt + 60_000 };
  }
  async #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new RoomSessionClientError('room_session_busy');
    this.#busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.#check();
      const limit = this.#noise.phase === 'ready' ? ROOM_NOISE_LIMITS.sessionLifetimeMs : ROOM_NOISE_LIMITS.handshakeLifetimeMs;
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        this.dispose(); reject(new RoomSessionClientError('room_session_closed'));
      }, this.#timeout); });
      const result = await Promise.race([operation(), deadline]); this.#check();
      if (this.#time() - this.#started >= limit) throw new RoomSessionClientError('room_session_closed');
      return result;
    }
    catch (error) {
      // One-attempt HTTP failures preserve the exact pending wire/cipher position.
      if (error instanceof RoomHttpError || (error instanceof RoomSessionClientError
        && ['room_session_pending', 'room_session_needs_recovery'].includes(error.code))) throw error;
      this.dispose();
      if (error instanceof RoomSessionClientError) throw error;
      throw new RoomSessionClientError('room_session_invalid');
    } finally { clearTimeout(timer); this.#busy = false; }
  }
  #empty(): void {
    if (this.#pending || this.#delivery) throw new RoomSessionClientError('room_session_pending');
  }
  async #prepare(bytes: Buffer, kind: RoomPacketWrite['kind']): Promise<void> {
    try {
      const wire = await signRoomPacket({ ...this.#common(), protocol: ROOM_PACKET_PROTOCOL,
        requestId: id(), expectedRevision: this.#binding.acceptedRevision, profile: ROOM_PACKET_PROFILE,
        sessionId: this.#sessionId, packetIndex: this.#sendIndex, kind, packetHex: bytes.toString('hex') }, this.#privateKey);
      this.#check();
      const verified = await verifyHistoricalRoomPacketSignature(wire, this.#binding.hub);
      if (!verified.ok) fail();
      this.#check();
      this.#pending = { wire, request: verified.request, digest: verified.proofDigest };
      // No POST can occur before this durable promise completes. A failure leaves
      // the pending proof inspectable and closes the cipher; never replace it.
      try { await this.#journal.retain(wire); } catch { fail(); }
      this.#check();
      this.#own.set(this.#sendIndex++, { digest: verified.proofDigest });
    } finally { bytes.fill(0); }
  }
  /** Prepare and journal the first flight. Does not send it. Peer never calls start. */
  start(): Promise<void> {
    return this.#run(async () => { this.#empty(); if (this.#role !== 'owner' || this.#sendIndex !== 0) fail();
      await this.#prepare(this.#noise.start(), 'handshake'); });
  }
  /** Encrypt ONCE and retain the exact write. Explicit flush sends it later. */
  prepareData(value: Uint8Array): Promise<void> {
    return this.#run(async () => { this.#empty(); await this.#prepare(this.#noise.seal(value), 'data'); });
  }
  async #confirmed(receipt: Readonly<RoomPacketReceipt>): Promise<void> {
    const pending = this.#pending!;
    if (receipt.sessionId !== this.#sessionId || receipt.packetIndex !== pending.request.packetIndex
      || receipt.revision !== this.#binding.acceptedRevision) fail();
    try { await this.#journal.confirm(pending.wire, Object.freeze({ ...receipt })); } catch { fail(); }
    this.#check();
    this.#own.set(pending.request.packetIndex, { digest: pending.digest, storedSeq: receipt.storedSeq });
    this.#pending = null;
  }
  /** Exactly one POST. An error retains pending; calling flush again is an explicit exact retry. */
  flush(): Promise<Readonly<RoomPacketReceipt>> {
    return this.#run(async () => {
      if (!this.#pending) fail();
      if (this.#time() >= this.#pending.request.expiresAt) throw new RoomSessionClientError('room_session_needs_recovery');
      const { receipt } = await this.#http.writePacket(this.#pending.wire); this.#check();
      await this.#confirmed(receipt); return Object.freeze({ ...receipt });
    });
  }
  /** Historical storage acknowledgment only: null keeps the unresolved write pending. */
  recoverPending(): Promise<Readonly<RoomPacketReceipt> | null> {
    return this.#run(async () => {
      if (!this.#pending) fail();
      const wire = await signRoomPacketRecovery({ ...this.#common(), protocol: ROOM_PACKET_RECOVERY_PROTOCOL,
        queryId: id(), requestId: this.#pending.request.requestId, proofDigest: this.#pending.digest }, this.#privateKey);
      this.#check(); const { receipt } = await this.#http.recoverPacket(wire); this.#check();
      if (receipt) await this.#confirmed(receipt);
      return receipt ? Object.freeze({ ...receipt }) : null;
    });
  }
  #message(): UntrustedRoomMessage {
    const m = this.#delivery!.message;
    return Object.freeze({ ...m, bytes: Uint8Array.from(m.bytes) });
  }
  /** One bounded signed read POST, never a packet/control write or polling loop.
   * May journal a reply for explicit flush. Delivers at most one untrusted record. */
  poll(): Promise<PollResult> {
    return this.#run(async () => {
      if (this.#delivery) return this.#message();
      if (this.#pending) throw new RoomSessionClientError('room_session_pending');
      const wire = await signRoomPacketRead({ ...this.#common(), protocol: ROOM_PACKET_READ_PROTOCOL,
        queryId: id(), expectedRevision: this.#binding.acceptedRevision, afterStoredSeq: this.#cursor, limit: 8 }, this.#privateKey);
      this.#check(); const { page } = await this.#http.readPackets(wire); this.#check();
      if (!page) throw new RoomSessionClientError('room_session_unavailable');
      for (const row of page.records) {
        const verified = await verifyHistoricalRoomPacketSignature(row.wire, this.#binding.hub); this.#check();
        if (!verified.ok) fail();
        const p = verified.request;
        if (p.signingPublicKey !== this.#local().signingPublicKey && p.signingPublicKey !== this.#remote().signingPublicKey) fail();
        // No automatic joining or switching to another session. Each call scans <=8.
        if (p.sessionId !== this.#sessionId) { this.#cursor = row.storedSeq; continue; }
        const recordId = `${p.signingPublicKey}:${p.requestId}`;
        // A processed proof reappearing above our cursor is relay substitution, not a new frame.
        if (this.#seen.has(recordId)) fail();
        if (p.signingPublicKey === this.#local().signingPublicKey) {
          const own = this.#own.get(p.packetIndex);
          if (!own || own.digest !== verified.proofDigest || own.storedSeq !== row.storedSeq) fail();
          this.#seen.add(recordId);
          this.#cursor = row.storedSeq; continue; // never feed our own ciphertext to rx
        }
        const expectedKind = this.#receiveIndex === 0 ? 'handshake' : this.#receiveIndex === 1 ? 'confirmation' : 'data';
        if (p.packetIndex !== this.#receiveIndex || p.kind !== expectedKind) fail();
        const bytes = Buffer.from(p.packetHex, 'hex');
        try {
          if (p.kind === 'data') {
            const plaintext = this.#noise.open(bytes);
            this.#delivery = { storedSeq: row.storedSeq, message: Object.freeze({ kind: 'untrusted-room-data',
              roomId: this.#binding.roomId, sessionId: this.#sessionId, senderSigningPublicKey: p.signingPublicKey,
              requestId: p.requestId, bytes: plaintext }) };
          } else {
            const reply = this.#noise.receiveHandshake(bytes);
            if (reply) await this.#prepare(reply, this.#sendIndex === 0 ? 'handshake' : 'confirmation');
          }
        } finally { bytes.fill(0); }
        this.#receiveIndex++; this.#seen.add(recordId);
        if (this.#delivery) return this.#message(); // cursor waits for explicit application acknowledgment
        this.#cursor = row.storedSeq;
        if (this.#pending) return { kind: 'outgoing' };
      }
      return { kind: page.records.length ? 'progress' : 'idle' };
    });
  }
  /** Acknowledge only after local processing succeeds; no remote side effect is implied. */
  acknowledge(requestId: string): void {
    if (this.#busy) throw new RoomSessionClientError('room_session_busy');
    try { this.#check(); } catch (error) { this.dispose(); throw error; }
    if (!this.#delivery || this.#delivery.message.requestId !== requestId) throw new RoomSessionClientError('room_session_invalid');
    this.#cursor = this.#delivery.storedSeq; this.#delivery.message.bytes.fill(0); this.#delivery = null;
  }
  /** Discard local ciphers, NOT a room close or rollback. Pending proofs remain in the journal. */
  dispose(): void {
    this.#closed = true; this.#noise.close(); this.#privateKey = '';
    this.#delivery?.message.bytes.fill(0); this.#delivery = null; this.#own.clear(); this.#seen.clear();
  }
}
