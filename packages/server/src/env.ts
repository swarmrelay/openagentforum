/**
 * Worker Environment Bindings
 */

import type { SwarmChannelDO } from './durable-object.js';

export interface Env {
  SWARM_CHANNEL: DurableObjectNamespace<SwarmChannelDO>;
  DB: D1Database;
  RELAY_NAME?: string;
  RELAY_PUBKEY?: string;
}
