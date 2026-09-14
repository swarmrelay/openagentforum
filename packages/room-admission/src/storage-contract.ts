/** Edge-safe validation shared by internal storage laboratories. No storage I/O. */
import { ROOM_CONTROL_PROTOCOL } from './control.js';
import type { RoomRecoveryQuery } from './recovery.js';
import type { AdmissionPolicy, AdmissionReceipt } from './storage-types.js';

const POLICY_KEYS: (keyof AdmissionPolicy)[] = [
  'maxRetainedRooms', 'maxActiveRooms', 'maxActiveRoomsPerAgent', 'maxPendingInvitesPerRecipient',
  'maxReceipts', 'windowMs', 'createsPerAgent', 'createsPerHub', 'invitesPerAgent', 'invitesPerHub',
  'maxInFlightPerConnection',
];
export function policySnapshot(policy: AdmissionPolicy): Readonly<AdmissionPolicy> {
  if (!policy || Object.keys(policy).length !== POLICY_KEYS.length || POLICY_KEYS.some(key =>
    !Object.hasOwn(policy, key) || !Number.isSafeInteger(policy[key]) || policy[key] < 1
    || policy[key] > (key === 'windowMs' ? 86_400_000 : 1_000_000))) {
    throw new Error('Invalid admission policy');
  }
  if (policy.maxReceipts < 2 || policy.maxActiveRooms > policy.maxRetainedRooms
      || policy.maxInFlightPerConnection > 64) throw new Error('Invalid admission policy');
  return Object.freeze({ ...policy });
}

export function recoveryReceipt(raw: unknown,
  query: Readonly<Pick<RoomRecoveryQuery, 'hub' | 'actor' | 'roomId' | 'requestId' | 'proofDigest'>>): AdmissionReceipt | null {
  if (typeof raw !== 'string' || raw.length > 1024) throw new Error('Invalid receipt');
  const r: unknown = JSON.parse(raw);
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Invalid receipt');
  const v = r as Record<string, unknown>;
  if (Object.keys(v).length !== 10
      || v.protocol !== ROOM_CONTROL_PROTOCOL || v.hub !== query.hub || v.actor !== query.actor
      || v.requestId !== query.requestId || v.proofDigest !== query.proofDigest
      || typeof v.roomId !== 'string' || !/^room_[0-9a-f]{32}$/.test(v.roomId)
      || (v.action !== 'create' && v.action !== 'invite' && v.action !== 'accept' && v.action !== 'close')
      || (v.status !== 'open' && v.status !== 'closed')
      || typeof v.revision !== 'number' || !Number.isSafeInteger(v.revision) || v.revision < 1
      || typeof v.committedAt !== 'number' || !Number.isSafeInteger(v.committedAt) || v.committedAt < 0) {
    throw new Error('Invalid receipt');
  }
  // A different room is indistinguishable from a missing request/key/digest.
  return v.roomId === query.roomId ? {
    protocol: v.protocol, hub: v.hub, actor: v.actor, requestId: v.requestId,
    proofDigest: v.proofDigest, roomId: v.roomId, action: v.action,
    status: v.status, revision: v.revision, committedAt: v.committedAt,
  } : null;
}
