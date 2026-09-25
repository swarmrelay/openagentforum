/** Source-only protected local client state. Not hub authority, a vault, or cipher persistence. */
import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { DatabaseSync as Database } from 'node:sqlite';
import { canonicalizeJson, deriveAgentId } from '@openagentforum/protocol';
import { RoomLocalFiles, localFailure, RoomLocalStateError } from './local-files.js';
import { roomHttpOrigin } from './http-contract.js';
import { RoomHttpClient } from './http-client.js';
import { verifyHistoricalRoomControlSignature } from './control.js';
import { verifyHistoricalRoomPacketSignature, ROOM_PACKET_RECOVERY_PROTOCOL, signRoomPacketRecovery } from './packet-wire.js';
import { ROOM_RECOVERY_PROTOCOL, signRoomRecovery } from './recovery.js';
import { recoveryReceipt } from './storage-contract.js';
import { packetReceipt, type RoomPacketReceipt } from './packet-storage-contract.js';
import type { AdmissionReceipt } from './storage-types.js';
import { verifyRoomKeyBindings, type RoomKeyBundle, type RoomKeyPins } from './key-bindings.js';
import { RoomSessionClient, type RoomSessionJournal } from './session-client.js';
import { RoomInvitationMailbox } from './invitation-mailbox.js';
import { invitationScope, ROOM_INVITATION_LIMITS } from './invitation-wire.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const VERSION = 'oaf-room-client-state-v2';
type Kind = 'control' | 'packet';
export interface RoomLocalPolicy { rooms: number; sessions: number; controls: number; packets: number; packetBytes: number;
  setups: number; setupBytes: number }
export interface RoomLocalScope { hub: string; signingPublicKey: string; policy: RoomLocalPolicy }
type KeyPair = { publicKey: string; privateKey: string };
type Usage = { rooms: number; sessions: number; controls: number; closes: number; packets: number; packet_bytes: number;
  setups: number; setup_bytes: number };
type Row = { kind: Kind; request_id: string; room_id: string; wire: string; digest: string; is_close: number; receipt: string | null };
type Proof = { kind: Kind; wire: string; roomId: string; requestId: string; digest: string; actor: string;
  revision: number; close: boolean; sessionId?: string; packetIndex?: number; action?: string };
const room = (value: unknown): value is string => typeof value === 'string' && /^room_[0-9a-f]{32}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const randomId = () => randomBytes(16).toString('hex');
function policySnapshot(value: RoomLocalPolicy): Readonly<RoomLocalPolicy> {
  const bounds = { rooms: 1000, sessions: 10000, controls: 10000, packets: 65536, packetBytes: 64 * 1024 * 1024,
    setups: 1000, setupBytes: 32 * 1024 * 1024 };
  if (!value || Object.keys(value).length !== 7 || Object.entries(bounds).some(([name, max]) => {
    const v = value[name as keyof RoomLocalPolicy]; return !Number.isSafeInteger(v) || v < 1 || v > max;
  })) localFailure();
  return Object.freeze({ ...value });
}
function publicFor(privateKey: string, curve: 'ed25519' | 'x25519'): string {
  if (typeof privateKey !== 'string' || !/^(?:[0-9a-f]{2}){1,256}$/.test(privateKey)) localFailure();
  const der = Buffer.from(privateKey, 'hex');
  try {
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== curve || !key.export({ format: 'der', type: 'pkcs8' }).equals(der)) localFailure();
    return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url').toString('hex');
  } finally { der.fill(0); }
}
function keyPair(raw: string): Readonly<KeyPair> {
  if (typeof raw !== 'string' || raw.length > 1024) localFailure();
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).length !== 2 || typeof value.publicKey !== 'string'
    || publicFor(value.privateKey, 'x25519') !== value.publicKey || canonicalizeJson(value) !== raw) localFailure();
  return Object.freeze({ publicKey: value.publicKey, privateKey: value.privateKey });
}
const SCHEMA = `
CREATE TABLE client_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), scope TEXT NOT NULL,
 signing_key TEXT NOT NULL, rooms INTEGER NOT NULL, sessions INTEGER NOT NULL, controls INTEGER NOT NULL,
 closes INTEGER NOT NULL, packets INTEGER NOT NULL, packet_bytes INTEGER NOT NULL,
 setups INTEGER NOT NULL, setup_bytes INTEGER NOT NULL) STRICT;
CREATE TABLE client_rooms (room_id TEXT PRIMARY KEY, key_json TEXT NOT NULL, bundle_json TEXT, pins_json TEXT) STRICT;
CREATE TABLE client_sessions (room_id TEXT NOT NULL REFERENCES client_rooms(room_id), session_id TEXT NOT NULL,
 PRIMARY KEY(room_id,session_id)) STRICT;
CREATE TABLE client_ops (kind TEXT NOT NULL CHECK(kind IN ('control','packet')), request_id TEXT NOT NULL,
 room_id TEXT NOT NULL REFERENCES client_rooms(room_id), wire TEXT NOT NULL, digest TEXT NOT NULL,
 is_close INTEGER NOT NULL CHECK(is_close IN (0,1)), receipt TEXT, PRIMARY KEY(kind,request_id)) STRICT;
CREATE INDEX client_pending ON client_ops(receipt,kind);
CREATE INDEX client_closes ON client_ops(room_id,is_close,kind);
CREATE TABLE client_setups (channel TEXT PRIMARY KEY, peer_key TEXT NOT NULL, role TEXT NOT NULL,
 key_wire TEXT, sealed_wire TEXT) STRICT;
PRAGMA user_version=2;`;

