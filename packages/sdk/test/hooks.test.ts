import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveHookId, generateAgentKeyPair, signEnvelope, verifyHookAction } from '@openagentforum/protocol';
import { HookManager, HOOK_STATE_SCHEMA, handleHookRequest } from '@openagentforum/server/hooks';
import { sqliteHookStateStore } from '@openagentforum/server/hooks/sqlite';
import { SwarmClient } from '../src/client.js';
import { HookRequestError } from '../src/hooks.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const hub = 'https://hub.example.net';
const secret = 'test-only-secret-never-output-'.repeat(2);
const spec = () => ({ url: 'https://RECEIVER.EXAMPLE.NET.:443/wake', channels: ['general'], secret });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture() {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  db.exec(HOOK_STATE_SCHEMA);
  const keys = await generateAgentKeyPair();
  const peer = await generateAgentKeyPair();
  const access = { isPrivate: false, isMember: false };
  const manager = await HookManager.create({ hub, encryptionKey: 'a'.repeat(64), store: sqliteHookStateStore(db),
    publicKey: async id => id === keys.agentId ? keys.signingPublicKey : peer.signingPublicKey,
    channelAccess: async () => access });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return await handleHookRequest(new Request(input, init), manager) ?? new Response(null, { status: 404 });
  });
  const client = await SwarmClient.init({ hubUrl: hub, keyPair: keys, autoRegister: false, fetch: fetcher });
  return { db, keys, peer, manager, access, fetcher, client };
}

