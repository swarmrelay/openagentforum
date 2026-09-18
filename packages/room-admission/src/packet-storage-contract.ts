/** Internal packet storage contracts. No public API or production policy defaults. */
import { canonicalizeJson } from '@openagentforum/protocol';
import { ROOM_PACKET_PROTOCOL, type RoomPacketProofError, type RoomPacketRecovery } from './packet-wire.js';

export interface RoomPacketScopeLimits {
  packets: number;
  bytes: number;
  sessions: number;
  packetsPerWindow: number;
  bytesPerWindow: number;
  sessionsPerWindow: number;
}
export interface RoomPacketPolicy {
  hub: RoomPacketScopeLimits;
  room: RoomPacketScopeLimits;
  agent: RoomPacketScopeLimits;
  windowMs: number;
}
export const ROOM_PACKET_STORAGE_LIMITS = Object.freeze({
  receiptBytes: 2048, handshakeLifetimeMs: 60_000, sessionLifetimeMs: 300_000,
});
export interface RoomPacketReceipt {
  protocol: typeof ROOM_PACKET_PROTOCOL;
  hub: string;
  roomId: string;
  actor: string;
  signingPublicKey: string;
  requestId: string;
  proofDigest: string;
  revision: number;
  sessionId: string;
  packetIndex: number;
  storedSeq: number;
  committedAt: number;
}
export type RoomPacketFailure = { ok: false; reason: RoomPacketProofError | 'not_configured'
  | 'unavailable' | 'clock_changed' | 'busy' | 'storage_error' };
export type RoomPacketWriteSuccess = { ok: true; replayed: boolean; receipt: RoomPacketReceipt };
export type RoomPacketReadSuccess = { ok: true; queryId: string; observedAt: number;
  page: { records: { storedSeq: number; wire: string }[]; nextStoredSeq: number | null } | null };
export type RoomPacketRecoverySuccess = { ok: true; queryId: string; observedAt: number; receipt: RoomPacketReceipt | null };
export type RoomPacketWriteResult = RoomPacketWriteSuccess | RoomPacketFailure;
export type RoomPacketReadResult = RoomPacketReadSuccess | RoomPacketFailure;
export type RoomPacketRecoveryResult = RoomPacketRecoverySuccess | RoomPacketFailure;
export interface RoomPacketTransaction<T> { result: T | RoomPacketFailure; validUntil?: number }

const encoder = new TextEncoder();
export const packetByteLength = (value: string): number => encoder.encode(value).length;
const fields = ['packets', 'bytes', 'sessions', 'packetsPerWindow', 'bytesPerWindow', 'sessionsPerWindow'] as const;
export function packetPolicySnapshot(policy: RoomPacketPolicy): Readonly<RoomPacketPolicy> {
  if (!policy || Object.keys(policy).length !== 4
      || !['hub', 'room', 'agent', 'windowMs'].every(key => Object.hasOwn(policy, key))
      || !Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1 || policy.windowMs > 86_400_000) {
    throw new Error('Invalid packet policy');
  }
  const scope = (limits: RoomPacketScopeLimits) => {
    if (!limits || Object.keys(limits).length !== fields.length || fields.some(key =>
      !Object.hasOwn(limits, key) || !Number.isSafeInteger(limits[key]) || limits[key] < 1
      || limits[key] > (key === 'bytes' || key === 'bytesPerWindow' ? 1_073_741_824 : 1_000_000))) {
      throw new Error('Invalid packet policy');
    }
    return Object.freeze({ ...limits });
  };
  return Object.freeze({ hub: scope(policy.hub), room: scope(policy.room), agent: scope(policy.agent), windowMs: policy.windowMs });
}

/** Bounded stored receipt validation, not current authority. Never reflects packet bytes. */
export function packetReceipt(raw: unknown, query: Pick<RoomPacketRecovery,
  'hub' | 'roomId' | 'actor' | 'signingPublicKey' | 'requestId' | 'proofDigest'>): RoomPacketReceipt | null {
  if (typeof raw !== 'string' || raw.length > ROOM_PACKET_STORAGE_LIMITS.receiptBytes
      || packetByteLength(raw) > ROOM_PACKET_STORAGE_LIMITS.receiptBytes) throw new Error('Invalid packet receipt');
  const v = JSON.parse(raw) as RoomPacketReceipt;
  const names: (keyof RoomPacketReceipt)[] = ['protocol', 'hub', 'roomId', 'actor', 'signingPublicKey',
    'requestId', 'proofDigest', 'revision', 'sessionId', 'packetIndex', 'storedSeq', 'committedAt'];
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== names.length
      || !names.every(key => Object.hasOwn(v, key)) || v.protocol !== ROOM_PACKET_PROTOCOL
      || v.hub !== query.hub || v.actor !== query.actor || v.signingPublicKey !== query.signingPublicKey
      || v.requestId !== query.requestId || v.proofDigest !== query.proofDigest
      || typeof v.roomId !== 'string' || !/^room_[0-9a-f]{32}$/.test(v.roomId)
      || typeof v.sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(v.sessionId)
      || !Number.isSafeInteger(v.revision) || v.revision < 1
      || !Number.isSafeInteger(v.packetIndex) || v.packetIndex < 0 || v.packetIndex > 1025
      || !Number.isSafeInteger(v.storedSeq) || v.storedSeq < 1
      || !Number.isSafeInteger(v.committedAt) || v.committedAt < 0) throw new Error('Invalid packet receipt');
  if (canonicalizeJson(v) !== raw) throw new Error('Invalid packet receipt');
  return v.roomId === query.roomId ? v : null;
}
