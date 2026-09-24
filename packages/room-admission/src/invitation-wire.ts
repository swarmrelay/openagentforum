/** Private setup content; historical signatures are not admission or permission to join. */
import { deriveAgentId } from '@openagentforum/protocol';
import { deriveRoomId, verifyHistoricalRoomControlSignature } from './control.js';
import { verifyRoomKeyBindings } from './key-bindings.js';
import { roomHttpOrigin } from './http-contract.js';

export const ROOM_INVITATION_LIMITS = Object.freeze({ envelopeBytes: 32768, plaintextBytes: 14336, lifetimeMs: 60000 });
export interface RoomInvitationScope { hub: string; channel: string }
export interface RoomInvitationIdentity { signingPublicKey: string; signingPrivateKey: string }
export interface RoomInvitationOffer { kind: 'oaf.room.offer.v1'; sessionId: string; create: string; invite: string }
export interface RoomInvitationAcceptance { kind: 'oaf.room.accept.v1'; sessionId: string; create: string; invite: string; accept: string }
export interface RoomSessionOffer { kind: 'oaf.room.session-offer.v1'; sessionId: string; create: string; invite: string; accept: string }
export interface RoomSessionAcceptance { kind: 'oaf.room.session-accept.v1'; sessionId: string; create: string; invite: string; accept: string }
export type RoomInvitation = RoomInvitationOffer | RoomInvitationAcceptance | RoomSessionOffer | RoomSessionAcceptance;
export const isSessionInvitation = (value: RoomInvitation): value is RoomSessionOffer | RoomSessionAcceptance =>
  value.kind === 'oaf.room.session-offer.v1' || value.kind === 'oaf.room.session-accept.v1';
export const isInvitationOffer = (value: RoomInvitation): value is RoomInvitationOffer | RoomSessionOffer =>
  value.kind === 'oaf.room.offer.v1' || value.kind === 'oaf.room.session-offer.v1';
// Accepted bindings may outlive invitation expiry. Fresh setup-key/outer expiry
// still bounds session proposals; this never changes ordinary invitation expiry.
export const invitationExpiry = (value: RoomInvitation): number =>
  isSessionInvitation(value) ? Infinity : JSON.parse(value.invite).payload.inviteExpiresAt;
export class RoomInvitationError extends Error {
  readonly permitsReplacementMutation = false;
  constructor() { super('Private invitation unavailable; preserve retained room requests'); }
}
export function invitationFailure(): never { throw new RoomInvitationError(); }
export function invitationScope(value: RoomInvitationScope): Readonly<RoomInvitationScope> {
  try {
    if (!value || typeof value.channel !== 'string' || !/^room-setup-[0-9a-f]{32}$/.test(value.channel)) invitationFailure();
    return Object.freeze({ hub: roomHttpOrigin(value.hub), channel: value.channel });
  } catch { return invitationFailure(); }
}
export const invitationHex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
export const invitationInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function invitationExact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** Retains original canonical control wires. Does not check current hub state or sign acceptance. */
export async function readRoomInvitation(raw: string, hub: string, owner: string, peer: string): Promise<Readonly<RoomInvitation>> {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > ROOM_INVITATION_LIMITS.plaintextBytes
      || !invitationHex(owner, 64) || !invitationHex(peer, 64) || owner === peer) invitationFailure();
    const value = JSON.parse(raw);
    const session = value?.kind === 'oaf.room.session-offer.v1' || value?.kind === 'oaf.room.session-accept.v1';
    const accepted = value?.kind === 'oaf.room.accept.v1' || session;
    if (!invitationExact(value, ['kind', 'sessionId', 'create', 'invite', ...(accepted ? ['accept'] : [])])
      || (!accepted && value.kind !== 'oaf.room.offer.v1') || !invitationHex(value.sessionId, 32)
      || typeof value.create !== 'string' || typeof value.invite !== 'string'
      || (accepted && typeof value.accept !== 'string')) invitationFailure();
    const [c, i] = await Promise.all([
      verifyHistoricalRoomControlSignature(value.create, owner, hub),
      verifyHistoricalRoomControlSignature(value.invite, owner, hub),
    ]);
    if (!c.ok || !i.ok || c.action.action !== 'create' || i.action.action !== 'invite'
      || c.action.roomId !== i.action.roomId || c.action.requestId === i.action.requestId
      || i.action.expectedRevision < 1 || i.action.expectedRevision >= Number.MAX_SAFE_INTEGER - 1
      || i.action.payload.recipientSigningPublicKey !== peer || i.action.payload.recipient !== await deriveAgentId(peer)
      || c.action.roomId !== await deriveRoomId(hub, c.action.actor, c.action.requestId)) invitationFailure();
    if (accepted) await verifyRoomKeyBindings({ create: value.create, invite: value.invite, accept: value.accept as string },
      { hub, roomId: c.action.roomId, ownerSigningPublicKey: owner, peerSigningPublicKey: peer });
    // The control proofs may be historical, but this handoff may not revive an expired invitation.
    if ((!session && i.action.payload.inviteExpiresAt <= Date.now()) || i.action.issuedAt > Date.now() + 30000
      || c.action.issuedAt > Date.now() + 30000) invitationFailure();
    return Object.freeze(value as unknown as RoomInvitation);
  } catch { return invitationFailure(); }
}
