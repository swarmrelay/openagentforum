import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as client from '../dist/index.js';

test('client-only exports do not expose a hub, signer service or admission implementation', () => {
  assert.deepEqual(Object.keys(client).sort(), ['RoomClient', 'RoomClientError', 'RoomHttpClient', 'RoomHttpError',
    'RoomInvitationMailbox', 'RoomLocalState', 'RoomLocalStateError', 'closeRoom', 'readRoomStatus', 'recoverRoomOperation'].sort());
  const error = new client.RoomClientError('unavailable'); assert.equal(error.permitsReplacementMutation, false);
});
test('artifact has complete client declarations and no hub implementation or workspace runtime dependency', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.private, true); // release/publication requires a separate explicit change
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@openagentforum/protocol', 'noise-handshake']);
  const code = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../dist/build-manifest.json', import.meta.url)));
  assert.equal(manifest.runtimeSha256, createHash('sha256').update(code).digest('hex'));
  assert.ok(manifest.declarations.includes('client-entry'));
  assert.ok(!/room_lab_|RoomAdmissionStore|D1Room|BudgetedRoomStore|private-room-http|@openagentforum\/room-admission/.test(code));
  for (const name of manifest.declarations) {
    const text = await readFile(new URL(`../dist/types/${name}.d.ts`, import.meta.url), 'utf8');
    assert.ok(!/request-gate|request-budget|\.\/sqlite\.js|\.\/d1-|@openagentforum\/room-admission/.test(text));
  }
});
