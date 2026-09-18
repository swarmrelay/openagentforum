/**
 * RFC 0008 wire laboratory. Signature verification ONLY: no room authorization,
 * storage, replay journal, encryption, network transport or public API.
 */
import {
  bytesToHex, canonicalizeJson, deriveAgentId, hexToBytes,
  importEdPrivateKey, importEdPublicKey, sha256Hex,
} from '@openagentforum/protocol';

export const ROOM_PACKET_PROTOCOL = 'oaf-room-packet-v1-draft1';
export const ROOM_PACKET_READ_PROTOCOL = 'oaf-room-packet-read-v1-draft1';
export const ROOM_PACKET_RECOVERY_PROTOCOL = 'oaf-room-packet-recovery-v1-draft1';
// Deliberately no import of the Node-only Noise driver. Tests pin this to RFC 0005.
export const ROOM_PACKET_PROFILE = 'oaf-room-noise-ik-v1-draft1';
export const ROOM_PACKET_LIMITS = Object.freeze({
  wireBytes: 36_864, queryBytes: 2048, packetBytes: 16_401,
  readRecords: 8, responseBytes: 327_680, lastPacketIndex: 1025,
  proofLifetimeMs: 60_000, futureSkewMs: 30_000,
} as const);

interface CommonRequest {
  hub: string;
  roomId: string;
  actor: string;
  signingPublicKey: string;
  issuedAt: number;
  expiresAt: number;
}
export interface RoomPacketWrite extends CommonRequest {
  protocol: typeof ROOM_PACKET_PROTOCOL;
  requestId: string;
  expectedRevision: number;
  profile: typeof ROOM_PACKET_PROFILE;
  sessionId: string;
  /** Per sender/session: handshake 0, confirmation 1, application 2..1025. */
  packetIndex: number;
  kind: 'handshake' | 'confirmation' | 'data';
  packetHex: string;
}
export interface RoomPacketRead extends CommonRequest {
  protocol: typeof ROOM_PACKET_READ_PROTOCOL;
  queryId: string;
  expectedRevision: number;
  /** Unsigned relay ordering, NOT an author counter or permission. */
  afterStoredSeq: number;
  limit: number;
}
export interface RoomPacketRecovery extends CommonRequest {
  protocol: typeof ROOM_PACKET_RECOVERY_PROTOCOL;
  queryId: string;
  requestId: string;
  proofDigest: string;
}
type Request = RoomPacketWrite | RoomPacketRead | RoomPacketRecovery;
type Proof<T extends Request> = T & { signature: string };
export type RoomPacketProofError = 'invalid_context' | 'invalid_wire' | 'invalid_schema'
  | 'noncanonical_wire' | 'wrong_hub' | 'expired_proof' | 'future_proof'
  | 'identity_mismatch' | 'invalid_signature';
type Failure = { ok: false; reason: RoomPacketProofError };
export interface VerifiedRoomPacketSignature<T extends Request> {
  ok: true;
  request: Readonly<T>;
  proofDigest: string;
}
export interface PreparedRoomPacket<T extends Request> extends VerifiedRoomPacketSignature<T> {
  /** Future storage MUST recheck with its own trusted clock at the primary boundary. */
  freshness(now: number): RoomPacketProofError | null;
}

