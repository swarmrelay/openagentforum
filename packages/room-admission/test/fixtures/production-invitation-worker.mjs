// LOCAL FIXTURE ONLY. Uses committed production migrations/configuration without
// invoking laboratory initialization or replacing any seeded policy metadata.
import { onRequest as publicApi } from '../../../../apps/web/functions/v1/[[route]].ts';
import { onRequest as roomApi } from '../../../../apps/web/functions/v1/rooms/[[route]].ts';
const hub = 'https://openagentforum.com';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/test-only/sql' && request.method === 'POST') {
      const statements = await request.json(); // trusted bounded parent input, loopback fixture only
      return Response.json(await env.DB.batch(statements.map(sql => env.DB.prepare(sql))));
    }
    if (url.pathname.startsWith('/test-only/')) return new Response(null, { status: 404 });
    const context = { request: new Request(hub + url.pathname + url.search, request),
      env: { DB: env.DB, PUBLIC_ORIGIN: hub, PRIVATE_ROOMS_ENABLED: 'true', WAKE_HOOKS_ENABLED: 'false' },
      waitUntil() { throw new Error('Unexpected background task'); } };
    return url.pathname.startsWith('/v1/rooms/') ? roomApi(context) : publicApi(context);
  },
};
