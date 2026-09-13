/** Internal signed receipt lookup. Not membership authorization or a public API. */
import {
  bytesToHex, canonicalizeJson, deriveAgentId, hexToBytes,
  importEdPrivateKey, importEdPublicKey,
} from '@openagentforum/protocol';
import type { RoomControlError } from './control.js';

export const ROOM_RECOVERY_PROTOCOL = 'oaf-room-recovery-v1-draft1';
export const ROOM_RECOVERY_LIMITS = Object.freeze({
  wireBytes: 2048, proofLifetimeMs: 60_000, futureSkewMs: 30_000,
} as const);
export interface RoomRecoveryQuery {
  protocol: typeof ROOM_RECOVERY_PROTOCOL;
  hub: string;
  actor: string;
  queryId: string;
  roomId: string;
  requestId: string;
  proofDigest: string;
  issuedAt: number;
  expiresAt: number;
}
type RecoveryProof = RoomRecoveryQuery & { signature: string };
const encoder = new TextEncoder();
const hexKey = /^[0-9a-f]{64}$/;
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
function validProof(value: unknown): value is RecoveryProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = ['protocol', 'hub', 'actor', 'queryId', 'roomId', 'requestId', 'proofDigest',
    'issuedAt', 'expiresAt', 'signature'];
  return Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key))
    && v.protocol === ROOM_RECOVERY_PROTOCOL && hubOrigin(v.hub)
    && matches(v.actor, /^agent_[0-9a-f]{16}$/) && matches(v.roomId, /^room_[0-9a-f]{32}$/)
    && matches(v.queryId, /^[0-9a-f]{32}$/) && matches(v.requestId, /^[0-9a-f]{32}$/)
    && matches(v.proofDigest, hexKey) && matches(v.signature, /^[0-9a-f]{128}$/)
    && integer(v.issuedAt) && integer(v.expiresAt) && v.expiresAt > v.issuedAt
    && v.expiresAt - v.issuedAt <= ROOM_RECOVERY_LIMITS.proofLifetimeMs;
}
export function roomRecoverySignString(query: RoomRecoveryQuery): string {
  return `${ROOM_RECOVERY_PROTOCOL}\n${canonicalizeJson(query)}`;
}
/** Local helper only; never expose a remote signing oracle. */
export async function signRoomRecovery(query: RoomRecoveryQuery, privateKey: string): Promise<string> {
  const snapshot: RoomRecoveryQuery = JSON.parse(canonicalizeJson(query));
  if (!snapshot || Object.hasOwn(snapshot, 'signature')
      || !validProof({ ...snapshot, signature: '0'.repeat(128) })) throw new Error('Invalid recovery query');
  const key = await importEdPrivateKey(privateKey);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign(
    'Ed25519', key, encoder.encode(roomRecoverySignString(snapshot)),
  )));
  return canonicalizeJson({ ...snapshot, signature });
}
export interface PreparedRoomRecovery {
  ok: true;
  query: Readonly<RoomRecoveryQuery>;
  freshness(now: number): RoomControlError | null;
}
/** Storage accepts raw wire, not this prepared object. All query fields are flat and frozen. */
export async function prepareRoomRecovery(wire: string, signingPublicKey: string,
  context: { hub: string; now: number }): Promise<PreparedRoomRecovery | { ok: false; reason: RoomControlError }> {
  const fail = (reason: RoomControlError): { ok: false; reason: RoomControlError } => ({ ok: false, reason });
  const { hub, now } = context;
  if (!hubOrigin(hub) || !integer(now)) return fail('invalid_context');
  if (typeof wire !== 'string' || wire.length > ROOM_RECOVERY_LIMITS.wireBytes
      || encoder.encode(wire).length > ROOM_RECOVERY_LIMITS.wireBytes) return fail('invalid_wire');
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
    if (query.issuedAt > time + ROOM_RECOVERY_LIMITS.futureSkewMs) return 'future_proof';
    return null;
  };
  const stale = freshness(now);
  if (stale) return fail(stale);
  if (!matches(signingPublicKey, hexKey)) return fail('invalid_public_key');
  if (await deriveAgentId(signingPublicKey) !== query.actor) return fail('identity_mismatch');
  try {
    const key = await importEdPublicKey(signingPublicKey);
    if (!await crypto.subtle.verify('Ed25519', key, hexToBytes(signature) as BufferSource,
      encoder.encode(roomRecoverySignString(query)))) return fail('invalid_signature');
  } catch { return fail('invalid_signature'); }
  return { ok: true, query, freshness };
}
