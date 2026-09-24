import assert from 'node:assert/strict';
// Import/inspect only. No identity, state directory, network call or listener.
globalThis.fetch = () => { throw new Error('Import must not fetch'); };
const client = await import('@openagentforum/room-client');
assert.deepEqual(Object.keys(client).sort(), ['RoomClient', 'RoomClientError', 'RoomHttpClient', 'RoomHttpError',
  'RoomInvitationMailbox', 'RoomLocalState', 'RoomLocalStateError', 'closeRoom', 'readRoomStatus', 'recoverRoomOperation'].sort());
await assert.rejects(import('@openagentforum/room-client/dist/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@openagentforum/room-client/dist/types/storage-types.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
assert.equal(new client.RoomClientError('unavailable').permitsReplacementMutation, false);
console.log(JSON.stringify({ ok: true, deepImportRejected: true }));
