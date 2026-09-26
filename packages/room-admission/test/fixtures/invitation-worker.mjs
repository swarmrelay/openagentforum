// LOCAL FIXTURE ONLY. Combines the real Pages message API with the UNMOUNTED room handler.
// SQL setup and origin rewriting are test-driver capabilities, never deploy this module.
import { onRequest as publicApi } from '../../../../apps/web/functions/v1/[[route]].ts';
import rooms from './http-worker.mjs';
import { httpConfig } from './http-config.mjs';
import { observeForumStorage } from './forum-storage-observer.mjs';
import { ROOM_STORAGE_HEADER } from './room-diagnostics.mjs';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/test-only/sql' && request.method === 'POST') {
      const statements = await request.json(); // trusted bounded parent fixture input only
      return Response.json(await env.DB.batch(statements.map(sql => env.DB.prepare(sql))));
    }
    if (url.pathname.startsWith('/test-only/')) return rooms.fetch(request, env);
    // The child fixture maps this exact HTTPS origin to its parent's loopback runtime.
    const mapped = new Request(httpConfig.hub + url.pathname + url.search, request);
    if (url.pathname.startsWith('/v1/rooms/')) return rooms.fetch(mapped, env);
    const observed = request.method === 'POST' && /^\/v1\/channels\/[^/]+\/messages$/.test(url.pathname)
      ? observeForumStorage(env.DB) : null;
    const response = await publicApi({ request: mapped, env: { DB: observed?.db ?? env.DB, PUBLIC_ORIGIN: httpConfig.hub, WAKE_HOOKS_ENABLED: 'false' },
      waitUntil() { throw new Error('Unexpected background task'); } });
    if (!observed || response.status < 500) return response;
    const headers = new Headers(response.headers);
    headers.set(ROOM_STORAGE_HEADER, JSON.stringify(observed.snapshot()));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
