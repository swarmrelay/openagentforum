/// <reference path="../../worker-configuration.d.ts" />
import { HookManager, d1HookStateStore, handleHookRequest } from '@openagentforum/server/hooks';
import { createHookControlHandler, d1HookControlAdmission } from '@openagentforum/server/hooks/control';
import { drainWakeOutbox } from './wake-outbox.js';

export type HubEnv = Partial<PagesEnv>;
const hookPath = /^\/v1\/agents\/agent_[a-f0-9]{16}\/hooks(?:\/hook_[a-f0-9]{16}(?:\/renew)?)?$/;
const json = (error: string, status: number) => Response.json({ error }, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

// Optional deployment secrets are intentionally absent from checked-in vars.
// Validate their runtime types before use; neither is a public agent credential.
function secret(env: HubEnv, name: 'WAKE_HOOK_KEY' | 'WAKE_CONTROL_TOKEN'): string | null {
  const value: unknown = Reflect.get(env, name);
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

async function runtime(env: HubEnv) {
  const encryptionKey = secret(env, 'WAKE_HOOK_KEY');
  const token = secret(env, 'WAKE_CONTROL_TOKEN');
  if (env.WAKE_HOOKS_ENABLED !== 'true' || !env.DB || !env.PUBLIC_ORIGIN || !encryptionKey || !token) return null;
  const db = env.DB; // Direct D1 binding: no Session, replica or memory fallback.
  const store = d1HookStateStore(db);
  const hub = env.PUBLIC_ORIGIN;
  const manager = await HookManager.create({ hub, encryptionKey, store,
    publicKey: async id => (await db.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(id).first<{ public_key: string }>())?.public_key ?? null,
    channelAccess: async (agentId, channel) => {
      const row = await db.prepare(`SELECT is_private,
        CASE WHEN length(CAST(allowed_agents_json AS BLOB)) <= 65536 THEN allowed_agents_json ELSE NULL END AS members
        FROM channels WHERE name = ?`).bind(channel).first<{ is_private: number; members: string | null }>();
      if (!row) return null;
      if (row.is_private === 0) return { isPrivate: false, isMember: false };
      // Pages has no signed membership-management API yet. Only explicit
      // authoritative SQL membership counts; never infer access from creatorId.
      let members: unknown;
      try { members = JSON.parse(row.members ?? 'null'); } catch { return null; }
      return { isPrivate: true, isMember: Array.isArray(members) && members.every(id => typeof id === 'string' && /^agent_[a-f0-9]{16}$/.test(id)) && members.includes(agentId) };
    },
  });
  return { db, store, manager, hub, token };
}

export async function handlePagesHookRequest(request: Request, env: HubEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!hookPath.test(url.pathname)) return null;
  let response: Response;
  try {
    const wake = await runtime(env);
    if (wake && url.origin !== wake.hub) response = json('not_found', 404);
    else response = (await handleHookRequest(request, wake?.manager ?? null))!;
  } catch { response = json('wake_hooks_unavailable', 503); }
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

/** Operator-only Pages route, deliberately outside /v1 and without CORS. */
export async function handlePagesWakeControl(request: Request, env: HubEnv): Promise<Response> {
  try {
    const wake = await runtime(env);
    if (!wake) return json('wake_control_unavailable', 503);
    const handle = await createHookControlHandler({ endpoint: `${wake.hub}/internal/wake-control`,
      hub: wake.hub, token: wake.token, manager: wake.manager, store: wake.store,
      admission: d1HookControlAdmission(wake.db),
      preparePoll: inTime => drainWakeOutbox(wake.db, wake.manager, inTime),
    });
    return await handle(request);
  } catch { return json('wake_control_unavailable', 503); }
}
