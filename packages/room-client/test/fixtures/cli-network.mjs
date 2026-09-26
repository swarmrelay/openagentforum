// Test-only preload. NEVER packed or offered as a runtime TLS/endpoint override.
import { httpConfig } from './http-config.mjs';
const endpoint = process.env.OAF_ROOM_FIXTURE_ENDPOINT;
const parsed = new URL(endpoint);
if (parsed.origin !== endpoint || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('Invalid local fixture');
const nativeFetch = globalThis.fetch;
let drop = process.env.OAF_ROOM_FIXTURE_DROP_DATA === 'true';
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== httpConfig.hub || !url.pathname.startsWith('/v1/')) throw new Error('Fixture refused destination');
  const response = await nativeFetch(endpoint + url.pathname + url.search, { ...init, redirect: 'error' });
  const result = new Response(response.body, response);
  if (drop && url.pathname === '/v1/rooms/packets/write' && JSON.parse(init.body).kind === 'data') {
    drop = false; await result.body?.cancel(); throw new Error('Lost fixture response');
  }
  return result;
};
// A killed parent must not leave its CLI grandchild running. This is fixture IPC,
// not a public listener or a production CLI control channel.
process.on('disconnect', () => process.exit(1));
process.channel?.unref();
