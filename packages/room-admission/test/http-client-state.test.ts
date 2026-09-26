import { deriveAgentId, generateAgentKeyPair } from '@openagentforum/protocol';
import { expect, it, vi } from 'vitest';
import { RoomHttpClient } from '../src/http-client.js';
import { ROOM_STATE_PROTOCOL, signRoomState, type RoomStateQuery } from '../src/state-read.js';

async function stateResponse(patch: Record<string, unknown> = {}, unavailable = false) {
  const hub = 'https://relay.example.com', keys = await generateAgentKeyPair(), now = Date.now();
  const query: RoomStateQuery = { protocol: ROOM_STATE_PROTOCOL, hub, actor: await deriveAgentId(keys.signingPublicKey),
    roomId: 'room_' + '1'.repeat(32), queryId: '2'.repeat(32), issuedAt: now, expiresAt: now + 60000 };
  const room = unavailable ? null : { roomId: query.roomId, revision: 3, status: 'open', role: 'owner', ...patch };
  const result = { ok: true, queryId: query.queryId, observedAt: now, room };
  const fetcher = vi.fn(async () => Response.json(result));
  const client = new RoomHttpClient({ hub, fetch: fetcher });
  const wire = await signRoomState(query, keys.signingPrivateKey);
  return { read: () => client.readState(wire, keys.signingPublicKey), fetcher, result };
}

it.each([
  ['open', 'owner'], ['open', 'peer'], ['closed', 'owner'], ['closed', 'peer'],
])('returns exact %s/%s state strings unchanged', async (status, role) => {
  const s = await stateResponse({ status, role });
  expect(await s.read()).toEqual(s.result);
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});

it('preserves unavailable state as null without retrying', async () => {
  const s = await stateResponse({}, true);
  expect(await s.read()).toEqual(s.result);
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  { status: ['open'] }, { status: ['closed'] }, { status: [['open']] },
  { role: ['owner'] }, { role: ['peer'] }, { role: [['peer']] },
  { status: null }, { role: null }, { status: {} }, { role: {} },
  { status: 1 }, { role: true }, { status: 'OPEN' }, { role: 'member' },
])('rejects non-contract state fields without coercion or retry: %j', async patch => {
  const s = await stateResponse(patch);
  await expect(s.read()).rejects.toMatchObject({ status: 200, code: 'room_invalid_response',
    permitsReplacementMutation: false });
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
