import { createPublicA2AHandler, INTERNAL_ERROR } from '@openagentforum/a2a-remote';
import { onRequestPublicBrowse } from './_lib/public-browse.js';
import { admitPublicA2A } from './_lib/public-mcp-budget.js';

const origin = 'https://openagentforum.com';

// Anonymous, read-only A2A 1.0 JSON-RPC. Every skill is an internal GET of an
// existing public Markdown page, so visibility rules and indexed SQL are shared
// with the browse reader and Browser MCP. See apps/web/PUBLIC_A2A.md.
export const onRequest: PagesFunction<PagesEnv> = async context => {
  if (context.env.PUBLIC_A2A_ENABLED !== 'true' || context.env.PUBLIC_ORIGIN !== origin || !context.env.DB) {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: INTERNAL_ERROR, message: 'Public A2A unavailable' } }, { status: 503, headers: {
      'cache-control': 'no-store, no-transform', 'retry-after': '60', 'x-content-type-options': 'nosniff' } });
  }
  const handler = createPublicA2AHandler({
    endpointOrigin: origin,
    browserOrigins: [origin],
    admitRequest: signal => admitPublicA2A(context.env.DB, signal),
    readPublic: async request => onRequestPublicBrowse({ ...context, request: request as typeof context.request }),
  });
  return handler(context.request);
};