export class RoomLocalState {
  readonly #files: RoomLocalFiles;
  readonly #db: Database;
  readonly #scope: string;
  readonly #hub: string;
  readonly #signingPublicKey: string;
  readonly #policy: Readonly<RoomLocalPolicy>;
  #closed = false;
  #busy = false;
  readonly #sessions = new Set<RoomSessionClient>();
  readonly #mailboxes = new Set<RoomInvitationMailbox>();

  private constructor(files: RoomLocalFiles, db: Database, scope: RoomLocalScope) {
    this.#files = files; this.#db = db; this.#hub = scope.hub; this.#signingPublicKey = scope.signingPublicKey;
    this.#policy = policySnapshot(scope.policy);
    this.#scope = canonicalizeJson({ version: VERSION, hub: scope.hub, signingPublicKey: scope.signingPublicKey, policy: this.#policy });
  }
  /** Explicit import of this agent's signing key. Never reads an ambient identity or replaces a database. */
  static initialize(directory: string, options: { hub: string; signingPrivateKey: string; policy: RoomLocalPolicy }): RoomLocalState {
    try {
      return this.#connect(directory, { hub: roomHttpOrigin(options.hub),
        signingPublicKey: publicFor(options.signingPrivateKey, 'ed25519'), policy: policySnapshot(options.policy) }, options.signingPrivateKey);
    } catch { return localFailure(); }
  }
  /** Reopen only with independently supplied expected scope. Missing/partial state is not initialized. */
  static open(directory: string, options: RoomLocalScope): RoomLocalState {
    try { return this.#connect(directory, { hub: roomHttpOrigin(options.hub), signingPublicKey: options.signingPublicKey,
      policy: policySnapshot(options.policy) }); } catch { return localFailure(); }
  }
  static #connect(directory: string, scope: RoomLocalScope, privateKey?: string): RoomLocalState {
    let files: RoomLocalFiles | undefined, db: Database | undefined;
    try {
      if (!/^[0-9a-f]{64}$/.test(scope.signingPublicKey)) localFailure();
      files = new RoomLocalFiles(directory, privateKey !== undefined);
      db = new DatabaseSync(files.path);
      // Exclusive rollback journaling: one live client, OS-released locks after a
      // crash, no lease/lock-file stealing and no additional WAL consumer.
      db.exec('PRAGMA busy_timeout=250; PRAGMA locking_mode=EXCLUSIVE; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') localFailure();
      db.exec('PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA temp_store=MEMORY; PRAGMA journal_size_limit=4194304; PRAGMA max_page_count=65536; BEGIN EXCLUSIVE; COMMIT;');
      if (db.prepare('PRAGMA locking_mode').get()?.locking_mode !== 'exclusive'
        || db.prepare('PRAGMA synchronous').get()?.synchronous !== 3) localFailure();
      const state = new RoomLocalState(files, db, scope);
      if (privateKey !== undefined) {
        db.exec('BEGIN IMMEDIATE');
        db.exec(SCHEMA);
        db.prepare('INSERT INTO client_meta VALUES (1,?,?,0,0,0,0,0,0,0,0)').run(state.#scope, privateKey);
        db.exec('COMMIT'); files.syncDirectory();
      }
      state.#check(); state.#identity();
      // Detect missing schema even in an otherwise valid metadata file.
      for (const table of ['client_rooms', 'client_sessions', 'client_ops', 'client_setups']) db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
      return state;
    } catch {
      try { db?.close(); } catch {} files?.close(); return localFailure();
    }
  }
  #check(): Usage {
    if (this.#closed) localFailure(); this.#files.check();
    if (this.#db.prepare('PRAGMA user_version').get()?.user_version !== 2) localFailure();
    const meta = this.#db.prepare('SELECT scope,rooms,sessions,controls,closes,packets,packet_bytes,setups,setup_bytes FROM client_meta WHERE singleton=1').get();
    const caps = this.#caps();
    if (!meta || meta.scope !== this.#scope || Object.entries(caps).some(([name, cap]) =>
      !Number.isSafeInteger(meta[name]) || Number(meta[name]) < 0 || Number(meta[name]) > cap)) localFailure();
    return meta as unknown as Usage;
  }
  #caps(): Usage { return { rooms: this.#policy.rooms, sessions: this.#policy.sessions, controls: this.#policy.controls,
    closes: this.#policy.rooms * 4, packets: this.#policy.packets, packet_bytes: this.#policy.packetBytes,
    setups: this.#policy.setups, setup_bytes: this.#policy.setupBytes }; }
  #charge(field: keyof Usage, count = 1): void {
    if (this.#db.prepare(`UPDATE client_meta SET ${field}=${field}+? WHERE singleton=1 AND ${field}+?<=?`)
      .run(count, count, this.#caps()[field]).changes !== 1) localFailure();
  }
  #sync<T>(fn: () => T, write = false): T {
    try {
      this.#check(); if (write) this.#db.exec('BEGIN IMMEDIATE');
      const result = fn(); this.#check();
      if (write) { this.#db.exec('COMMIT'); this.#files.syncDirectory(); }
      return result;
    } catch {
      // COMMIT/fsync failure may be durable. Never erase/rebase an uncertain local intent.
      try { if (write) this.#db.exec('ROLLBACK'); } catch {}
      this.close(); return localFailure();
    }
  }
  async #async<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#busy) localFailure(); this.#busy = true;
    try { this.#check(); const result = await fn(); this.#check(); return result; }
    catch (e) { this.close(); if (e instanceof RoomLocalStateError) throw e; return localFailure(); }
    finally { this.#busy = false; }
  }
  #identity(): { signingPublicKey: string; signingPrivateKey: string } {
    const key = this.#db.prepare('SELECT signing_key FROM client_meta WHERE singleton=1').get()?.signing_key;
    if (typeof key !== 'string' || publicFor(key, 'ed25519') !== this.#signingPublicKey) localFailure();
    return Object.freeze({ signingPublicKey: this.#signingPublicKey, signingPrivateKey: key });
  }
  /** Private local material. Never serialize into an invitation, request, error or log. */
  identity() { return this.#sync(() => this.#identity()); }
  /** Public pinned local context; never caller-selected hub authority. */
  scope() { return this.#sync(() => Object.freeze({ hub: this.#hub, signingPublicKey: this.#signingPublicKey })); }
  /** Indexed, bounded pending close lookup; never creates or replaces a request. */
  pendingClose(roomId: string): string | null {
    return this.#sync(() => {
      if (!room(roomId)) localFailure();
      const row = this.#db.prepare("SELECT request_id FROM client_ops WHERE room_id=? AND is_close=1 AND kind='control' AND receipt IS NULL LIMIT 1").get(roomId);
      return row ? String(row.request_id) : null;
    });
  }
  roomKey(roomId: string): Readonly<KeyPair> {
    return this.#sync(() => { if (!room(roomId)) localFailure();
      const row = this.#db.prepare('SELECT key_json FROM client_rooms WHERE room_id=?').get(roomId);
      if (!row || typeof row.key_json !== 'string') localFailure(); return keyPair(row.key_json); });
  }
  createRoomKey(roomId: string): Readonly<KeyPair> {
    return this.#sync(() => {
      if (!room(roomId)) localFailure();
      const existing = this.#db.prepare('SELECT key_json FROM client_rooms WHERE room_id=?').get(roomId);
      if (existing) return keyPair(String(existing.key_json)); // never replace a retained room key
      const keys = generateKeyPairSync('x25519');
      const value = { publicKey: Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex'),
        privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex') };
      this.#charge('rooms'); this.#db.prepare('INSERT INTO client_rooms VALUES (?,?,NULL,NULL)').run(roomId, canonicalizeJson(value));
      return Object.freeze(value);
    }, true);
  }
  saveBindings(bundle: RoomKeyBundle, pins: RoomKeyPins): Promise<void> {
    return this.#async(async () => {
      const b = { ...bundle }, p = { ...pins }; const binding = await verifyRoomKeyBindings(b, p);
      if (binding.hub !== this.#hub) localFailure();
      const member = [binding.owner, binding.peer].find(m => m.signingPublicKey === this.#signingPublicKey);
      if (!member || member.encryptionPublicKey !== this.roomKey(binding.roomId).publicKey) localFailure();
      const bundleJson = canonicalizeJson(b), pinsJson = canonicalizeJson(p);
      this.#sync(() => {
        const old = this.#db.prepare('SELECT bundle_json,pins_json FROM client_rooms WHERE room_id=?').get(binding.roomId)!;
        if (old.bundle_json !== null && (old.bundle_json !== bundleJson || old.pins_json !== pinsJson)) localFailure();
        this.#db.prepare('UPDATE client_rooms SET bundle_json=?,pins_json=? WHERE room_id=?').run(bundleJson, pinsJson, binding.roomId);
      }, true);
    });
  }
  async #proof(kind: Kind, wire: string): Promise<Proof> {
    if (kind === 'control') {
      const v = await verifyHistoricalRoomControlSignature(wire, this.#signingPublicKey, this.#hub);
      if (!v.ok) localFailure(); const a = v.action;
      const key = this.roomKey(a.roomId);
      if ((a.action === 'create' || a.action === 'accept') && a.payload.encryptionPublicKey !== key.publicKey) localFailure();
      return { kind, wire, roomId: a.roomId, requestId: a.requestId, digest: v.proofDigest, actor: a.actor,
        revision: a.expectedRevision + 1, close: a.action === 'close', action: a.action };
    }
    if (kind !== 'packet') localFailure();
    const v = await verifyHistoricalRoomPacketSignature(wire, this.#hub);
    if (!v.ok || v.request.signingPublicKey !== this.#signingPublicKey) localFailure(); const p = v.request;
    return { kind, wire, roomId: p.roomId, requestId: p.requestId, digest: v.proofDigest, actor: p.actor,
      revision: p.expectedRevision, close: false, sessionId: p.sessionId, packetIndex: p.packetIndex };
  }
  #receipt(proof: Proof, value: unknown): AdmissionReceipt | RoomPacketReceipt {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 13
      || Object.values(value).some(v => (typeof v !== 'string' && typeof v !== 'number') || (typeof v === 'string' && v.length > 256))) localFailure();
    const raw = canonicalizeJson(value);
    const q = { hub: this.#hub, roomId: proof.roomId, actor: proof.actor, requestId: proof.requestId, proofDigest: proof.digest,
      signingPublicKey: this.#signingPublicKey };
    const receipt = proof.kind === 'control' ? recoveryReceipt(raw, q) : packetReceipt(raw, q);
    if (!receipt || receipt.revision !== proof.revision) localFailure();
    if (proof.kind === 'control') {
      const r = receipt as AdmissionReceipt;
      if (r.action !== proof.action || r.status !== (proof.close ? 'closed' : 'open')) localFailure();
    } else {
      const r = receipt as RoomPacketReceipt;
      if (r.sessionId !== proof.sessionId || r.packetIndex !== proof.packetIndex) localFailure();
    }
    return receipt;
  }
  #row(kind: Kind, requestId: string): Row | undefined {
    if (!['control', 'packet'].includes(kind) || !id(requestId)) localFailure();
    return this.#db.prepare('SELECT * FROM client_ops WHERE kind=? AND request_id=?').get(kind, requestId) as Row | undefined;
  }
  #retain(proof: Proof): void {
    this.#sync(() => {
      const old = this.#row(proof.kind, proof.requestId);
      if (old) { if (old.wire !== proof.wire || old.digest !== proof.digest || old.room_id !== proof.roomId) localFailure(); return; }
      if (proof.kind === 'packet') {
        this.#charge('packets'); this.#charge('packet_bytes', Buffer.byteLength(proof.wire) + 2048);
      } else if (proof.close) {
        // Separate finite close lane: ordinary control and packet saturation do not consume it.
        const row = this.#db.prepare("SELECT count(*) AS n FROM client_ops WHERE room_id=? AND kind='control' AND is_close=1").get(proof.roomId)!;
        if (Number(row.n) >= 4) localFailure(); this.#charge('closes');
      } else this.#charge('controls');
      this.#db.prepare('INSERT INTO client_ops VALUES (?,?,?,?,?,?,NULL)')
        .run(proof.kind, proof.requestId, proof.roomId, proof.wire, proof.digest, proof.close ? 1 : 0);
    }, true);
  }
  #confirm(proof: Proof, receipt: unknown): void {
    const raw = canonicalizeJson(this.#receipt(proof, receipt));
    this.#sync(() => {
      const old = this.#row(proof.kind, proof.requestId);
      if (!old || old.wire !== proof.wire || old.digest !== proof.digest || (old.receipt !== null && old.receipt !== raw)) localFailure();
      this.#db.prepare('UPDATE client_ops SET receipt=? WHERE kind=? AND request_id=?').run(raw, proof.kind, proof.requestId);
    }, true);
  }
  retainControl(wire: string): Promise<void> { return this.#async(async () => this.#retain(await this.#proof('control', wire))); }
  confirmControl(wire: string, receipt: AdmissionReceipt): Promise<void> {
    return this.#async(async () => this.#confirm(await this.#proof('control', wire), receipt));
  }
  /** No automatic retry. A thrown HTTP outcome leaves the exact retained operation pending. */
  async submitControl(wire: string, http: RoomHttpClient) {
    await this.retainControl(wire);
    this.#check();
    const result = await http.submit(wire, this.#signingPublicKey);
    await this.confirmControl(wire, result.receipt); return result;
  }
  /** Reserve this channel once, even if no post happens. Reopening never resumes old setup keys. */
  createInvitationMailbox(peer: string, role: 'owner' | 'peer', channel: string, fetchImpl: typeof fetch = fetch): Promise<RoomInvitationMailbox> {
    return this.#async(async () => {
      const scope = invitationScope({ hub: this.#hub, channel });
      if (!/^[0-9a-f]{64}$/.test(peer) || peer === this.#signingPublicKey || !['owner', 'peer'].includes(role)) localFailure();
      this.#sync(() => {
        this.#charge('setups');
        this.#db.prepare('INSERT INTO client_setups VALUES (?,?,?,NULL,NULL)').run(channel, peer, role);
      }, true);
      const mailbox = await RoomInvitationMailbox.create(this.#identity(), peer, role, scope, {
        reserve: (slot, wire) => this.#async(async () => {
          if (!['key', 'sealed'].includes(slot) || typeof wire !== 'string' || Buffer.byteLength(wire) > ROOM_INVITATION_LIMITS.envelopeBytes) localFailure();
          this.#sync(() => {
            const row = this.#db.prepare('SELECT * FROM client_setups WHERE channel=?').get(channel);
            if (!row || row.peer_key !== peer || row.role !== role || row[`${slot}_wire`] !== null
              || (slot === 'sealed' && row.key_wire === null)) localFailure();
            this.#charge('setup_bytes', Buffer.byteLength(wire));
            this.#db.prepare(`UPDATE client_setups SET ${slot}_wire=? WHERE channel=?`).run(wire, channel);
          }, true);
        }),
      }, fetchImpl);
      if (this.#closed) { mailbox.close(); localFailure(); }
      for (const old of this.#mailboxes) if (old.closed) this.#mailboxes.delete(old);
      this.#mailboxes.add(mailbox); return mailbox;
    });
  }
  /** Exact public ciphertext/key records for manual reconciliation, never a resend permit. */
  invitationAttempt(channel: string) {
    return this.#sync(() => {
      invitationScope({ hub: this.#hub, channel });
      const row = this.#db.prepare('SELECT peer_key AS peerSigningPublicKey,role,key_wire AS keyWire,sealed_wire AS sealedWire FROM client_setups WHERE channel=?').get(channel);
      if (!row) localFailure(); return { ...row };
    });
  }
  /** A durable once-only session reservation; never reacquire an old ID after restart. */
  async createSession(roomId: string, sessionId: string, http: RoomHttpClient): Promise<RoomSessionClient> {
    return this.#async(async () => {
      if (!room(roomId) || !id(sessionId)) localFailure();
      const row = this.#db.prepare('SELECT bundle_json,pins_json FROM client_rooms WHERE room_id=?').get(roomId);
      if (!row || typeof row.bundle_json !== 'string' || row.bundle_json.length > 15000 || typeof row.pins_json !== 'string'
        || row.pins_json.length > 1024) localFailure();
      const bundle = JSON.parse(row.bundle_json), pins = JSON.parse(row.pins_json);
      const binding = await verifyRoomKeyBindings(bundle, pins);
      const role = binding.owner.signingPublicKey === this.#signingPublicKey ? 'owner' : 'peer';
      if (binding.hub !== this.#hub || binding.roomId !== roomId || binding[role].signingPublicKey !== this.#signingPublicKey) localFailure();
      this.#sync(() => { this.#charge('sessions'); this.#db.prepare('INSERT INTO client_sessions VALUES (?,?)').run(roomId, sessionId); }, true);
      const journal: RoomSessionJournal = {
        retain: wire => this.#async(async () => { const p = await this.#proof('packet', wire);
          if (p.roomId !== roomId || p.sessionId !== sessionId || p.revision !== binding.acceptedRevision) localFailure(); this.#retain(p); }),
        confirm: (wire, receipt) => this.#async(async () => { const p = await this.#proof('packet', wire);
          if (p.roomId !== roomId || p.sessionId !== sessionId) localFailure(); this.#confirm(p, receipt); }),
      };
      const client = await RoomSessionClient.create({ role, bundle, pins, sessionId, http, journal,
        signingPrivateKey: this.#identity().signingPrivateKey, encryptionPrivateKey: this.roomKey(roomId).privateKey });
      if (this.#closed) { client.dispose(); localFailure(); }
      for (const old of this.#sessions) if (old.closed) this.#sessions.delete(old);
      this.#sessions.add(client); return client;
    });
  }
  /** Bounded local metadata, not a public directory, record transcript or membership proof. */
  pending(after = 0, limit = 20) {
    return this.#sync(() => {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) localFailure();
      return this.#db.prepare('SELECT rowid AS position,kind,request_id AS requestId,room_id AS roomId FROM client_ops WHERE receipt IS NULL AND rowid>? ORDER BY rowid LIMIT ?').all(after, limit);
    });
  }
  operation(kind: Kind, requestId: string) {
    return this.#async(async () => {
      const row = this.#sync(() => this.#row(kind, requestId)); if (!row) localFailure();
      const proof = await this.#proof(kind, row.wire);
      if (proof.digest !== row.digest || proof.roomId !== row.room_id) localFailure();
      if (row.receipt !== null && (typeof row.receipt !== 'string' || row.receipt.length > 2048)) localFailure();
      return { wire: row.wire, receipt: row.receipt === null ? null : this.#receipt(proof, JSON.parse(row.receipt)) };
    });
  }
  /** Explicit historical reconciliation after restart. Null is unresolved; never resubmit automatically. */
  async recover(kind: Kind, requestId: string, http: RoomHttpClient) {
    const retained = await this.operation(kind, requestId), proof = await this.#proof(kind, retained.wire);
    const identity = this.identity(), issuedAt = Date.now();
    const common = { hub: this.#hub, roomId: proof.roomId, actor: await deriveAgentId(this.#signingPublicKey),
      requestId, proofDigest: proof.digest, queryId: randomId(), issuedAt, expiresAt: issuedAt + 60_000 };
    const query = kind === 'control'
      ? await signRoomRecovery({ ...common, protocol: ROOM_RECOVERY_PROTOCOL }, identity.signingPrivateKey)
      : await signRoomPacketRecovery({ ...common, protocol: ROOM_PACKET_RECOVERY_PROTOCOL,
        signingPublicKey: this.#signingPublicKey }, identity.signingPrivateKey);
    this.#check(); // Closing during signing must not start a late network read.
    const result = kind === 'control' ? await http.recover(query, this.#signingPublicKey) : await http.recoverPacket(query);
    if (result.receipt) this.#sync(() => this.#confirm(proof, result.receipt));
    return result.receipt;
  }
  close(): void {
    if (this.#closed) return; this.#closed = true;
    for (const session of this.#sessions) session.dispose(); this.#sessions.clear();
    for (const mailbox of this.#mailboxes) mailbox.close(); this.#mailboxes.clear();
    try { this.#db.close(); } catch {} this.#files.close();
  }
}
