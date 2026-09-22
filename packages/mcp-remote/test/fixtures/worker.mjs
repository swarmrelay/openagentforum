// Local test entry only. This imports a SQL fixture: never mount or deploy it.
import { onRequestPublicBrowse } from '../../../../apps/web/functions/_lib/public-browse.ts';
import { createPublicMcpHandler } from '../../src/index.js';
import { onRequest as pagesMcp } from '../../../../apps/web/functions/mcp.ts';

export default {
  async fetch(request, env) {
    if (new URL(request.url).hostname === 'fixture.invalid' && new URL(request.url).pathname === '/sql') {
      const statements = await request.json();
      return Response.json(await env.DB.batch(statements.map(({ sql, args = [] }) => env.DB.prepare(sql).bind(...args))));
    }
    // Miniflare preserves the target URL but rewrites Host to its loopback proxy.
    // Reconstruct the test edge header here, never in the production handler.
    request = new Request(request);
    request.headers.set('host', request.headers.get('x-fixture-host') ?? new URL(request.url).host);
    // The local proxy rejects foreign Origin before dispatch. Simulate the edge
    // value only in this fixture, after that proxy, so the real handler checks it.
    if (request.headers.has('x-fixture-browser-origin')) request.headers.set('origin', request.headers.get('x-fixture-browser-origin'));
    if (new URL(request.url).origin === 'https://openagentforum.com') {
      return pagesMcp({ request, env: { ...env,
        PUBLIC_ORIGIN: request.headers.get('x-fixture-origin') ?? 'https://openagentforum.com',
        PUBLIC_MCP_ENABLED: request.headers.get('x-fixture-enabled') ?? 'true',
      }, waitUntil() { throw new Error('No background work'); } });
    }
    let cancelled = false, stream;
    if (request.headers.get('x-fixture-input') === 'stalled') {
      stream = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
      request = new Request(request.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream });
    }
    const handler = createPublicMcpHandler({
      endpointOrigin: 'https://connector.example',
      readPublic: req => onRequestPublicBrowse({ request: req, env: { DB: {
        prepare(sql) {
          if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Mutation during public read');
          return env.DB.prepare(sql);
        },
        batch: statements => env.DB.batch(statements),
      } }, waitUntil() { throw new Error('No background work'); } }),
    });
    const response = await handler(request);
    if (stream) {
      response.headers.set('x-fixture-cancelled', String(cancelled));
      response.headers.set('x-fixture-locked', String(stream.locked));
    }
    return response;
  },
};
