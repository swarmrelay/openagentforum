/**
 * Unpublished control reference for RFC 0003. NOT a production room API.
 * No storage, admission budgets, authenticated data access, or encryption profile.
 * A successful evaluation is a proposal, never permission to commit without CAS.
 */
import {
  bytesToHex, canonicalizeJson, deriveAgentId, hexToBytes,
  importEdPrivateKey, importEdPublicKey, sha256Hex,
} from '@openagentforum/protocol';

export const ROOM_CONTROL_PROTOCOL = 'oaf-room-control-v1-draft1';
export const ROOM_CONTROL_LIMITS = Object.freeze({
  wireBytes: 4096,
  proofLifetimeMs: 300_000,
  futureSkewMs: 30_000,
  invitationLifetimeMs: 900_000,
} as const);
const encoder = new TextEncoder();
const HEX_32 = /^[0-9a-f]{64}$/;
const AGENT_ID = /^agent_[0-9a-f]{16}$/;

interface CommonAction {
  protocol: typeof ROOM_CONTROL_PROTOCOL;
  hub: string;
  roomId: string;
  actor: string;
  requestId: string;
  issuedAt: number;
  expiresAt: number;
  expectedRevision: number;
}
export type RoomControlAction = CommonAction & (
  | { action: 'create'; payload: { encryptionPublicKey: string } }
  | { action: 'invite'; payload: {
      recipient: string; recipientSigningPublicKey: string; inviteExpiresAt: number;
    } }
  | { action: 'accept'; payload: { invitationDigest: string; encryptionPublicKey: string } }
  | { action: 'close'; payload: Record<string, never> }
);
export type RoomControlProof = RoomControlAction & { signature: string };

export interface RoomMember {
  agentId: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}
/** Trusted local snapshot only: never deserialize this from an agent request. */
export interface RoomState {
  protocol: typeof ROOM_CONTROL_PROTOCOL;
  hub: string;
  roomId: string;
  revision: number;
  status: 'open' | 'closed';
  owner: RoomMember;
  peer: RoomMember | null;
  invitation: {
    digest: string; recipient: string; recipientSigningPublicKey: string; expiresAt: number;
  } | null;
}
export type RoomControlError =
  | 'invalid_context' | 'invalid_wire' | 'invalid_schema' | 'noncanonical_wire'
  | 'wrong_hub' | 'expired_proof' | 'future_proof' | 'invalid_public_key'
  | 'identity_mismatch' | 'invalid_signature' | 'wrong_room' | 'room_exists'
  | 'room_missing' | 'room_closed' | 'revision_conflict' | 'not_authorized'
  | 'room_full' | 'invalid_recipient' | 'invitation_mismatch' | 'invitation_expired';
export type RoomControlResult =
  | { ok: true; state: RoomState; proofDigest: string }
  | { ok: false; reason: RoomControlError };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function hubOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch { return false; }
}
function validProof(value: unknown): value is RoomControlProof {
  if (!record(value) || !exactKeys(value, [
    'protocol', 'hub', 'roomId', 'actor', 'requestId', 'issuedAt', 'expiresAt',
    'expectedRevision', 'action', 'payload', 'signature',
  ])) return false;
  if (value.protocol !== ROOM_CONTROL_PROTOCOL || !hubOrigin(value.hub)
      || !matches(value.roomId, /^room_[0-9a-f]{32}$/) || !matches(value.actor, AGENT_ID)
      || !matches(value.requestId, /^[0-9a-f]{32}$/) || !matches(value.signature, /^[0-9a-f]{128}$/)
      || !integer(value.issuedAt) || !integer(value.expiresAt) || !integer(value.expectedRevision)
      || value.expiresAt <= value.issuedAt
      || value.expiresAt - value.issuedAt > ROOM_CONTROL_LIMITS.proofLifetimeMs
      || !record(value.payload)) return false;
  const payload = value.payload;
  switch (value.action) {
    case 'create': return value.expectedRevision === 0
      && exactKeys(payload, ['encryptionPublicKey']) && matches(payload.encryptionPublicKey, HEX_32);
    case 'invite': return exactKeys(payload, ['recipient', 'recipientSigningPublicKey', 'inviteExpiresAt'])
      && matches(payload.recipient, AGENT_ID) && matches(payload.recipientSigningPublicKey, HEX_32)
      && integer(payload.inviteExpiresAt) && payload.inviteExpiresAt > value.issuedAt
      && payload.inviteExpiresAt - value.issuedAt <= ROOM_CONTROL_LIMITS.invitationLifetimeMs;
    case 'accept': return exactKeys(payload, ['invitationDigest', 'encryptionPublicKey'])
      && matches(payload.invitationDigest, HEX_32) && matches(payload.encryptionPublicKey, HEX_32);
    case 'close': return exactKeys(payload, []);
    default: return false;
  }
}