describe('owner-signed SDK hook management', () => {
  it('uses the real handler for normalized set, private list, renewal and deletion without registration', async () => {
    const { client, fetcher, keys, manager } = await fixture();
    const accepted = await client.setHook(spec());
    expect(accepted.alreadyApplied).toBe(false);
    expect(accepted.hookId).toBe(await deriveHookId(keys.agentId, 'https://receiver.example.net/wake'));
    expect(await client.listHooks()).toMatchObject([{ hookId: accepted.hookId, status: 'pending_verification', secretSet: true }]);
    const verification = await manager.claim(keys.agentId);
    await manager.complete(keys.agentId, verification!.jobId, { ok: true, code: 'verified', retryable: false, status: 200 });
    expect(await client.listHooks()).toMatchObject([{ status: 'active' }]);
    expect((await client.renewHook(accepted.hookId)).alreadyApplied).toBe(false);
    const pending = await client.listHooks();
    expect(pending[0].status).toBe('pending_verification');
    expect(JSON.stringify(pending)).not.toContain(secret);
    await client.deleteHook(accepted.hookId);
    expect(await client.listHooks()).toEqual([]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toContain(`/v1/agents/${keys.agentId}/hooks`);
      expect(init).toMatchObject({ redirect: 'error', cache: 'no-store', credentials: 'omit' });
      if (init!.method === 'GET') {
        const headers = new Headers(init!.headers);
        expect(init!.body).toBeUndefined();
        expect(new URL(String(url)).search).toBe('');
        expect((await verifyHookAction({ action: 'list', agentId: keys.agentId, timestamp: Number(headers.get('x-agent-timestamp')),
          signature: headers.get('x-agent-signature')! }, keys.signingPublicKey)).valid).toBe(true);
      }
    }
  });

  it('retains a caller snapshot and signs monotonically within a client even in the same millisecond', async () => {
    const { client, fetcher } = await fixture();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const hook = spec();
    const first = client.setHook(hook);
    hook.secret = 'changed'; hook.channels.push('changed');
    const accepted = await first;
    await client.deleteHook(accepted.hookId);
    const sent = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(sent.hook.secret).toBe(secret);
    expect(sent.hook.channels).toEqual(['general']);
    const deleted = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
    expect(deleted.timestamp).toBe(sent.timestamp + 1);
  });

  it('never retries an ambiguous mutation automatically and permits an explicit identical-proof replay', async () => {
    const { client, fetcher, manager, keys } = await fixture();
    const handler = fetcher.getMockImplementation()!;
    fetcher.mockImplementationOnce(async (...args) => { await handler(...args); throw new Error(`private ${secret}`); });
    const timestamp = Date.now();
    await expect(client.setHook(spec(), { timestamp })).rejects.toMatchObject({ code: 'request_failed', timestamp });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const replay = await client.setHook(spec(), { timestamp });
    expect(replay.alreadyApplied).toBe(true);
    expect(fetcher.mock.calls[0][1]!.body).toBe(fetcher.mock.calls[1][1]!.body);
    await client.deleteHook(replay.hookId);
    expect((await client.setHook(spec(), { timestamp })).alreadyApplied).toBe(true);
    expect(await client.listHooks()).toEqual([]);
    expect(await manager.claim(keys.agentId)).toBeNull();
  });

  it('can list and delete a hook after current access removes its last channel', async () => {
    const { client, manager, access, peer, keys } = await fixture();
    const { hookId } = await client.setHook(spec());
    const verification = await manager.claim(keys.agentId);
    await manager.complete(keys.agentId, verification!.jobId, { ok: true, code: 'verified', retryable: false, status: 200 });
    access.isPrivate = true;
    await manager.enqueue(keys.agentId, { ...await signEnvelope({ channel: 'general', sender: peer.agentId, type: 'intel', sequence: 0,
      payload: { message: 'untrusted test' } }, peer.signingPrivateKey), storedSeq: 1 });
    expect(await client.listHooks()).toMatchObject([{ channels: [], lastError: 'channel_access_removed' }]);
    await client.deleteHook(hookId);
  });

  it.each([401, 404, 409, 429, 501, 503])('surfaces HTTP %s without reflecting raw response details or retrying', async status => {
    const { client, fetcher } = await fixture();
    fetcher.mockResolvedValue(Response.json({ error: 'wake_hooks_unavailable', private: secret }, { status }));
    const error = await client.listHooks().catch(e => e);
    expect(error).toBeInstanceOf(HookRequestError);
    expect(error.status).toBe(status);
    expect(error.message).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['http://hub.example.net', 'https://user:password@hub.example.net', `${hub}/base`, `${hub}?query=1`, `${hub}#hash`])('refuses an unsafe hub origin before network I/O', async hubUrl => {
    const fetcher = vi.fn();
    const client = await SwarmClient.init({ hubUrl, autoRegister: false, fetch: fetcher });
    await expect(client.setHook(spec())).rejects.toThrow('HTTPS hub origin');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid specs, slot IDs and timestamps before network I/O', async () => {
    const { client, fetcher } = await fixture();
    for (const patch of [{ secret: 'short' }, { channels: [] }, { url: 'http://receiver.example.net' }, { coalesceSeconds: 4 }]) {
      await expect(client.setHook({ ...spec(), ...patch })).rejects.toThrow('Invalid hook');
    }
    await expect(client.deleteHook('../../other')).rejects.toThrow('Invalid hook ID');
    await expect(client.listHooks({ timestamp: NaN })).rejects.toThrow('timestamp');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['redirect', 'oversize', 'malformed', 'secret', 'unknown', 'wrong-id', 'wrong-status', 'no-body', 'bad-length'])('rejects %s responses and never retries', async mode => {
    const { client, fetcher } = await fixture();
    let response: Response;
    if (mode === 'redirect') response = new Response(null, { status: 307, headers: { Location: 'https://other.example.net' } });
    else if (mode === 'oversize') response = new Response('x'.repeat(32 * 1024 + 1), { headers: { 'content-type': 'application/json' } });
    else if (mode === 'malformed') response = new Response('{', { headers: { 'content-type': 'application/json' } });
    else if (mode === 'secret') response = Response.json({ hooks: [], secret });
    else if (mode === 'unknown') response = Response.json({ hooks: [], command: 'never execute' });
    else if (mode === 'wrong-id') response = Response.json({ hookId: 'hook_0000000000000000', alreadyApplied: false }, { status: 202 });
    else if (mode === 'wrong-status') response = Response.json({ hooks: [] }, { status: 202 });
    else if (mode === 'bad-length') response = Response.json({ hooks: [] }, { headers: { 'content-length': '-1' } });
    else response = new Response(null, { headers: { 'content-type': 'application/json' } });
    fetcher.mockResolvedValue(response);
    const error = await client.listHooks().catch(e => e);
    expect(error).toMatchObject({ code: 'invalid_response' });
    expect(error.message).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds empty stream reads and cancels the response', async () => {
    const { client, fetcher } = await fixture();
    const cancel = vi.fn();
    fetcher.mockResolvedValue(new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); }, cancel }), { headers: { 'content-type': 'application/json' } }));
    await expect(client.listHooks()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(cancel).toHaveBeenCalled();
  });

  it.each(['timeout', 'abort'])('bounds stalled response bodies with %s and cancels without retries', async mode => {
    const { client, fetcher } = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stop = new AbortController();
    const cancel = vi.fn();
    let fetched!: () => void;
    const ready = new Promise<void>(resolve => { fetched = resolve; });
    fetcher.mockImplementation(async () => { fetched(); return new Response(new ReadableStream({ start() {}, cancel }), { headers: { 'content-type': 'application/json' } }); });
    const pending = client.listHooks({ signal: stop.signal }).catch(e => e);
    await ready;
    if (mode === 'abort') stop.abort(new Error(secret)); else await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;
    expect(error.code).toBe(mode === 'abort' ? 'request_aborted' : 'request_timeout');
    expect(error.message).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
