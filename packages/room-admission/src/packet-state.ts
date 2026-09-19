/** Edge-safe storage proposals, never authority outside a protected primary boundary. */
import { canonicalizeJson } from '@openagentforum/protocol';
import type { RoomState } from './control.js';
import { ROOM_STATE_PROTOCOL, roomStateView } from './state-read.js';
import type { RoomPacketWrite, RoomPacketRead } from './packet-wire.js';
import { ROOM_PACKET_STORAGE_LIMITS } from './packet-storage-contract.js';

export type PacketSession = { room_id: string; session_id: string; revision: number; owner_key: string; peer_key: string;
  created_at: number; stage: number; owner_next: number; peer_next: number };
export function packetMembership(raw: unknown, request: Readonly<RoomPacketWrite | RoomPacketRead>) {
  const view = roomStateView(raw, { ...request, protocol: ROOM_STATE_PROTOCOL, queryId: '0'.repeat(32) }, request.signingPublicKey);
  if (!view || view.status !== 'open' || view.revision !== request.expectedRevision) return null;
  const room = JSON.parse(raw as string) as RoomState; // Bounded/canonical/full-key validated above.
  return room.peer ? { room, role: view.role } : null;
}

/** The store must bind both supplied snapshots to its write transaction (D1 uses exact CAS). */
export function packetSessionProposal(r: Readonly<RoomPacketWrite>, rawRoom: unknown, rawSession: unknown, now: number) {
  const membership = packetMembership(rawRoom, r);
  if (!membership) return null;
  const { room, role } = membership;
  let old: PacketSession | null = null;
  if (rawSession !== null) {
    if (typeof rawSession !== 'string' || rawSession.length > 1024) throw new Error('Invalid packet session');
    const s = JSON.parse(rawSession) as PacketSession;
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).length !== 9
        || s.room_id !== r.roomId || s.session_id !== r.sessionId
        || s.revision !== room.revision || s.owner_key !== room.owner.signingPublicKey || s.peer_key !== room.peer!.signingPublicKey
        || !Number.isSafeInteger(s.created_at) || s.created_at < 0 || s.created_at > now
        || !Number.isSafeInteger(s.stage) || s.stage < 1 || s.stage > 4
        || !Number.isSafeInteger(s.owner_next) || s.owner_next < 1 || s.owner_next > 1026
        || !Number.isSafeInteger(s.peer_next) || s.peer_next < 0 || s.peer_next > 1026
        || (s.stage === 1 && (s.owner_next !== 1 || s.peer_next !== 0))
        || (s.stage === 2 && (s.owner_next !== 1 || s.peer_next !== 1))
        || (s.stage === 3 && (s.owner_next !== 2 || s.peer_next !== 1))
        || (s.stage === 4 && (s.owner_next < 2 || s.peer_next < 2))
        || canonicalizeJson(s) !== rawSession) throw new Error('Invalid packet session');
    old = s;
  }
  const next: PacketSession = old ? { ...old } : { room_id: r.roomId, session_id: r.sessionId, revision: room.revision,
    owner_key: room.owner.signingPublicKey, peer_key: room.peer!.signingPublicKey,
    created_at: now, stage: 1, owner_next: 1, peer_next: 0 };
  const lifetime = old?.stage === 4 ? ROOM_PACKET_STORAGE_LIMITS.sessionLifetimeMs : ROOM_PACKET_STORAGE_LIMITS.handshakeLifetimeMs;
  if (next.created_at > Number.MAX_SAFE_INTEGER - ROOM_PACKET_STORAGE_LIMITS.sessionLifetimeMs) return null;
  const validUntil = next.created_at + lifetime;
  if (now >= validUntil) return null;
  if (!old) {
    if (role !== 'owner' || r.kind !== 'handshake' || r.packetIndex !== 0 || r.packetHex.length !== 192) return null;
  } else if (next.stage < 4) {
    if (role !== (next.stage === 2 ? 'owner' : 'peer') || r.packetIndex !== (next.stage === 1 ? 0 : 1)
        || r.kind !== (next.stage === 1 ? 'handshake' : 'confirmation')
        || r.packetHex.length !== (next.stage === 1 ? 96 : 34)) return null;
    next.stage++;
    if (role === 'owner') next.owner_next++; else next.peer_next++;
  } else {
    if (r.kind !== 'data' || r.packetIndex !== (role === 'owner' ? next.owner_next : next.peer_next)) return null;
    if (role === 'owner') next.owner_next++; else next.peer_next++;
  }
  return { next, validUntil, newSession: !old };
}