export function roomControlSignString(action: RoomControlAction): string {
  return `${ROOM_CONTROL_PROTOCOL}\n${canonicalizeJson(action)}`;
}
/** ID is derived, not a caller-chosen alias for an existing channel. */
export async function deriveRoomId(hub: string, actor: string, requestId: string): Promise<string> {
  if (!hubOrigin(hub) || !AGENT_ID.test(actor) || !/^[0-9a-f]{32}$/.test(requestId)) {
    throw new Error('Invalid room ID inputs');
  }
  const digest = await sha256Hex(`oaf-room-id-v1-draft1\n${canonicalizeJson({ hub, actor, requestId })}`);
  return `room_${digest.slice(0, 32)}`;
}
/** Local fixture helper. The private key stays in memory; only public wire is returned. */
export async function signRoomControl(action: RoomControlAction, privateKey: string): Promise<string> {
  // Snapshot before the first await; later caller mutation cannot change signed bytes.
  const snapshot: RoomControlAction = JSON.parse(canonicalizeJson(action));
  if (!record(snapshot) || Object.hasOwn(snapshot, 'signature')
      || !validProof({ ...snapshot, signature: '0'.repeat(128) })) throw new Error('Invalid room action');
  const key = await importEdPrivateKey(privateKey);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign(
    'Ed25519', key, encoder.encode(roomControlSignString(snapshot)),
  )));
  return canonicalizeJson({ ...snapshot, signature });
}

/**
 * Verify and evaluate against one trusted snapshot. No network or side effects.
 * Caller MUST atomically recheck revision, time, receipts and budgets at commit.
 */
export async function evaluateRoomControl(
  state: RoomState | null,
  wire: string,
  actorPublicKey: string,
  context: { hub: string; now: number },
): Promise<RoomControlResult> {
  const snapshot = state === null ? null : structuredClone(state);
  const { hub, now } = context;
  const prepared = await prepareRoomControl(wire, actorPublicKey, { hub, now });
  return prepared.ok ? prepared.evaluate(snapshot, now) : prepared;
}

export interface PreparedRoomControl {
  ok: true;
  action: RoomControlAction;
  proofDigest: string;
  /** Freshness is checked again at the synchronous transaction boundary. */
  freshness(now: number): RoomControlError | null;
  /** Uses closure-owned verified fields, not the exposed action snapshot. */
  evaluate(state: RoomState | null, now: number): RoomControlResult;
}

function parseControl(wire: string, hub: string): { ok: true; proof: RoomControlProof }
  | { ok: false; reason: RoomControlError } {
  const fail = (reason: RoomControlError): { ok: false; reason: RoomControlError } => ({ ok: false, reason });
  if (!hubOrigin(hub)) return fail('invalid_context');
  if (typeof wire !== 'string' || wire.length > ROOM_CONTROL_LIMITS.wireBytes
      || encoder.encode(wire).length > ROOM_CONTROL_LIMITS.wireBytes) return fail('invalid_wire');
  let proof: unknown;
  try { proof = JSON.parse(wire); } catch { return fail('invalid_wire'); }
  if (!validProof(proof)) return fail('invalid_schema');
  // Exact canonical wire rejects duplicate properties, whitespace, numeric aliases,
  // escape aliases and reordered keys instead of relying on parser-specific rules.
  if (canonicalizeJson(proof) !== wire) return fail('noncanonical_wire');
  if (proof.hub !== hub) return fail('wrong_hub');
  return { ok: true, proof };
}

interface AuthenticatedControl {
  ok: true; action: RoomControlAction; proofDigest: string;
}
async function authenticateControl(proof: RoomControlProof, actorPublicKey: string):
Promise<AuthenticatedControl | { ok: false; reason: RoomControlError }> {
  const fail = (reason: RoomControlError): { ok: false; reason: RoomControlError } => ({ ok: false, reason });
  if (!matches(actorPublicKey, HEX_32)) return fail('invalid_public_key');
  const { signature, ...action } = proof;
  const signString = roomControlSignString(action);
  if (await deriveAgentId(actorPublicKey) !== action.actor) return fail('identity_mismatch');
  try {
    const key = await importEdPublicKey(actorPublicKey);
    if (!await crypto.subtle.verify('Ed25519', key, hexToBytes(signature) as BufferSource,
      encoder.encode(signString))) return fail('invalid_signature');
  } catch { return fail('invalid_signature'); }
  const proofDigest = await sha256Hex(signString);
  return { ok: true, action, proofDigest };
}

/**
 * Historical signature/key binding ONLY. No freshness, membership or admission.
 * Never use this to authorize a mutation, state read, or message access.
 */
export async function authenticateRoomControl(wire: string, actorPublicKey: string, hub: string):
Promise<AuthenticatedControl | { ok: false; reason: RoomControlError }> {
  const parsed = parseControl(wire, hub);
  return parsed.ok ? authenticateControl(parsed.proof, actorPublicKey) : parsed;
}

