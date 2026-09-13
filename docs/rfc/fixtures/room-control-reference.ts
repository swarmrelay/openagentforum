/**
 * Compatibility entry for RFC 0003's offline vectors. The single implementation
 * now lives in the private admission laboratory; no published runtime exports it.
 */
export {
  ROOM_CONTROL_PROTOCOL, ROOM_CONTROL_LIMITS, deriveRoomId, roomControlSignString,
  signRoomControl, evaluateRoomControl,
} from '../../../packages/room-admission/src/control.js';
export type {
  RoomControlAction, RoomControlProof, RoomMember, RoomState, RoomControlError, RoomControlResult,
} from '../../../packages/room-admission/src/control.js';
