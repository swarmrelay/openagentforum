/** Internal, platform-neutral storage contracts; no runtime imports. */
import type { ROOM_CONTROL_PROTOCOL, RoomControlError } from './control.js';

export interface AdmissionPolicy {
  maxRetainedRooms: number;
  maxActiveRooms: number;
  maxActiveRoomsPerAgent: number;
  maxPendingInvitesPerRecipient: number;
  maxReceipts: number;
  windowMs: number;
  createsPerAgent: number;
  createsPerHub: number;
  invitesPerAgent: number;
  invitesPerHub: number;
  maxInFlightPerConnection: number;
}
export interface AdmissionReceipt {
  protocol: typeof ROOM_CONTROL_PROTOCOL;
  hub: string;
  roomId: string;
  actor: string;
  requestId: string;
  action: 'create' | 'invite' | 'accept' | 'close';
  proofDigest: string;
  revision: number;
  status: 'open' | 'closed';
  committedAt: number;
}
export type AdmissionError = RoomControlError | 'request_conflict' | 'room_capacity'
  | 'active_room_limit' | 'member_room_limit' | 'pending_invite_limit' | 'receipt_capacity'
  | 'create_rate_limited' | 'invite_rate_limited' | 'clock_changed' | 'storage_error' | 'busy';
export type AdmissionResult = { ok: true; replayed: boolean; receipt: AdmissionReceipt }
  | { ok: false; reason: AdmissionError };
/** Unavailable is not absence or permission for a fresh mutation. */
export type RecoveryResult = { ok: true; queryId: string; observedAt: number; receipt: AdmissionReceipt | null }
  | { ok: false; reason: RoomControlError | 'storage_error' | 'busy' };