/** Internal preparation only. Storage must accept raw wire, never caller-prepared objects. */
export async function prepareRoomControl(
  wire: string,
  actorPublicKey: string,
  context: { hub: string; now: number },
): Promise<PreparedRoomControl | { ok: false; reason: RoomControlError }> {
  const fail = (reason: RoomControlError): { ok: false; reason: RoomControlError } => ({ ok: false, reason });
  const { hub, now } = context;
  if (!hubOrigin(hub) || !integer(now)) return fail('invalid_context');
  const parsed = parseControl(wire, hub);
  if (!parsed.ok) return parsed;
  if (now >= parsed.proof.expiresAt) return fail('expired_proof');
  if (parsed.proof.issuedAt > now + ROOM_CONTROL_LIMITS.futureSkewMs) return fail('future_proof');
  const authenticated = await authenticateControl(parsed.proof, actorPublicKey);
  if (!authenticated.ok) return authenticated;
  const { action, proofDigest } = authenticated;
  const derivedId = action.action === 'create' ? await deriveRoomId(hub, action.actor, action.requestId) : null;
  const recipientMatches = action.action !== 'invite'
    || await deriveAgentId(action.payload.recipientSigningPublicKey) === action.payload.recipient;
  const freshness = (time: number): RoomControlError | null => {
    if (!integer(time)) return 'invalid_context';
    if (time >= action.expiresAt) return 'expired_proof';
    if (action.issuedAt > time + ROOM_CONTROL_LIMITS.futureSkewMs) return 'future_proof';
    return null;
  };
  return {
    ok: true, action: structuredClone(action), proofDigest, freshness,
    evaluate: (state, time) => {
      const stale = freshness(time);
      if (stale) return fail(stale);
      return transition(state, action, actorPublicKey, proofDigest, derivedId, recipientMatches, time);
    },
  };
}

function transition(
  state: RoomState | null, action: RoomControlAction, actorPublicKey: string,
  proofDigest: string, derivedId: string | null, recipientMatches: boolean, now: number,
): RoomControlResult {
  const fail = (reason: RoomControlError): RoomControlResult => ({ ok: false, reason });
  const { hub } = action;
  const snapshot = state === null ? null : structuredClone(state);
  const member = (encryptionPublicKey: string): RoomMember => ({
    agentId: action.actor, signingPublicKey: actorPublicKey, encryptionPublicKey,
  });
  if (snapshot && (snapshot.protocol !== ROOM_CONTROL_PROTOCOL
      || snapshot.hub !== hub || snapshot.roomId !== action.roomId)) return fail('wrong_room');

  if (action.action === 'create') {
    if (action.roomId !== derivedId) return fail('wrong_room');
    if (snapshot) return fail('room_exists');
    return { ok: true, proofDigest, state: {
      protocol: ROOM_CONTROL_PROTOCOL, hub, roomId: action.roomId, revision: 1,
      status: 'open', owner: member(action.payload.encryptionPublicKey), peer: null, invitation: null,
    } };
  }
  if (!snapshot) return fail('room_missing');
  if (snapshot.status === 'closed') return fail('room_closed');
  if (action.expectedRevision !== snapshot.revision
      || snapshot.revision >= Number.MAX_SAFE_INTEGER) return fail('revision_conflict');
  const owner = action.actor === snapshot.owner.agentId && actorPublicKey === snapshot.owner.signingPublicKey;
  const peer = action.actor === snapshot.peer?.agentId && actorPublicKey === snapshot.peer?.signingPublicKey;
  switch (action.action) {
    case 'invite': {
      if (!owner) return fail('not_authorized');
      if (snapshot.peer) return fail('room_full');
      const { recipient, recipientSigningPublicKey, inviteExpiresAt } = action.payload;
      if (recipient === snapshot.owner.agentId
          || !recipientMatches) return fail('invalid_recipient');
      if (now >= inviteExpiresAt) return fail('invitation_expired');
      snapshot.invitation = { digest: proofDigest, recipient, recipientSigningPublicKey, expiresAt: inviteExpiresAt };
      break;
    }
    case 'accept': {
      if (snapshot.peer) return fail('room_full');
      const invitation = snapshot.invitation;
      if (!invitation || invitation.digest !== action.payload.invitationDigest) return fail('invitation_mismatch');
      if (invitation.recipient !== action.actor || invitation.recipientSigningPublicKey !== actorPublicKey) {
        return fail('not_authorized');
      }
      if (now >= invitation.expiresAt) return fail('invitation_expired');
      snapshot.peer = member(action.payload.encryptionPublicKey);
      snapshot.invitation = null;
      break;
    }
    case 'close': {
      if (!owner && !peer) return fail('not_authorized');
      snapshot.status = 'closed';
      snapshot.invitation = null;
      break;
    }
  }
  snapshot.revision += 1;
  return { ok: true, state: snapshot, proofDigest };
}
