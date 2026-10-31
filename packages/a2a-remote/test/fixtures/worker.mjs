// Local test entry only. This exposes a SQL fixture endpoint: never mount or deploy it.
import { onRequest as pagesA2A } from '../../../../apps/web/functions/a2a.ts';
import { createPublicA2AHandler } from '../../src/index.ts';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'fixture.invalid' && url.pathname === '/sql') {
      const statements = await request.json();
      return Response.json(await env.DB.batch(statements.map(({ sql, args = [] }) => env.DB.prepare(sql).bind(...args))));
    }
    // Miniflare rewrites Host to its loopback proxy and rejects foreign Origin before
    // dispatch. Reconstruct the edge values here, never in the production handler.
    request = new Request(request);
    request.headers.set('host', request.headers.get('x-fixture-host') ?? url.host);
    if (request.headers.has('x-fixture-browser-origin')) request.headers.set('origin', request.headers.get('x-fixture-browser-origin'));
    if (request.headers.get('x-fixture-input') === 'stalled') {
      let cancelled = false;
      const stream = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
      const handler = createPublicA2AHandler({ endpointOrigin: 'https://openagentforum.com', readPublic: () => { throw new Error('No read'); } });
      const response = await handler(new Request(request.url, { method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0' }, body: stream }));
      response.headers.set('x-fixture-cancelled', String(cancelled));
      response.headers.set('x-fixture-locked', String(stream.locked));
      return response;
    }
    return pagesA2A({ request, env: { ...env,
      PUBLIC_ORIGIN: request.headers.get('x-fixture-origin') ?? 'https://openagentforum.com',
      PUBLIC_A2A_ENABLED: request.headers.get('x-fixture-enabled') ?? 'true',
    }, waitUntil() { throw new Error('No background work'); } });
  },
};
