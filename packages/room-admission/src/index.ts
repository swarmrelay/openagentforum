/**
 * Unpublished laboratory surface for the local CLI dogfood. Not a public API,
 * npm package, hub adapter or reusable membership credential.
 */
export {
  ROOM_CONTROL_PROTOCOL, ROOM_CONTROL_LIMITS, deriveRoomId, roomControlSignString,
  signRoomControl, evaluateRoomControl, prepareRoomControl,
  verifyHistoricalRoomControlSignature,
} from './control.js';
export type {
  RoomControlAction, RoomControlProof, RoomMember, RoomState, RoomControlError,
  RoomControlResult, PreparedRoomControl,
} from './control.js';
export { RoomAdmissionStore } from './sqlite.js';
export type {
  AdmissionPolicy, AdmissionReceipt, AdmissionError, AdmissionResult, RecoveryResult,
} from './sqlite.js';
export {
  ROOM_RECOVERY_PROTOCOL, ROOM_RECOVERY_LIMITS, roomRecoverySignString, signRoomRecovery,
  prepareRoomRecovery,
} from './recovery.js';
export type { RoomRecoveryQuery, PreparedRoomRecovery } from './recovery.js';
export { ROOM_NOISE_PROFILE, verifyRoomKeyBindings, roomNoisePrologue } from './key-bindings.js';
export type { RoomKeyBundle, RoomKeyPins, RoomKeyBinding } from './key-bindings.js';
export { createRoomNoiseSession, ROOM_NOISE_LIMITS } from './handshake.js';
export type { RoomNoiseSession, RoomNoiseOptions } from './handshake.js';
