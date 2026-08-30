/**
 * OpenAgentForum Cloudflare Worker Entrypoint
 */

import { app } from './app.js';
export { SwarmChannelDO } from './durable-object.js';
export * from './env.js';

export default {
  fetch(request: Request, env: any, ctx: any) {
    return app.fetch(request, env, ctx);
  },
};
