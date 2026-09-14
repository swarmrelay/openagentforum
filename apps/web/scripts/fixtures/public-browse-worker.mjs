// LOCAL TEST FIXTURE ONLY. Never deploy this SQL driver or its test headers.
import { onRequest } from '../../functions/channels.ts';
import { onRequest as nested } from '../../functions/channels/[[route]].ts';
import { onRequest as api } from '../../functions/v1/[[route]].ts';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (new URL(request.url).hostname === 'fixture.invalid' && path === '/sql' && request.method === 'POST') {
      const statements = await request.json();
      return Response.json(await env.DB.batch(statements.map(({ sql, args = [] }) => env.DB.prepare(sql).bind(...args))));
    }
    if (new URL(request.url).hostname === 'fixture.invalid' && path.startsWith('/v1/')) {
      return api({ request, env: { DB: env.DB, WAKE_HOOKS_ENABLED: 'false' }, waitUntil() { throw new Error('Unexpected background work'); } });
    }
    const queries = [];
    let rowsRead = 0;
    const db = {
      prepare(sql) {
        if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Browse attempted a mutation');
        const query = { sql, args: [] }; queries.push(query);
        if (request.headers.get('x-fixture-db') === 'failure') throw new Error('PRIVATE_STORAGE_ERROR');
        return { bind(...args) { query.args = args; return env.DB.prepare(sql).bind(...args); } };
      },
      async batch(statements) {
        const results = await env.DB.batch(statements);
        rowsRead += results.reduce((total, result) => total + result.meta.rows_read, 0);
        return results;
      },
    };
    let assetRequests = 0;
    const ASSETS = { async fetch(input) {
      const asset = new Request(input);
      assetRequests++;
      if (asset.method !== 'GET' || new URL(asset.url).pathname !== '/channels/' || new URL(asset.url).search || [...asset.headers].length) throw new Error('Caller data forwarded to assets');
      const mode = request.headers.get('x-fixture-assets');
      if (mode === 'failure') throw new Error('PRIVATE_ASSET_ERROR');
      return new Response(mode === 'oversize' ? 'x'.repeat(128 * 1024 + 1) : mode === 'missing' ? '<html>Old template</html>' : env.SHELL_HTML,
        { headers: { 'content-type': mode === 'type' ? 'text/plain' : 'text/html', 'set-cookie': 'fixture-cookie=do-not-forward', etag: 'stale-shell-tag' } });
    } };
    const handler = path === '/channels' || path === '/channels/' ? onRequest : nested;
    const result = await handler({ request, env: { DB: request.headers.get('x-fixture-db') === 'missing' ? undefined : db, ASSETS },
      waitUntil() { throw new Error('Unexpected background work'); }, next() { throw new Error('Unexpected fallback'); } });
    const response = new Response(result.body, result);
    response.headers.set('X-Fixture-Queries', String(queries.length));
    response.headers.set('X-Fixture-Assets', String(assetRequests));
    response.headers.set('X-Fixture-Batch-Rows-Read', String(rowsRead));
    if (request.headers.has('x-fixture-plans')) {
      const plans = await env.DB.batch(queries.map(({ sql, args }) => env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args)));
      response.headers.set('X-Fixture-Plans', JSON.stringify(plans.map(p => p.results.map(r => r.detail))));
    }
    return response;
  },
};
