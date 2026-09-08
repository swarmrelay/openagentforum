import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@openagentforum/protocol';
import { createHookEgressClient, type HookEgressOptions } from '../src/hooks/egress.js';
import type { HookDispatchJob } from '../src/hooks/types.js';
import { fixture } from './hooks-fixture.js';

const endpoint = 'https://egress.example.net/internal/deliver';
const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const verified = { duplicate: false, result: { ok: true, code: 'verified', retryable: false, status: 200 } };
const cleanups: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanups.splice(0)) close(); });
async function job() {
  const f = await fixture(); cleanups.push(f.close);
  await f.manager.mutate(await f.setProof());
  return (await f.manager.claim(f.owner.agentId))!;
}
function client(send: NonNullable<HookEgressOptions['fetch']>, extra: Partial<HookEgressOptions> = {}) {
  return createHookEgressClient({ endpoint, token, fetch: send, ...extra });
}

describe('authenticated hub-to-egress client', () => {
  it.each([
    'http://egress.example.net/internal/deliver', 'https://egress.example.net/internal/deliver?token=bad',
    'https://egress.example.net/internal/deliver#fragment', 'https://user:pass@egress.example.net/internal/deliver',
    'https://egress.example.net:8443/internal/deliver', 'https://egress.example.net/wrong',
    'https://egress.example.net/../internal/deliver', 'invalid',
  ])('rejects unsafe or noncanonical service configuration: %s', endpoint => {
    expect(() => createHookEgressClient({ endpoint, token })).toThrow('invalid_egress_config');
  });

  it('rejects invalid tokens and deadline bounds without exposing configuration', () => {
    for (const patch of [{ token: 'weak' }, { timeoutMs: 0 }, { timeoutMs: 10001 }, { timeoutMs: NaN }]) {
      expect(() => createHookEgressClient({ endpoint, token, ...patch })).toThrow('invalid_egress_config');
    }
  });

  it('sends exact jobs only to the configured service with auth, no redirects and no cache', async () => {
    const input = await job();
    const send = vi.fn(async (_url: string, _init: RequestInit) => Response.json(verified));
    expect(await client(send).submit(input)).toEqual({ kind: 'result', ...verified });
    const [url, init] = send.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(url).not.toBe(input.url);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', cache: 'no-store', body: JSON.stringify(input) });
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(new Headers(init.headers).get('accept-encoding')).toBe('identity');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    {}, { ok: true }, { ...verified, command: 'run this' }, { ...verified, duplicate: 'true' },
    { duplicate: true, result: { ...verified.result, secret: 'unexpected' } },
    { duplicate: false, result: { ...verified.result, status: 204 } },
    { duplicate: false, result: { ...verified.result, code: 'delivered' } },
    { duplicate: false, result: { ...verified.result, retryable: true } },
    { duplicate: false, result: { ok: false, code: 'indeterminate', retryable: true } },
    { duplicate: false, result: { ok: false, code: 'http_error', retryable: true, status: 400 } },
    { duplicate: false, result: { ok: false, code: 'http_error', retryable: false, status: 503 } },
    { duplicate: false, result: { ok: false, code: 'new_code', retryable: true } },
    { duplicate: false, result: { ok: false, code: 'network_error', retryable: true, status: 503 } },
  ])('rejects malformed or contradictory service outcomes %#', async body => {
    expect(await client(async () => Response.json(body)).submit(await job())).toEqual({ kind: 'uncertain', code: 'invalid_service_response', replayable: false });
  });

  it('accepts sanitized failures, deliberate retry eligibility and duplicate indeterminate outcomes', async () => {
    const input = await job();
    for (const result of [
      { ok: false, code: 'http_error', retryable: true, status: 503 },
      { ok: false, code: 'http_error', retryable: false, status: 302 },
      { ok: false, code: 'timeout', retryable: true },
      { ok: false, code: 'tls_error', retryable: false },
      { ok: false, code: 'invalid_verification', retryable: false, status: 204 },
      { ok: false, code: 'indeterminate', retryable: false },
    ]) expect(await client(async () => Response.json({ duplicate: true, result })).submit(input)).toEqual({ kind: 'result', duplicate: true, result });
    const wake: HookDispatchJob = { ...input, body: { ...input.body, kind: 'wake' } };
    expect(await client(async () => Response.json({ duplicate: false, result: { ok: true, code: 'delivered', retryable: false, status: 204 } })).submit(wake)).toMatchObject({ kind: 'result' });
  });

  it.each([301, 302, 307, 308, 400, 401, 409, 429, 500, 502, 503, 504])('never interprets service HTTP %s as a callback outcome', async status => {
    const send = vi.fn(async () => new Response('private upstream detail', { status, headers: { Location: 'https://elsewhere.example/internal/deliver' } }));
    expect(await client(send).submit(await job())).toEqual({ kind: 'uncertain', code: 'service_rejected', replayable: [502, 503, 504].includes(status) });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds chunked, oversized, invalid UTF-8 and malformed bodies, including empty-chunk streams', async () => {
    const input = await job();
    const cases = [
      new Response('x'.repeat(2049), { headers: { 'Content-Type': 'application/json' } }),
      new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '9999' } }),
      new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '-1' } }),
      new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } }),
      new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
      new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/json' } }),
      new Response('{', { headers: { 'Content-Type': 'application/json' } }),
      new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(0)); } }), { headers: { 'Content-Type': 'application/json' } }),
    ];
    for (const response of cases) expect(await client(async () => response).submit(input)).toMatchObject({ kind: 'uncertain', code: 'invalid_service_response', replayable: false });
  });

  it('enforces the deadline even if fetch ignores abort, and discards late success', async () => {
    const input = await job();
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const cancelled = vi.fn();
    const send = vi.fn((_url: string, init: RequestInit) => {
      init.signal!.addEventListener('abort', cancelled);
      return new Promise<Response>(resolve => { release = resolve; });
    });
    const pending = client(send, { timeoutMs: 25 }).submit(input);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual({ kind: 'uncertain', code: 'service_timeout', replayable: true });
    expect(cancelled).toHaveBeenCalledTimes(1);
    release(Response.json(verified));
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled response body even when cancellation itself never resolves', async () => {
    const input = await job();
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } });
    const pending = client(async () => response, { timeoutMs: 25 }).submit(input);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ kind: 'uncertain', code: 'service_timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does no I/O after pre-abort or an oversized request; sanitizes thrown fetch errors', async () => {
    const input = await job();
    const send = vi.fn(async () => { throw new Error(`private ${token} ${input.secret}`); });
    const c = client(send);
    expect(await c.submit(input, AbortSignal.abort())).toMatchObject({ code: 'aborted', replayable: false });
    expect(await c.submit({ ...input, secret: 'x'.repeat(9000) })).toMatchObject({ code: 'service_rejected', replayable: false });
    expect(send).not.toHaveBeenCalled();
    expect(await c.submit(input)).toEqual({ kind: 'uncertain', code: 'service_unavailable', replayable: true });
  });
});
