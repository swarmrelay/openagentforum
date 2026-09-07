import { afterEach, describe, expect, it } from 'vitest';
import { signHookAction, type HookSpec } from '@openagentforum/protocol';
import { handleHookRequest } from '../src/hooks/http.js';
import { fixture, HUB } from './hooks-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
async function setup() { const f = await fixture(); cleanup.push(f.close); return f; }
const post = (path: string, input: unknown, method = 'POST') => new Request(`${HUB}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });

describe('shared signed hook management handler (not wired into production)', () => {
  it('returns 501 without a configured manager and ignores unrelated paths', async () => {
    expect(await handleHookRequest(new Request(`${HUB}/v1/status`), null)).toBeNull();
    const response = (await handleHookRequest(new Request(`${HUB}/v1/agents/agent_0123456789abcdef/hooks`), null))!;
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: 'wake_hooks_unavailable', staged: true });
  });

  it('accepts signed set/list/renew/delete, redacts secrets and preserves replay status across JSON reformatting', async () => {
    const f = await setup();
    const path = `/v1/agents/${f.owner.agentId}/hooks`;
    const proof = await f.setProof();
    const payload = { hook: proof.hook, timestamp: proof.timestamp, signature: proof.signature };
    const response = (await handleHookRequest(post(path, payload), f.manager))!;
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const reorder = new Request(`${HUB}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature: proof.signature, timestamp: proof.timestamp, hook: proof.hook }, null, 2) });
    expect((await handleHookRequest(reorder, f.manager))!.status).toBe(200);
    const list = { action: 'list' as const, agentId: f.owner.agentId, timestamp: f.clock.now };
    const read = new Request(`${HUB}${path}`, { headers: { 'X-Agent-Timestamp': String(f.clock.now), 'X-Agent-Signature': await signHookAction(list, f.owner.signingPrivateKey) } });
    const listed = (await handleHookRequest(read, f.manager))!;
    expect(listed.status).toBe(200);
    expect(await listed.text()).not.toContain(proof.hook!.secret);
    f.clock.now++;
    const renew = await f.proof('renew', proof.hookId);
    const renewal = { timestamp: renew.timestamp, signature: renew.signature };
    expect((await handleHookRequest(post(`${path}/${proof.hookId}/renew`, renewal), f.manager))!.status).toBe(202);
    expect((await handleHookRequest(post(`${path}/${proof.hookId}/renew`, renewal), f.manager))!.status).toBe(200);
    f.clock.now++;
    const deletion = await f.proof('delete', proof.hookId);
    expect((await handleHookRequest(post(`${path}/${proof.hookId}`, { timestamp: deletion.timestamp, signature: deletion.signature }, 'DELETE'), f.manager))!.status).toBe(200);
    expect((await f.list()).hooks).toEqual([]);
  });

  it('verifies the original signed spec before storing its normalized form', async () => {
    const f = await setup();
    const path = `/v1/agents/${f.owner.agentId}/hooks`;
    const canonical = f.spec();
    const spec: HookSpec = { ...canonical, url: 'https://RECEIVER.EXAMPLE.NET:443/wake' };
    const proof = await f.setProof(spec);
    expect((await handleHookRequest(post(path, { hook: spec, timestamp: proof.timestamp, signature: proof.signature }), f.manager))!.status).toBe(202);
    expect((await f.list()).hooks[0].url).toBe(canonical.url);
  });

  it('rejects unsigned reads, forged writes, stale proofs, wrong paths and unrecognized fields', async () => {
    const f = await setup();
    const path = `/v1/agents/${f.owner.agentId}/hooks`;
    expect((await handleHookRequest(new Request(`${HUB}${path}`), f.manager))!.status).toBe(401);
    const proof = await f.setProof();
    const payload = { hook: proof.hook, timestamp: proof.timestamp, signature: proof.signature };
    expect((await handleHookRequest(post(path, { ...payload, signature: '0'.repeat(128) }), f.manager))!.status).toBe(401);
    expect((await handleHookRequest(post(path, { ...payload, command: 'untrusted' }), f.manager))!.status).toBe(400);
    expect((await handleHookRequest(post(`${path}?unsafe=1`, payload), f.manager))!.status).toBe(400);
    expect((await handleHookRequest(post(path, payload, 'PUT'), f.manager))!.status).toBe(405);
    expect((await handleHookRequest(post(`/v1/agents/${f.sender.agentId}/hooks`, payload), f.manager))!.status).toBe(401);
    f.clock.now += 5 * 60_000 + 1;
    expect((await handleHookRequest(post(path, payload), f.manager))!.status).toBe(401);
    expect(await f.makeStore().read(f.owner.agentId)).toBeNull();
  });

  it('bounds body bytes and read time and sanitizes storage failures', async () => {
    const f = await setup();
    const path = `/v1/agents/${f.owner.agentId}/hooks`;
    expect((await handleHookRequest(post(path, { text: 'x'.repeat(13 * 1024) }), f.manager))!.status).toBe(413);
    const malformed = new Request(`${HUB}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect((await handleHookRequest(malformed, f.manager))!.status).toBe(400);
    const stalled = new Request(`${HUB}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new ReadableStream({ start() {} }), duplex: 'half' } as RequestInit);
    expect((await handleHookRequest(stalled, f.manager))!.status).toBe(408);
    const proof = await f.setProof();
    f.db.exec('DROP TABLE wake_hook_state');
    const failed = (await handleHookRequest(post(path, { hook: proof.hook, timestamp: proof.timestamp, signature: proof.signature }), f.manager))!;
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'wake_hooks_unavailable' });
  });
});