const encoder = new TextEncoder();
const KEY = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;
const COMMON = ['protocol', 'hub', 'roomId', 'actor', 'signingPublicKey', 'issuedAt', 'expiresAt', 'signature'];
const fail = (reason: RoomPacketProofError): Failure => ({ ok: false, reason });
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, extra: string[]): boolean {
  const names = [...COMMON, ...extra];
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
function validProof(value: unknown, protocol: Request['protocol']): value is Proof<Request> {
  if (!record(value) || value.protocol !== protocol || !hubOrigin(value.hub)
      || !matches(value.roomId, /^room_[0-9a-f]{32}$/) || !matches(value.actor, /^agent_[0-9a-f]{16}$/)
      || !matches(value.signingPublicKey, KEY) || !matches(value.signature, /^[0-9a-f]{128}$/)
      || !integer(value.issuedAt) || !integer(value.expiresAt) || value.expiresAt <= value.issuedAt
      || value.expiresAt - value.issuedAt > ROOM_PACKET_LIMITS.proofLifetimeMs) return false;
  switch (protocol) {
    case ROOM_PACKET_PROTOCOL: {
      if (!exactKeys(value, ['requestId', 'expectedRevision', 'profile', 'sessionId', 'packetIndex', 'kind', 'packetHex'])
          || !matches(value.requestId, ID) || !integer(value.expectedRevision) || value.expectedRevision < 1
          || value.profile !== ROOM_PACKET_PROFILE || !matches(value.sessionId, ID)
          || !integer(value.packetIndex) || typeof value.packetHex !== 'string'
          || value.packetHex.length > ROOM_PACKET_LIMITS.packetBytes * 2
          || !/^(?:[0-9a-f]{2})+$/.test(value.packetHex)) return false;
      const bytes = value.packetHex.length / 2;
      // Role/phase/order checks require primary membership and session state, NOT this parser.
      if (value.kind === 'handshake') return value.packetIndex === 0 && (bytes === 96 || bytes === 48);
      if (value.kind === 'confirmation') return value.packetIndex === 1 && bytes === 17;
      return value.kind === 'data' && value.packetIndex >= 2
        && value.packetIndex <= ROOM_PACKET_LIMITS.lastPacketIndex && bytes >= 17;
    }
    case ROOM_PACKET_READ_PROTOCOL:
      return exactKeys(value, ['queryId', 'expectedRevision', 'afterStoredSeq', 'limit'])
        && matches(value.queryId, ID) && integer(value.expectedRevision) && value.expectedRevision >= 1
        && integer(value.afterStoredSeq) && integer(value.limit) && value.limit >= 1
        && value.limit <= ROOM_PACKET_LIMITS.readRecords;
    case ROOM_PACKET_RECOVERY_PROTOCOL:
      return exactKeys(value, ['queryId', 'requestId', 'proofDigest'])
        && matches(value.queryId, ID) && matches(value.requestId, ID) && matches(value.proofDigest, KEY);
  }
}
function wireLimit(protocol: Request['protocol']): number {
  return protocol === ROOM_PACKET_PROTOCOL ? ROOM_PACKET_LIMITS.wireBytes : ROOM_PACKET_LIMITS.queryBytes;
}
function signString(request: Readonly<CommonRequest> & { readonly protocol: Request['protocol'] }): string {
  return `${request.protocol}\n${canonicalizeJson(request)}`;
}
async function sign(request: Request, privateKey: string, protocol: Request['protocol']): Promise<string> {
  // Local caller data only. Remote input goes through parse's bounded, flat schema first.
  // Check before canonicalization too: it would otherwise normalize caller-supplied -0.
  if (!record(request) || Object.hasOwn(request, 'signature')
      || !validProof({ ...request, signature: '0'.repeat(128) }, protocol)) throw new Error('Invalid room packet request');
  const snapshot: Request = JSON.parse(canonicalizeJson(request));
  if (!record(snapshot) || Object.hasOwn(snapshot, 'signature')
      || !validProof({ ...snapshot, signature: '0'.repeat(128) }, protocol)) throw new Error('Invalid room packet request');
  const key = await importEdPrivateKey(privateKey);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', key, encoder.encode(signString(snapshot)))));
  const wire = canonicalizeJson({ ...snapshot, signature });
  if (encoder.encode(wire).length > wireLimit(protocol)) throw new Error('Invalid room packet request');
  return wire;
}
/** Local signing helpers, never remote signing oracles. Inputs are snapshotted before await. */
export const signRoomPacket = (request: RoomPacketWrite, privateKey: string): Promise<string> =>
  sign(request, privateKey, ROOM_PACKET_PROTOCOL);
export const signRoomPacketRead = (request: RoomPacketRead, privateKey: string): Promise<string> =>
  sign(request, privateKey, ROOM_PACKET_READ_PROTOCOL);
export const signRoomPacketRecovery = (request: RoomPacketRecovery, privateKey: string): Promise<string> =>
  sign(request, privateKey, ROOM_PACKET_RECOVERY_PROTOCOL);

function parse<T extends Request>(wire: string, hub: string, protocol: T['protocol']): { ok: true; proof: Proof<T> } | Failure {
  if (!hubOrigin(hub)) return fail('invalid_context');
  const limit = wireLimit(protocol);
  if (typeof wire !== 'string' || wire.length > limit || encoder.encode(wire).length > limit) return fail('invalid_wire');
  let proof: unknown;
  try { proof = JSON.parse(wire); } catch { return fail('invalid_wire'); }
  if (!validProof(proof, protocol)) return fail('invalid_schema');
  if (canonicalizeJson(proof) !== wire) return fail('noncanonical_wire');
  if (proof.hub !== hub) return fail('wrong_hub');
  // Private callers pair T with a fixed protocol; validProof checked that exact schema.
  return { ok: true, proof: proof as unknown as Proof<T> };
}
async function authenticate<T extends Request>(proof: Proof<T>): Promise<VerifiedRoomPacketSignature<T> | Failure> {
  const { signature, ...fields } = proof;
  const request = Object.freeze(fields) as unknown as Readonly<T>;
  if (await deriveAgentId(request.signingPublicKey) !== request.actor) return fail('identity_mismatch');
  const bytes = signString(request);
  try {
    const key = await importEdPublicKey(request.signingPublicKey);
    if (!await crypto.subtle.verify('Ed25519', key, hexToBytes(signature) as BufferSource,
      encoder.encode(bytes))) return fail('invalid_signature');
  } catch { return fail('invalid_signature'); }
  return Object.freeze({ ok: true, request, proofDigest: await sha256Hex(bytes) });
}
function freshness(request: Pick<CommonRequest, 'issuedAt' | 'expiresAt'>, now: number): RoomPacketProofError | null {
  if (!integer(now)) return 'invalid_context';
  if (now >= request.expiresAt) return 'expired_proof';
  if (request.issuedAt > now + ROOM_PACKET_LIMITS.futureSkewMs) return 'future_proof';
  return null;
}
async function prepare<T extends Request>(wire: string, context: { hub: string; now: number }, protocol: T['protocol']):
Promise<PreparedRoomPacket<T> | Failure> {
  const { hub, now } = context;
  if (!integer(now)) return fail('invalid_context');
  const parsed = parse<T>(wire, hub, protocol);
  if (!parsed.ok) return parsed;
  const stale = freshness(parsed.proof, now);
  if (stale) return fail(stale);
  const result = await authenticate(parsed.proof);
  if (!result.ok) return result;
  return Object.freeze({ ...result, freshness: (time: number) => freshness(result.request, time) });
}
/** NOT authority. Future stores must accept raw wire and reverify internally, not accept this object. */
export const prepareRoomPacket = (wire: string, context: { hub: string; now: number }) =>
  prepare<RoomPacketWrite>(wire, context, ROOM_PACKET_PROTOCOL);
export const prepareRoomPacketRead = (wire: string, context: { hub: string; now: number }) =>
  prepare<RoomPacketRead>(wire, context, ROOM_PACKET_READ_PROTOCOL);
export const prepareRoomPacketRecovery = (wire: string, context: { hub: string; now: number }) =>
  prepare<RoomPacketRecovery>(wire, context, ROOM_PACKET_RECOVERY_PROTOCOL);

/**
 * Verify a stored sender signature after its admission proof expires. No freshness,
 * room membership, peer pin, delivery, decryption or execution assurance. NEVER use
 * this historical helper to authorize a read/write/recovery operation.
 */
export async function verifyHistoricalRoomPacketSignature(wire: string, hub: string):
Promise<VerifiedRoomPacketSignature<RoomPacketWrite> | Failure> {
  const parsed = parse<RoomPacketWrite>(wire, hub, ROOM_PACKET_PROTOCOL);
  return parsed.ok ? authenticate(parsed.proof) : parsed;
}
