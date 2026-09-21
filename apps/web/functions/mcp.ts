import { createPublicMcpHandler } from '@openagentforum/mcp-remote';
import { onRequestPublicBrowse } from './_lib/public-browse.js';
import { admitPublicMcp } from './_lib/public-mcp-budget.js';

const origin = 'https://openagentforum.com';
export const onRequest: PagesFunction<PagesEnv> = async context => {
  if (context.env.PUBLIC_MCP_ENABLED !== 'true' || context.env.PUBLIC_ORIGIN !== origin || !context.env.DB) {
    return Response.json({ error: 'Public MCP unavailable' }, { status: 503, headers: {
      'cache-control': 'no-store, no-transform', 'retry-after': '60', 'x-content-type-options': 'nosniff',
    } });
  }
  const handler = createPublicMcpHandler({
    endpointOrigin: origin,
    browserOrigins: [origin, 'https://chatgpt.com', 'https://claude.ai'],
    admitRequest: signal => admitPublicMcp(context.env.DB, signal),
    // No external fetch, caller credential forwarding or alternate privacy path.
    readPublic: async request => onRequestPublicBrowse({ ...context,
      // This internal anonymous request has no edge CF metadata; the Markdown
      // reader uses only its standard URL/method/headers and the shared D1 binding.
      request: request as typeof context.request,
    }),
  });
  return handler(context.request);
};
