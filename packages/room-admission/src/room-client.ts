/** Source-only agent workflow over the existing room contracts. No service, command runner or auto-accept. */
import { randomBytes } from 'node:crypto';
import { deriveAgentId } from '@openagentforum/protocol';
import { RoomLocalState } from './local-state.js';
import { RoomHttpClient } from './http-client.js';
import { roomDeadline, roomWithSignal } from './http-contract.js';
import { RoomInvitationMailbox } from './invitation-mailbox.js';
import { invitationScope, type RoomInvitationOffer } from './invitation-wire.js';
import { ROOM_CONTROL_PROTOCOL, deriveRoomId, signRoomControl, verifyHistoricalRoomControlSignature, type RoomControlAction } from './control.js';
import { ROOM_STATE_PROTOCOL, signRoomState } from './state-read.js';
import type { RoomSessionClient } from './session-client.js';
import type { RoomKeyBundle } from './key-bindings.js';

const id = () => randomBytes(16).toString('hex');
const fresh = () => { const issuedAt = Date.now(); return { issuedAt, expiresAt: issuedAt + 60000 }; };
type Phase = 'new' | 'waiting-peer' | 'peer-ready' | 'offer-sent' | 'invitation' | 'accepted' | 'connected' | 'failed' | 'disposed';
export interface RoomRecoveryReference { kind: 'control' | 'packet'; roomId: string; requestId: string }
type ErrorCode = 'invalid_input' | 'wrong_phase' | 'busy' | 'unavailable' | 'needs_recovery' | 'deadline' | 'disposed';
export class RoomClientError extends Error {
  readonly permitsReplacementMutation = false;
  readonly recovery: Readonly<RoomRecoveryReference> | null;
  constructor(readonly code: ErrorCode, reference?: RoomRecoveryReference | null) {
    super(`Room client: ${code}`);
    this.recovery = reference && ['control', 'packet'].includes(reference.kind)
      && typeof reference.roomId === 'string' && /^room_[0-9a-f]{32}$/.test(reference.roomId)
      && typeof reference.requestId === 'string' && /^[0-9a-f]{32}$/.test(reference.requestId)
      ? Object.freeze({ kind: reference.kind, roomId: reference.roomId, requestId: reference.requestId }) : null;
  }
}
export interface RoomInvitationDecision {
  kind: 'untrusted-room-invitation'; roomId: string; sessionId: string;
  fromSigningPublicKey: string; invitationDigest: string; expiresAt: number;
}
export interface RoomClientOptions {
  local: RoomLocalState; peerSigningPublicKey: string; role: 'owner' | 'peer'; channel: string;
  fetch?: typeof fetch; operationTimeoutMs?: number;
}

