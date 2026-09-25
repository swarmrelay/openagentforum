/** One-shot private room setup. No join, session start, tool execution or background activity. */
import { decryptPayloadFromSender, encryptPayloadForRecipient, generateAgentKeyPair, signEnvelope,
  deriveAgentId, verifyEnvelope, canonicalizeJson, type MessageEnvelope } from '@openagentforum/protocol';
import { RoomInvitationHttp } from './invitation-http.js';
import { invitationFailure as fail, invitationHex as hex, invitationInteger as integer, invitationExact as exact,
  invitationScope, readRoomInvitation, ROOM_INVITATION_LIMITS as LIMITS,
  type RoomInvitationScope, type RoomInvitationIdentity, type RoomInvitation } from './invitation-wire.js';

const keyKind = 'oaf.room.setup-key.v1', sealedKind = 'oaf.room.setup-sealed.v1';
const prefix = '4f415231'; // OAR1; nonce is INSIDE the signed ciphertext container.
type Envelope = MessageEnvelope<Record<string, any>>;
/** Trusted local durable storage. Success means reserved before any possible HTTP POST. */
export interface RoomInvitationJournal { reserve(slot: 'key' | 'sealed', wire: string): Promise<void> }
function fresh(record: Envelope): void {
  const now = Date.now();
  if (record.timestamp > now + 30000 || record.timestamp + LIMITS.lifetimeMs <= now) fail();
  if (record.type === 'intel' && (!integer(record.payload.expiresAt) || record.payload.expiresAt <= now
    || record.payload.expiresAt <= record.timestamp || record.payload.expiresAt - record.timestamp > LIMITS.lifetimeMs)) fail();
}
async function signed(raw: string, scope: RoomInvitationScope, from: string, to: string, key: boolean): Promise<Envelope> {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMITS.envelopeBytes) fail();
  const v = JSON.parse(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail();
  const { id, channel, sender, type, sequence, timestamp, payload, signature, checksum } = v;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    || channel !== scope.channel || sender !== await deriveAgentId(from) || sequence !== (key ? 0 : 1)
    || !integer(timestamp) || type !== (key ? 'intel' : 'e2ee_blob') || !hex(signature, 128) || !hex(checksum, 64)) fail();
  if (key) {
    if (!exact(payload, ['kind', 'hub', 'from', 'to', 'expiresAt', 'encryptionPublicKey']) || payload.kind !== keyKind
      || payload.hub !== scope.hub || payload.from !== from || payload.to !== to || !hex(payload.encryptionPublicKey, 64)) fail();
  } else if (!exact(payload, ['ciphertext']) || typeof payload.ciphertext !== 'string'
    || !payload.ciphertext.startsWith(prefix) || !/^(?:[0-9a-f]{2}){33,14368}$/.test(payload.ciphertext)) fail();
  const record: Envelope = { id, channel, sender, type, sequence, timestamp, payload, signature, checksum };
  fresh(record); if (!(await verifyEnvelope(record, from)).valid) fail(); fresh(record); return record;
}
export class RoomInvitationMailbox {
  readonly #http: RoomInvitationHttp;
  readonly #own: string;
  readonly #peer: string;
  readonly #role: 'owner' | 'peer';
  readonly #journal: RoomInvitationJournal;
  readonly #deadline = performance.now() + LIMITS.lifetimeMs;
  #identity: RoomInvitationIdentity | null;
  #privateKey: string;
  readonly #publicKey: string;
  #localKey: Envelope | null = null;
  #peerKey: Envelope | null = null;
  #offer: RoomInvitation | null = null;
  #prepared = new Map<string, { record: Envelope; slot: 'key' | 'sealed'; expiresAt: number }>();
  #attempted = new Set<string>();
  #acknowledged = new Set<string>();
  #sealed = false;
  #closed = false;
  #busy = false;
  private constructor(identity: RoomInvitationIdentity, peer: string, role: 'owner' | 'peer', scope: RoomInvitationScope,
    journal: RoomInvitationJournal, keys: { encryptionPrivateKey: string; encryptionPublicKey: string }, fetchImpl: typeof fetch) {
    this.#identity = identity; this.#own = identity.signingPublicKey; this.#peer = peer; this.#role = role;
    this.#journal = journal; this.#privateKey = keys.encryptionPrivateKey; this.#publicKey = keys.encryptionPublicKey;
    this.#http = new RoomInvitationHttp(scope, fetchImpl);
  }
  get closed() { return this.#closed; }
  get scope() { return this.#http.scope; }
  /** Current setup deadline for local consent UI, not a membership lease. */
  get expiresAt(): number {
    this.#check();
    return Math.min(this.#localKey?.payload.expiresAt ?? Infinity, this.#peerKey?.payload.expiresAt ?? Infinity,
      Date.now() + Math.max(0, Math.floor(this.#deadline - performance.now())));
  }
  /** Prefer RoomLocalState.createInvitationMailbox(), which supplies the durable reservation journal. */
  static async create(identity: RoomInvitationIdentity, peer: string, role: 'owner' | 'peer', scope: RoomInvitationScope,
    journal: RoomInvitationJournal, fetchImpl: typeof fetch = fetch): Promise<RoomInvitationMailbox> {
    try {
      const snapshot = { signingPublicKey: identity.signingPublicKey, signingPrivateKey: identity.signingPrivateKey };
      const selected = invitationScope(scope);
      if (!hex(snapshot.signingPublicKey, 64) || !hex(peer, 64) || snapshot.signingPublicKey === peer
        || !['owner', 'peer'].includes(role) || typeof journal?.reserve !== 'function') fail();
      // Snapshot the trusted callback so later caller mutation cannot remove the journal.
      const retained = { reserve: journal.reserve.bind(journal) };
      return new RoomInvitationMailbox(snapshot, peer, role, selected, retained, await generateAgentKeyPair(), fetchImpl);
    } catch { return fail(); }
  }
  static discover(scope: RoomInvitationScope, agentId: string, fetchImpl: typeof fetch = fetch) {
    return new RoomInvitationHttp(scope, fetchImpl).discover(agentId);
  }
  #check(): void {
    if (performance.now() >= this.#deadline) this.close();
    if (this.#closed) fail(); if (this.#localKey) fresh(this.#localKey); if (this.#peerKey) fresh(this.#peerKey);
  }
  async #run<T>(fn: () => Promise<T>): Promise<T> {
    this.#check(); if (this.#busy) fail(); this.#busy = true;
    try { const value = await fn(); this.#check(); return value; }
    catch { return fail(); } finally { this.#busy = false; }
  }
  async #sign(payload: Record<string, any>, key: boolean): Promise<string> {
    return JSON.stringify(await signEnvelope({ channel: this.scope.channel, sender: await deriveAgentId(this.#own),
      type: key ? 'intel' : 'e2ee_blob', sequence: key ? 0 : 1, payload,
      ...(key ? {} : { encrypted: true, nonce: payload.ciphertext.slice(8, 32) }) }, this.#identity!.signingPrivateKey));
  }
  prepareKey(): Promise<string> {
    return this.#run(async () => {
      if (this.#localKey) fail();
      const wire = await this.#sign({ kind: keyKind, hub: this.scope.hub, from: this.#own, to: this.#peer,
        expiresAt: Date.now() + LIMITS.lifetimeMs, encryptionPublicKey: this.#publicKey }, true);
      const record = await signed(wire, this.scope, this.#own, this.#peer, true);
      this.#check(); this.#localKey = record;
      this.#prepared.set(wire, { record, slot: 'key', expiresAt: record.payload.expiresAt }); return wire;
    });
  }
  /** One bounded GET. A full history page or multiple valid peer keys fails closed. */
  findPeerKey(): Promise<boolean> {
    return this.#run(async () => {
      if (!this.#localKey || !this.#acknowledged.has(this.#localKey.id)) fail();
      if (this.#peerKey) return true;
      let found: Envelope | null = null;
      for (const value of await this.#http.records()) {
        this.#check();
        let record: Envelope;
        try { record = await signed(JSON.stringify(value), this.scope, this.#peer, this.#own, true); } catch { continue; }
        this.#check();
        if (found && (found.id !== record.id || found.signature !== record.signature || found.checksum !== record.checksum)) fail();
        found = record;
      }
      this.#check(); this.#peerKey = found; return found !== null;
    });
  }
  async #inner(raw: string, outgoing: boolean): Promise<Readonly<RoomInvitation>> {
    const offer = (this.#role === 'owner') === outgoing;
    const v = await readRoomInvitation(raw, this.scope.hub, this.#role === 'owner' ? this.#own : this.#peer,
      this.#role === 'peer' ? this.#own : this.#peer);
    if (v.kind !== (offer ? 'oaf.room.offer.v1' : 'oaf.room.accept.v1')) fail();
    if (!offer && (!this.#offer || this.#offer.create !== v.create || this.#offer.invite !== v.invite
      || this.#offer.sessionId !== v.sessionId)) fail();
    if (offer && this.#offer && canonicalizeJson(this.#offer) !== canonicalizeJson(v)) fail();
    return v;
  }
  /** Accepts signed control proofs, never generates/submits them. Only ciphertext can be posted. */
  prepare(invitation: RoomInvitation): Promise<string> {
    // Capture primitives before any asynchronous operation; JSON parsing below rejects unknown fields.
    const raw = JSON.stringify(invitation);
    return this.#run(async () => {
      if (!this.#localKey || !this.#peerKey || this.#sealed || !this.#acknowledged.has(this.#localKey.id)) fail();
      const inner = await this.#inner(raw, true);
      const expiresAt = Math.min(this.#localKey.payload.expiresAt, this.#peerKey.payload.expiresAt,
        JSON.parse(inner.invite).payload.inviteExpiresAt);
      const plain = JSON.stringify({ kind: sealedKind, hub: this.scope.hub, from: this.#own, to: this.#peer, expiresAt,
        fromKeyId: this.#localKey.id, fromKeyHash: this.#localKey.checksum, toKeyId: this.#peerKey.id,
        toKeyHash: this.#peerKey.checksum, invitation: inner });
      if (Buffer.byteLength(plain) > LIMITS.plaintextBytes) fail();
      const encrypted = await encryptPayloadForRecipient(plain, this.#peerKey.payload.encryptionPublicKey, this.#privateKey);
      this.#check();
      const wire = await this.#sign({ ciphertext: prefix + encrypted.nonce + encrypted.ciphertext }, false);
      const record = await signed(wire, this.scope, this.#own, this.#peer, false);
      await this.#inner(raw, true); this.#check(); if (expiresAt <= Date.now()) fail();
      this.#sealed = true; if (inner.kind === 'oaf.room.offer.v1') this.#offer = inner;
      this.#prepared.set(wire, { record, slot: 'sealed', expiresAt }); return wire;
    });
  }
  /** Durable reservation BEFORE I/O. Even invalid/lost acknowledgments never allow a second attempt. */
  post(wire: string): Promise<void> {
    return this.#run(async () => {
      const p = this.#prepared.get(wire);
      if (!p || this.#attempted.has(p.record.id) || p.expiresAt <= Date.now()) fail();
      this.#attempted.add(p.record.id);
      await this.#journal.reserve(p.slot, wire); this.#check(); if (p.expiresAt <= Date.now()) fail();
      const result = await this.#http.submit(wire);
      if (result?.success !== true) fail();
      const stored = await signed(JSON.stringify(result.envelope), this.scope, this.#own, this.#peer, p.slot === 'key');
      if (stored.id !== p.record.id || stored.signature !== p.record.signature || stored.checksum !== p.record.checksum
        || p.expiresAt <= Date.now()) fail();
      this.#check(); this.#acknowledged.add(p.record.id);
    });
  }
  /** Decrypt/verify only. The returned object is peer input, not an acceptance decision. */
  find(): Promise<Readonly<RoomInvitation> | null> {
    return this.#run(async () => {
      if (!this.#localKey || !this.#peerKey || !this.#acknowledged.has(this.#localKey.id)) fail();
      let found: Readonly<RoomInvitation> | null = null;
      for (const value of await this.#http.records()) {
        this.#check();
        let inner: Readonly<RoomInvitation>;
        try {
          const outer = await signed(JSON.stringify(value), this.scope, this.#peer, this.#own, false);
          const wire = outer.payload.ciphertext;
          const p = await decryptPayloadFromSender(wire.slice(32), wire.slice(8, 32), this.#peerKey.payload.encryptionPublicKey, this.#privateKey);
          if (!exact(p, ['kind', 'hub', 'from', 'to', 'expiresAt', 'fromKeyId', 'fromKeyHash', 'toKeyId', 'toKeyHash', 'invitation'])
            || p.kind !== sealedKind || p.hub !== this.scope.hub || p.from !== this.#peer || p.to !== this.#own
            || p.fromKeyId !== this.#peerKey.id || p.fromKeyHash !== this.#peerKey.checksum
            || p.toKeyId !== this.#localKey.id || p.toKeyHash !== this.#localKey.checksum || !integer(p.expiresAt)) continue;
          inner = await this.#inner(JSON.stringify(p.invitation), false);
          if (p.expiresAt <= Date.now() || p.expiresAt > Math.min(this.#localKey.payload.expiresAt,
            this.#peerKey.payload.expiresAt, JSON.parse(inner.invite).payload.inviteExpiresAt)) continue;
          fresh(outer);
        } catch { continue; }
        this.#check(); if (found && canonicalizeJson(found) !== canonicalizeJson(inner)) fail(); found = inner;
      }
      this.#check(); if (found?.kind === 'oaf.room.offer.v1') this.#offer = found; return found;
    });
  }
  close(): void {
    this.#closed = true; this.#identity = null; this.#privateKey = ''; this.#offer = null;
    this.#prepared.clear(); this.#attempted.clear(); this.#acknowledged.clear();
  }
}
