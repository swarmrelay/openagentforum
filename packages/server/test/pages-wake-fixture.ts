import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import { bytesToHex, deriveHookId, generateAgentKeyPair, signEnvelope, signHookAction, type HookSpec } from '@openagentforum/protocol';
import { onRequest } from '../../../apps/web/functions/v1/[[route]].js';
import { onRequest as controlRoute } from '../../../apps/web/functions/internal/wake-control.js';
import type { HubEnv } from '../../../apps/web/functions/_lib/wake.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export const HUB = 'https://openagentforum.com';
export const random = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
export async function pagesWakeFixture() {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../../../apps/web/migrations/', import.meta.url);
  for (const name of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  const stmt = (sql: string, args: SQLInputValue[] = []): D1PreparedStatement => ({
    bind: (...values: SQLInputValue[]) => stmt(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  } as D1PreparedStatement);
  const env = { DB: { prepare: (sql: string) => stmt(sql) } as D1Database,
    PUBLIC_ORIGIN: HUB, WAKE_HOOKS_ENABLED: 'true', WAKE_HOOK_KEY: random(), WAKE_CONTROL_TOKEN: random() };
  const dispatch = (request: Request, bindings: HubEnv = env) => {
    const handler = new URL(request.url).pathname.startsWith('/internal/') ? controlRoute : onRequest;
    return Promise.resolve(handler({ request, env: bindings, waitUntil: () => {} } as Parameters<typeof handler>[0]));
  };
  const send = (path: string, value?: unknown, method = 'POST', headers: Record<string, string> = {}) => dispatch(new Request(HUB + path,
    { method, headers: { 'content-type': 'application/json', ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }));
  const owner = await generateAgentKeyPair();
  const sender = await generateAgentKeyPair();
  for (const keys of [owner, sender]) await send('/v1/agents/register', { publicKey: keys.signingPublicKey });
  const spec: HookSpec = { url: 'https://receiver.example.net/wake', secret: random(), channels: ['general'] };
  let proofTime = Date.now();
  const set = async (hook = spec) => {
    const input = { action: 'set' as const, agentId: owner.agentId, hookId: await deriveHookId(owner.agentId, hook.url), hook, timestamp: ++proofTime };
    return send(`/v1/agents/${owner.agentId}/hooks`, { hook, timestamp: input.timestamp, signature: await signHookAction(input, owner.signingPrivateKey) });
  };
  const mutate = async (action: 'delete' | 'renew') => {
    const input = { action, agentId: owner.agentId, hookId: await deriveHookId(owner.agentId, spec.url), timestamp: ++proofTime };
    return send(`/v1/agents/${owner.agentId}/hooks/${input.hookId}${action === 'renew' ? '/renew' : ''}`,
      { timestamp: input.timestamp, signature: await signHookAction(input, owner.signingPrivateKey) }, action === 'delete' ? 'DELETE' : 'POST');
  };
  const list = async () => {
    const input = { action: 'list' as const, agentId: owner.agentId, timestamp: Date.now() };
    return send(`/v1/agents/${owner.agentId}/hooks`, undefined, 'GET', {
      'x-agent-timestamp': String(input.timestamp), 'x-agent-signature': await signHookAction(input, owner.signingPrivateKey),
    });
  };
  const control = (value: unknown, token = env.WAKE_CONTROL_TOKEN) => send('/internal/wake-control', value, 'POST', { authorization: `Bearer ${token}` });
  const post = async (payload: unknown = { message: 'hello' }, channel = 'general') => {
    const envelope = await signEnvelope({ channel, sender: sender.agentId, type: 'intel', sequence: 17, payload }, sender.signingPrivateKey);
    return { envelope, response: await send(`/v1/channels/${channel}/messages`, envelope) };
  };
  return { db, env, owner, sender, spec, dispatch, send, set, mutate, list, control, post, close: () => db.close() };
}
