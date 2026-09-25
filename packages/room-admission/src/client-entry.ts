/** Client-only release candidate surface. No hub store, route, listener or automatic operation. */
export { RoomClient, RoomClientError, readRoomStatus, recoverRoomOperation, closeRoom } from './room-client.js';
export type { RoomClientOptions, RoomInvitationDecision, RoomSessionDecision, RoomRecoveryReference } from './room-client.js';
export { RoomLocalState } from './local-state.js';
export type { RoomLocalPolicy, RoomLocalScope } from './local-state.js';
export { RoomLocalStateError } from './local-files.js';
export { RoomHttpClient, RoomHttpError } from './http-client.js';
export { RoomInvitationMailbox } from './invitation-mailbox.js';
export type { UntrustedRoomMessage } from './session-client.js';
