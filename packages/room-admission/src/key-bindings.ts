/** Historical identity-to-room-key binding, never proof of current admission. */
import { canonicalizeJson } from '@openagentforum/protocol';
import { verifyHistoricalRoomControlSignature, deriveRoomId, type RoomMember } from './control.js';

export const ROOM_NOISE_PROFILE = 'oaf-room-noise-ik-v1-draft1';
export interface RoomKeyBundle { create: string; invite: string; accept: string }
/** These full-key pins come from trusted local policy, NOT the received bundle/directory. */
export interface RoomKeyPins {
  hub: string; roomId: string; ownerSigningPublicKey: string; peerSigningPublicKey: string;
}
export interface RoomKeyBinding {
  profile: typeof ROOM_NOISE_PROFILE;
  hub: string;
  roomId: string;
  owner: Readonly<RoomMember>;
  peer: Readonly<RoomMember>;
  createDigest: string;
  inviteDigest: string;
  acceptDigest: string;
  acceptedRevision: number;
}
function exact(value: unknown, keys: string[]): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key =>
      Object.hasOwn(value, key) && typeof (value as Record<string, unknown>)[key] === 'string');
}
/**
 * Three bounded historical proofs, verified against independently selected full
 * identity keys. Proof expiry is intentionally NOT mutation/read authorization.
 */
export async function verifyRoomKeyBindings(bundle: RoomKeyBundle, pins: RoomKeyPins): Promise<Readonly<RoomKeyBinding>> {
  if (!exact(bundle, ['create', 'invite', 'accept']) || !exact(pins,
    ['hub', 'roomId', 'ownerSigningPublicKey', 'peerSigningPublicKey'])) throw new Error('Invalid room key binding');
  const { create, invite, accept } = bundle;
  const { hub, roomId, ownerSigningPublicKey, peerSigningPublicKey } = pins;
  if (!/^room_[0-9a-f]{32}$/.test(roomId) || !/^[0-9a-f]{64}$/.test(ownerSigningPublicKey)
      || !/^[0-9a-f]{64}$/.test(peerSigningPublicKey) || ownerSigningPublicKey === peerSigningPublicKey) {
    throw new Error('Invalid room key binding');
  }
  const [c, i, a] = await Promise.all([
    verifyHistoricalRoomControlSignature(create, ownerSigningPublicKey, hub),
    verifyHistoricalRoomControlSignature(invite, ownerSigningPublicKey, hub),
    verifyHistoricalRoomControlSignature(accept, peerSigningPublicKey, hub),
  ]);
  if (!c.ok || !i.ok || !a.ok || c.action.action !== 'create' || i.action.action !== 'invite'
      || a.action.action !== 'accept' || [c.action, i.action, a.action].some(action => action.roomId !== roomId)
      || c.action.actor !== i.action.actor || c.action.actor === a.action.actor
      || i.action.payload.recipient !== a.action.actor
      || i.action.payload.recipientSigningPublicKey !== peerSigningPublicKey
      || a.action.payload.invitationDigest !== i.proofDigest
      || c.action.requestId === i.action.requestId || i.action.expectedRevision < 1
      || a.action.expectedRevision !== i.action.expectedRevision + 1
      || a.action.expectedRevision >= Number.MAX_SAFE_INTEGER
      || c.action.payload.encryptionPublicKey === a.action.payload.encryptionPublicKey
      || roomId !== await deriveRoomId(hub, c.action.actor, c.action.requestId)) {
    throw new Error('Invalid room key binding');
  }
  return Object.freeze({
    profile: ROOM_NOISE_PROFILE, hub, roomId,
    owner: Object.freeze({ agentId: c.action.actor, signingPublicKey: ownerSigningPublicKey,
      encryptionPublicKey: c.action.payload.encryptionPublicKey }),
    peer: Object.freeze({ agentId: a.action.actor, signingPublicKey: peerSigningPublicKey,
      encryptionPublicKey: a.action.payload.encryptionPublicKey }),
    createDigest: c.proofDigest, inviteDigest: i.proofDigest, acceptDigest: a.proofDigest,
    acceptedRevision: a.action.expectedRevision + 1,
  });
}
export function roomNoisePrologue(binding: Readonly<RoomKeyBinding>): Buffer {
  return Buffer.from(`${ROOM_NOISE_PROFILE}\n${canonicalizeJson(binding)}`, 'utf8');
}
