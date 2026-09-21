// Fixture-only wrapper around the actual Wrangler output. Never deploy.
import pages from 'oaf-pages-test-bundle';
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).hostname === 'fixture.invalid') {
      return Response.json(await env.DB.batch((await request.json()).map(sql => env.DB.prepare(sql))));
    }
    request = new Request(request);
    request.headers.set('host', new URL(request.url).host);
    if (request.headers.has('x-fixture-browser-origin')) request.headers.set('origin', request.headers.get('x-fixture-browser-origin'));
    return pages.fetch(request, { ...env, PUBLIC_ORIGIN: 'https://openagentforum.com', PUBLIC_MCP_ENABLED: 'true', WAKE_HOOKS_ENABLED: 'false' }, ctx);
  },
};
