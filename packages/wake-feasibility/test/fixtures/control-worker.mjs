// LOCAL TEST FIXTURE ONLY. Not a deployable Worker; test routes initialize temporary state.
import { createHookControlHandler, d1HookControlAdmission, HOOK_CONTROL_SCHEMA } from '../../../server/src/hooks/control.ts';
import { HookManager } from '../../../server/src/hooks/manager.ts';
import { d1HookStateStore, HOOK_STATE_SCHEMA } from '../../../server/src/hooks/storage.ts';
import { bytesToHex, generateAgentKeyPair, deriveHookId, signHookAction } from '@openagentforum/protocol';

const hub = 'https://openagentforum.com';
const endpoint = 'https://control.example.net/internal/wake-control';
const random = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname;
    if (!scenario.startsWith('/test-only/')) return new Response(null, { status: 404 });
    // Explicit, temporary test setup; the real handler never applies migrations.
    for (const sql of (HOOK_STATE_SCHEMA + HOOK_CONTROL_SCHEMA).split(';').filter(s => s.trim())) await env.DB.prepare(sql).run();
    await env.DB.prepare('DELETE FROM wake_hook_state').run();
    await env.DB.prepare('DELETE FROM wake_hook_control_admission').run();
    const token = random();
    const owner = await generateAgentKeyPair();
    const store = d1HookStateStore(env.DB);
    const manager = await HookManager.create({ hub, encryptionKey: random(), store,
      publicKey: async id => id === owner.agentId ? owner.signingPublicKey : null,
      channelAccess: async () => ({ isPrivate: false, isMember: false }),
    });
    const handler = await createHookControlHandler({ endpoint, hub, token, manager, store, admission: d1HookControlAdmission(env.DB) });
    const call = (value, credential = token) => handler(new Request(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
    }));
    if (scenario === '/test-only/auth') {
      const denied = await call({ op: 'poll', after: null }, random());
      const before = await env.DB.prepare('SELECT COUNT(*) AS count FROM wake_hook_control_admission').first();
      const accepted = await call({ op: 'poll', after: null });
      return Response.json({ denied: denied.status, before: before.count, accepted: accepted.status, body: await accepted.json() });
    }
    if (scenario === '/test-only/admission') {
      const gates = [d1HookControlAdmission(env.DB), d1HookControlAdmission(env.DB)];
      const now = Date.now();
      const results = await Promise.all(Array.from({ length: 24 }, (_, i) => gates[i % 2].admit(now)));
      const rollback = await gates[0].admit(now - 1000);
      const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM wake_hook_control_admission').first();
      return Response.json({ admitted: results.filter(Boolean).length, rollback, rows: count.count });
    }
    if (scenario === '/test-only/lifecycle') {
      const hook = { url: 'https://receiver.example.net/wake', secret: random(), channels: ['general'] };
      const hookId = await deriveHookId(owner.agentId, hook.url);
      const input = { action: 'set', agentId: owner.agentId, hookId, timestamp: Date.now(), hook };
      await manager.mutate({ ...input, signature: await signHookAction(input, owner.signingPrivateKey) });
      const polled = await (await call({ op: 'poll', after: null })).json();
      const authorized = await (await call({ op: 'authorize', ref: polled.ref })).json();
      const result = { ok: true, code: 'verified', retryable: false, status: 200 };
      const first = await (await call({ op: 'complete', ref: polled.ref, result })).json();
      const replay = await (await call({ op: 'complete', ref: polled.ref, result })).json();
      const expired = await (await call({ op: 'authorize', ref: polled.ref })).json();
      return Response.json({ refKeys: Object.keys(polled.ref).sort(), authorized: authorized.job?.jobId === polled.ref.jobId,
        sameAck: JSON.stringify(first) === JSON.stringify(replay), afterCompletion: expired, secretInPoll: JSON.stringify(polled).includes(hook.secret) });
    }
    return new Response(null, { status: 404 });
  },
};