/** One explicit setup and session. Owns its mailbox/cipher, NOT the caller's local journal. */
export class RoomClient {
  readonly #local: RoomLocalState;
  readonly #own: string;
  readonly #peer: string;
  readonly #role: 'owner' | 'peer';
  readonly #hub: string;
  readonly #channel: string;
  readonly #fetch: typeof fetch;
  readonly #http: RoomHttpClient;
  readonly #timeout: number;
  #phase: Phase = 'new';
  #busy = false;
  #mailbox: RoomInvitationMailbox | null = null;
  #session: RoomSessionClient | null = null;
  #offer: RoomInvitationOffer | null = null;
  #decision: Readonly<RoomInvitationDecision> | null = null;
  #roomId: string | null = null;
  #recovery: RoomRecoveryReference | null = null;
  constructor(options: RoomClientOptions) {
    try {
      if (!(options.local instanceof RoomLocalState) || !['owner', 'peer'].includes(options.role)
        || typeof options.peerSigningPublicKey !== 'string' || !/^[0-9a-f]{64}$/.test(options.peerSigningPublicKey)) throw new Error();
      const scope = options.local.scope(); invitationScope({ hub: scope.hub, channel: options.channel });
      if (scope.signingPublicKey === options.peerSigningPublicKey) throw new Error();
      this.#timeout = options.operationTimeoutMs ?? 20000;
      if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 20000) throw new Error();
      this.#local = options.local; this.#hub = scope.hub; this.#own = scope.signingPublicKey;
      this.#peer = options.peerSigningPublicKey; this.#role = options.role; this.#channel = options.channel;
      this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
      this.#http = new RoomHttpClient({ hub: this.#hub, fetch: this.#fetch });
    } catch { throw new RoomClientError('invalid_input'); }
  }
  get phase(): Phase { return this.#phase; }
  get roomId() { return this.#roomId; }
  get sessionId() { return this.#offer?.sessionId ?? null; }
  get recovery(): Readonly<RoomRecoveryReference> | null {
    const pending = this.#session?.pendingWire;
    const ref = pending ? { kind: 'packet' as const, roomId: this.#roomId!, requestId: JSON.parse(pending).requestId } : this.#recovery;
    return ref ? Object.freeze({ ...ref }) : null;
  }
  #check() { if (this.#phase === 'disposed' || this.#phase === 'failed') throw new RoomClientError('disposed', this.recovery); }
  #require(...phases: Phase[]) {
    this.#check(); if (this.#busy) throw new RoomClientError('busy');
    if (!phases.includes(this.#phase)) throw new RoomClientError('wrong_phase', this.recovery);
  }
  async #run<T>(fn: () => Promise<T>, stopOnFailure = true): Promise<T> {
    this.#check(); if (this.#busy) throw new RoomClientError('busy'); this.#busy = true;
    const deadline = roomDeadline(this.#timeout);
    try { const value = await roomWithSignal(fn(), deadline.signal); this.#check(); return value; }
    catch (error) {
      const reference = this.recovery;
      if (stopOnFailure || deadline.signal.aborted || this.#session?.closed) { this.dispose(); this.#phase = 'failed'; }
      if (error instanceof RoomClientError) throw error;
      throw new RoomClientError(deadline.signal.aborted ? 'deadline' : reference ? 'needs_recovery' : 'unavailable', reference);
    } finally { deadline.close(); this.#busy = false; }
  }
  async #wait<T>(read: () => Promise<T | null | false>): Promise<T> {
    for (let count = 0; count < 100; count++) {
      this.#check(); const value = await read(); this.#check(); if (value !== null && value !== false) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new RoomClientError('deadline', this.recovery);
  }
  /** Explicit setup write; never registers or changes the selected full key. */
  startSetup(): Promise<void> {
    this.#require('new');
    return this.#run(async () => {
      // Unresolved earlier controls/packets need a decision, not another automatically generated room.
      if (this.#local.pending(0, 1).length) throw new RoomClientError('needs_recovery');
      const mailbox = await this.#local.createInvitationMailbox(this.#peer, this.#role, this.#channel, this.#fetch);
      if (this.#phase === 'disposed' || this.#phase === 'failed') { mailbox.close(); this.#check(); }
      this.#mailbox = mailbox;
      const wire = await mailbox.prepareKey(); this.#check(); await mailbox.post(wire); this.#check();
      this.#phase = 'waiting-peer';
    });
  }
  /** Finite read-only wait for the already pinned peer's key announcement. */
  waitForPeer(): Promise<void> {
    this.#require('waiting-peer');
    return this.#run(async () => { await this.#wait(() => this.#mailbox!.findPeerKey()); this.#phase = 'peer-ready'; });
  }
  async #control(action: RoomControlAction): Promise<string> {
    this.#check(); const identity = this.#local.identity();
    const wire = await signRoomControl(action, identity.signingPrivateKey); this.#check();
    this.#recovery = { kind: 'control', roomId: action.roomId, requestId: action.requestId };
    await this.#local.retainControl(wire); this.#check();
    const result = await this.#http.submit(wire, this.#own); this.#check();
    await this.#local.confirmControl(wire, result.receipt); this.#check(); this.#recovery = null; return wire;
  }
  async #action(action: RoomControlAction['action'], roomId: string, revision: number, payload: RoomControlAction['payload'], requestId = id()) {
    const actor = await deriveAgentId(this.#own); this.#check();
    return { protocol: ROOM_CONTROL_PROTOCOL, hub: this.#hub, actor, roomId, requestId,
      ...fresh(), action, expectedRevision: revision, payload } as RoomControlAction;
  }
  /** Explicitly create, invite and deliver. Each room mutation is retained before its one POST. */
  invite(): Promise<{ roomId: string; sessionId: string }> {
    this.#require('peer-ready'); if (this.#role !== 'owner') throw new RoomClientError('wrong_phase');
    return this.#run(async () => {
      const requestId = id(), actor = await deriveAgentId(this.#own); this.#check();
      const roomId = await deriveRoomId(this.#hub, actor, requestId); this.#check(); this.#roomId = roomId;
      const key = this.#local.createRoomKey(roomId);
      const create = await this.#control(await this.#action('create', roomId, 0, { encryptionPublicKey: key.publicKey }, requestId));
      const recipient = await deriveAgentId(this.#peer); this.#check();
      const invite = await this.#control(await this.#action('invite', roomId, 1,
        { recipient, recipientSigningPublicKey: this.#peer, inviteExpiresAt: Date.now() + 120000 }));
      this.#offer = { kind: 'oaf.room.offer.v1', sessionId: id(), create, invite };
      const sealed = await this.#mailbox!.prepare(this.#offer); this.#check(); await this.#mailbox!.post(sealed); this.#check();
      this.#phase = 'offer-sent'; return { roomId, sessionId: this.#offer.sessionId };
    });
  }
  /** Returns consent metadata, not raw signing instructions. This method never accepts or writes a room. */
  inspectInvitation(): Promise<Readonly<RoomInvitationDecision>> {
    this.#require('peer-ready', 'invitation'); if (this.#role !== 'peer') throw new RoomClientError('wrong_phase');
    return this.#run(async () => {
      if (this.#decision) return this.#decision;
      const offer = await this.#wait(() => this.#mailbox!.find());
      if (offer.kind !== 'oaf.room.offer.v1') throw new RoomClientError('unavailable');
      const proof = await verifyHistoricalRoomControlSignature(offer.invite, this.#peer, this.#hub); this.#check();
      if (!proof.ok || proof.action.action !== 'invite') throw new RoomClientError('unavailable');
      this.#offer = offer; this.#roomId = proof.action.roomId;
      this.#decision = Object.freeze({ kind: 'untrusted-room-invitation', roomId: this.#roomId, sessionId: offer.sessionId,
        fromSigningPublicKey: this.#peer, invitationDigest: proof.proofDigest,
        expiresAt: Math.min(proof.action.payload.inviteExpiresAt, this.#mailbox!.expiresAt) });
      this.#phase = 'invitation'; return this.#decision;
    });
  }
  async #bindings(bundle: RoomKeyBundle) {
    await this.#local.saveBindings(bundle, { hub: this.#hub, roomId: this.#roomId!,
      ownerSigningPublicKey: this.#role === 'owner' ? this.#own : this.#peer,
      peerSigningPublicKey: this.#role === 'peer' ? this.#own : this.#peer }); this.#check();
  }
  /** Explicit local decision for the exact inspected invitation, not a boolean auto-accept hook. */
  accept(decision: Readonly<RoomInvitationDecision>): Promise<void> {
    this.#require('invitation');
    if (!decision || !this.#decision || Object.keys(decision).length !== 6
      || Object.entries(this.#decision).some(([key, value]) => decision[key as keyof RoomInvitationDecision] !== value)
      || Date.now() >= this.#decision.expiresAt) throw new RoomClientError('invalid_input');
    return this.#run(async () => {
      await this.#mailbox!.findPeerKey(); this.#check(); // recheck setup expiry before creating acceptance
      const offer = this.#offer!, key = this.#local.createRoomKey(this.#roomId!);
      const invite = JSON.parse(offer.invite);
      const accept = await this.#control(await this.#action('accept', this.#roomId!, invite.expectedRevision + 1,
        { invitationDigest: this.#decision!.invitationDigest, encryptionPublicKey: key.publicKey }));
      // Retain accepted bindings BEFORE an uncertain forum delivery can end this process.
      await this.#bindings({ create: offer.create, invite: offer.invite, accept });
      const sealed = await this.#mailbox!.prepare({ ...offer, kind: 'oaf.room.accept.v1', accept }); this.#check();
      await this.#mailbox!.post(sealed); this.#check(); this.#mailbox!.close(); this.#phase = 'accepted';
    });
  }
  waitForAcceptance(): Promise<void> {
    this.#require('offer-sent');
    return this.#run(async () => {
      const accepted = await this.#wait(() => this.#mailbox!.find());
      if (accepted.kind !== 'oaf.room.accept.v1') throw new RoomClientError('unavailable');
      await this.#bindings({ create: accepted.create, invite: accepted.invite, accept: accepted.accept });
      this.#mailbox!.close(); this.#phase = 'accepted';
    });
  }
  /** Explicit bounded handshake. No reconnect, replacement session or restored cipher counters. */
  connect(): Promise<void> {
    this.#require('accepted');
    return this.#run(async () => {
      const session = await this.#local.createSession(this.#roomId!, this.#offer!.sessionId, this.#http);
      if (this.#phase === 'disposed' || this.#phase === 'failed') { session.dispose(); this.#check(); }
      this.#session = session;
      if (this.#role === 'owner') { await session.start(); this.#check(); await session.flush(); this.#check(); }
      await this.#wait(async () => {
        if (session.ready) return true;
        await session.poll(); this.#check();
        if (session.pendingWire) { await session.flush(); this.#check(); }
        return session.ready;
      });
      this.#phase = 'connected';
    });
  }
  send(bytes: Uint8Array): Promise<void> {
    this.#require('connected');
    return this.#run(async () => { await this.#session!.prepareData(bytes); this.#check(); await this.#session!.flush(); }, false);
  }
  receive() { this.#require('connected'); return this.#run(() => this.#session!.poll(), false); }
  acknowledge(requestId: string): void { this.#require('connected'); this.#session!.acknowledge(requestId); }
  recoverSend() { this.#require('connected'); return this.#run(() => this.#session!.recoverPending(), false); }
  dispose(): void { this.#phase = 'disposed'; this.#mailbox?.close(); this.#session?.dispose(); }
}

/** Fresh member-only status. Not a reusable authorization lease. No workflow instance required after restart. */
export async function readRoomStatus(local: RoomLocalState, roomId: string, fetchImpl: typeof fetch = fetch) {
  try {
    if (typeof roomId !== 'string' || !/^room_[0-9a-f]{32}$/.test(roomId)) throw new RoomClientError('invalid_input');
    const scope = local.scope(), identity = local.identity();
    const wire = await signRoomState({ protocol: ROOM_STATE_PROTOCOL, hub: scope.hub, roomId,
      actor: await deriveAgentId(scope.signingPublicKey), queryId: id(), ...fresh() }, identity.signingPrivateKey);
    local.scope(); // A close during async signing must not issue a late request.
    return (await new RoomHttpClient({ hub: scope.hub, fetch: fetchImpl }).readState(wire, scope.signingPublicKey)).room;
  } catch (error) { if (error instanceof RoomClientError) throw error; throw new RoomClientError('unavailable'); }
}
/** Explicit historical lookup only, including after restart. Null remains unresolved. */
export async function recoverRoomOperation(local: RoomLocalState, reference: RoomRecoveryReference, fetchImpl: typeof fetch = fetch) {
  const ref = { ...reference };
  try {
    if (!['control', 'packet'].includes(ref.kind) || typeof ref.roomId !== 'string' || typeof ref.requestId !== 'string'
      || !/^room_[0-9a-f]{32}$/.test(ref.roomId) || !/^[0-9a-f]{32}$/.test(ref.requestId)) throw new Error();
    const retained = await local.operation(ref.kind, ref.requestId);
    if (JSON.parse(retained.wire).roomId !== ref.roomId) throw new Error();
    return await local.recover(ref.kind, ref.requestId, new RoomHttpClient({ hub: local.scope().hub, fetch: fetchImpl }));
  } catch { throw new RoomClientError('needs_recovery', ref); }
}
/** Either admitted agent may explicitly close. A pending close blocks a fresh mutation, even after restart. */
export async function closeRoom(local: RoomLocalState, roomId: string, fetchImpl: typeof fetch = fetch) {
  let reference: RoomRecoveryReference | null = null;
  try {
    const pending = local.pendingClose(roomId);
    if (pending) throw new RoomClientError('needs_recovery', { kind: 'control', roomId, requestId: pending });
    const state = await readRoomStatus(local, roomId, fetchImpl);
    if (!state) throw new RoomClientError('unavailable'); if (state.status === 'closed') return state;
    const { hub, signingPublicKey } = local.scope(), identity = local.identity(), requestId = id();
    const wire = await signRoomControl({ protocol: ROOM_CONTROL_PROTOCOL, hub, roomId, requestId,
      actor: await deriveAgentId(signingPublicKey), ...fresh(), expectedRevision: state.revision, action: 'close', payload: {} }, identity.signingPrivateKey);
    reference = { kind: 'control', roomId, requestId };
    // Recheck pending close after awaits: no concurrent call may invent a second close.
    const conflict = local.pendingClose(roomId);
    if (conflict) throw new RoomClientError('needs_recovery', { kind: 'control', roomId, requestId: conflict });
    return (await local.submitControl(wire, new RoomHttpClient({ hub, fetch: fetchImpl }))).receipt;
  } catch (error) {
    if (error instanceof RoomClientError) throw error;
    throw new RoomClientError(reference ? 'needs_recovery' : 'unavailable', reference);
  }
}
