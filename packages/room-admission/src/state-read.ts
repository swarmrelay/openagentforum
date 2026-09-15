/** Internal signed status read. Not a message permission, lease or public API. */
import {
  bytesToHex, canonicalizeJson, deriveAgentId, hexToBytes,
  importEdPrivateKey, importEdPublicKey,
} from '@openagentforum/protocol';
import { ROOM_CONTROL_PROTOCOL, type RoomControlError } from './control.js';

export const ROOM_STATE_PROTOCOL = 'oaf-room-state-v1-draft1';
export const ROOM_STATE_LIMITS = Object.freeze({ wireBytes: 2048, proofLifetimeMs: 60_000, futureSkewMs: 30_000 });
export interface RoomStateQuery {
  protocol: typeof ROOM_STATE_PROTOCOL;
  hub: string;
  actor: string;
  queryId: string;
  roomId: string;
  issuedAt: number;
  expiresAt: number;
}
/** Only this minimal projection may leave storage; never return the persisted JSON. */
export interface RoomStateView {
  roomId: string;
  revision: number;
  status: 'open' | 'closed';
  role: 'owner' | 'peer';
}
export type RoomStateReadResult = { ok: true; queryId: string; observedAt: number; room: RoomStateView | null }
  | { ok: false; reason: RoomControlError | 'busy' | 'storage_error' };
type StateProof = RoomStateQuery & { signature: string };
const encoder = new TextEncoder();
const KEY = /^[0-9a-f]{64}$/;
const AGENT = /^agent_[0-9a-f]{16}$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function hubOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; }
  catch { return false; }
}
function validProof(value: unknown): value is StateProof {
  return record(value) && keys(value, ['protocol', 'hub', 'actor', 'queryId', 'roomId', 'issuedAt', 'expiresAt', 'signature'])
    && value.protocol === ROOM_STATE_PROTOCOL && hubOrigin(value.hub)
    && matches(value.actor, AGENT) && matches(value.roomId, /^room_[0-9a-f]{32}$/)
    && matches(value.queryId, /^[0-9a-f]{32}$/) && matches(value.signature, /^[0-9a-f]{128}$/)
    && integer(value.issuedAt) && integer(value.expiresAt) && value.expiresAt > value.issuedAt
    && value.expiresAt - value.issuedAt <= ROOM_STATE_LIMITS.proofLifetimeMs;
}
export function roomStateSignString(query: RoomStateQuery): string {
  return `${ROOM_STATE_PROTOCOL}\n${canonicalizeJson(query)}`;
}
/** Local helper, never a remote signing oracle. Snapshot caller data before awaiting. */
export async function signRoomState(query: RoomStateQuery, privateKey: string): Promise<string> {
  const snapshot: RoomStateQuery = JSON.parse(canonicalizeJson(query));
  if (!snapshot || Object.hasOwn(snapshot, 'signature')
      || !validProof({ ...snapshot, signature: '0'.repeat(128) })) throw new Error('Invalid state query');
  const key = await importEdPrivateKey(privateKey);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign(
    'Ed25519', key, encoder.encode(roomStateSignString(snapshot)),
  )));
  return canonicalizeJson({ ...snapshot, signature });
}
export interface PreparedRoomStateRead {
  ok: true;
  query: Readonly<RoomStateQuery>;
  freshness(now: number): RoomControlError | null;
}
/** Internal preparation. Store methods accept raw wire, never this prepared value. */
export async function prepareRoomStateRead(wire: string, signingKey: string,
  context: { hub: string; now: number }): Promise<PreparedRoomStateRead | { ok: false; reason: RoomControlError }> {
  const fail = (reason: RoomControlError): { ok: false; reason: RoomControlError } => ({ ok: false, reason });
  const { hub, now } = context;
  if (!hubOrigin(hub) || !integer(now)) return fail('invalid_context');
  if (typeof wire !== 'string' || wire.length > ROOM_STATE_LIMITS.wireBytes
      || encoder.encode(wire).length > ROOM_STATE_LIMITS.wireBytes) return fail('invalid_wire');
  let proof: unknown;
  try { proof = JSON.parse(wire); } catch { return fail('invalid_wire'); }
  if (!validProof(proof)) return fail('invalid_schema');
  if (canonicalizeJson(proof) !== wire) return fail('noncanonical_wire');
  if (proof.hub !== hub) return fail('wrong_hub');
  const { signature, ...fields } = proof;
  const query = Object.freeze(fields);
  const freshness = (time: number): RoomControlError | null => {
    if (!integer(time)) return 'invalid_context';
    if (time >= query.expiresAt) return 'expired_proof';
    if (query.issuedAt > time + ROOM_STATE_LIMITS.futureSkewMs) return 'future_proof';
    return null;
  };
  const stale = freshness(now);
  if (stale) return fail(stale);
  if (!matches(signingKey, KEY)) return fail('invalid_public_key');
  if (await deriveAgentId(signingKey) !== query.actor) return fail('identity_mismatch');
  try {
    const key = await importEdPublicKey(signingKey);
    if (!await crypto.subtle.verify('Ed25519', key, hexToBytes(signature) as BufferSource,
      encoder.encode(roomStateSignString(query)))) return fail('invalid_signature');
  } catch { return fail('invalid_signature'); }
  return { ok: true, query, freshness };
}

function member(value: unknown): value is { agentId: string; signingPublicKey: string; encryptionPublicKey: string } {
  return record(value) && keys(value, ['agentId', 'signingPublicKey', 'encryptionPublicKey'])
    && matches(value.agentId, AGENT) && matches(value.signingPublicKey, KEY) && matches(value.encryptionPublicKey, KEY);
}
/** Validate ONLY a primary-store snapshot. This helper is not a caller-facing authorization API. */
export function roomStateView(raw: unknown, query: Readonly<RoomStateQuery>, signingKey: string): RoomStateView | null {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length > 4096 || encoder.encode(raw).length > 4096) throw new Error('Invalid room snapshot');
  const v: unknown = JSON.parse(raw);
  if (!record(v) || !keys(v, ['protocol', 'hub', 'roomId', 'revision', 'status', 'owner', 'peer', 'invitation'])
      || v.protocol !== ROOM_CONTROL_PROTOCOL || v.hub !== query.hub || v.roomId !== query.roomId
      || !integer(v.revision) || v.revision < 1 || (v.status !== 'open' && v.status !== 'closed')
      || !member(v.owner) || (v.peer !== null && (!member(v.peer) || v.peer.agentId === v.owner.agentId))
      || (v.invitation !== null && (!record(v.invitation)
        || !keys(v.invitation, ['digest', 'recipient', 'recipientSigningPublicKey', 'expiresAt'])
        || !matches(v.invitation.digest, KEY) || !matches(v.invitation.recipient, AGENT)
        || v.invitation.recipient === v.owner.agentId || !matches(v.invitation.recipientSigningPublicKey, KEY)
        || !integer(v.invitation.expiresAt)))
      || ((v.status === 'closed' || v.peer !== null) && v.invitation !== null)) throw new Error('Invalid room snapshot');
  // Only canonical bounded shallow data reaches this operation.
  if (canonicalizeJson(v) !== raw) throw new Error('Invalid room snapshot');
  const role = v.owner.agentId === query.actor && v.owner.signingPublicKey === signingKey ? 'owner'
    : v.peer?.agentId === query.actor && v.peer.signingPublicKey === signingKey ? 'peer' : null;
  return role ? { roomId: v.roomId, revision: v.revision, status: v.status, role } : null;
}
