import { request } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttemptLedger } from '../src/ledger.js';
import { createWakeService } from '../src/service.js';
import type { DeliveryResult } from '../src/job.js';
import { HUB, TOKEN, makeJob } from './fixtures.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function start(deliver = vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, code: 'verified', retryable: false, status: 200 })), limit = 1000, maxConcurrent = 16) {
  const ledger = new AttemptLedger(':memory:', limit);
  const server = createWakeService({ token: TOKEN, hub: HUB, ledger, deliver, maxConcurrent });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); ledger.close(); });
  const post = (value: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/internal/deliver`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value),
  });
  return { origin, post, deliver, ledger };
}

describe('internal HTTP boundary', () => {
  it('requires a strong token and an exact configured HTTPS hub origin', () => {
    const ledger = new AttemptLedger(':memory:');
    expect(() => createWakeService({ token: 'weak', hub: HUB, ledger })).toThrow();
    expect(() => createWakeService({ token: TOKEN, hub: `${HUB}/`, ledger })).toThrow();
    expect(() => createWakeService({ token: TOKEN, hub: 'http://localhost', ledger })).toThrow();
    ledger.close();
  });

  it('exposes only a minimal health check without auth; rejects unauthorized delivery', async () => {
    const { origin, post, deliver } = await start();
    const health = await fetch(`${origin}/healthz`);
    expect(await health.json()).toEqual({ ok: true, role: 'wake-egress', publicHooks: false });
    for (const Authorization of ['', 'Bearer wrong', `Bearer ${TOKEN}extra`]) expect((await post(await makeJob(), { Authorization })).status).toBe(401);
    expect((await fetch(`${origin}/v1/agents/foo/hooks`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers once, returns sanitized outcomes, and deduplicates caller retries', async () => {
    const { post, deliver } = await start();
    const job = await makeJob();
    const first = await post(job);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const body = await first.json();
    expect(body).toMatchObject({ duplicate: false, result: { code: 'verified' } });
    expect(JSON.stringify(body)).not.toContain(job.secret);
    expect(JSON.stringify(body)).not.toContain(job.url);
    expect(await (await post(job)).json()).toMatchObject({ duplicate: true, result: { code: 'verified' } });
    expect((await post({ ...job, secret: 't'.repeat(64) })).status).toBe(409);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('rejects extra fields, foreign hubs and malformed/oversized/compressed requests before dialing', async () => {
    const { post, deliver, origin } = await start();
    const job = await makeJob();
    expect((await post({ ...job, command: 'do something' })).status).toBe(400);
    expect((await post({ ...job, body: { ...job.body, hub: 'https://evil.example' } })).status).toBe(400);
    expect((await post(job, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(job, { 'Content-Encoding': 'gzip' })).status).toBe(415);
    expect((await post({ ...job, secret: 's'.repeat(9000) })).status).toBe(413);
    expect((await fetch(`${origin}/internal/deliver`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{not-json' })).status).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('bounds chunked bodies too, without requiring Content-Length', async () => {
    const { origin, deliver } = await start();
    const status = await new Promise<number>(resolve => {
      const req = request(`${origin}/internal/deliver`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.write('x'.repeat(8192));
      req.end('extra');
    });
    expect(status).toBe(413);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('handles an aborted upload and a stalled body without leaking an active slot', async () => {
    const { origin, post, deliver } = await start(undefined, 1000, 1);
    const aborted = request(`${origin}/internal/deliver`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
    aborted.on('error', () => {});
    aborted.write('{');
    await new Promise(resolve => setTimeout(resolve, 30));
    aborted.destroy();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await post(await makeJob())).status).toBe(200);
    const status = await new Promise<number>(resolve => {
      const stalled = request(`${origin}/internal/deliver`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode!); });
      stalled.on('error', () => {});
      stalled.write('{');
    });
    expect(status).toBe(408);
    expect((await post(await makeJob())).status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('reserves before awaiting network and suppresses concurrent duplicate requests', async () => {
    let finish!: (result: DeliveryResult) => void;
    const deliver = vi.fn(() => new Promise<DeliveryResult>(resolve => { finish = resolve; }));
    const { post } = await start(deliver);
    const job = await makeJob();
    const first = post(job);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(await (await post(job)).json()).toMatchObject({ duplicate: true, result: { code: 'indeterminate', retryable: false } });
    finish({ ok: true, code: 'verified', retryable: false, status: 200 });
    expect((await first).status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('enforces persistent limits before sending and does not charge duplicates', async () => {
    const { post, deliver } = await start(undefined, 1);
    const job = await makeJob();
    await post(job);
    expect((await post(job)).status).toBe(200);
    const limited = await post(await makeJob());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('fails closed on unavailable storage, without emitting errors or secrets', async () => {
    const { post, deliver, ledger } = await start();
    vi.spyOn(ledger, 'reserve').mockImplementation(() => { throw new Error('sensitive storage detail'); });
    const response = await post(await makeJob());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('bounds active requests and refuses Expect: 100-continue', async () => {
    let finish!: (result: DeliveryResult) => void;
    const deliver = vi.fn(() => new Promise<DeliveryResult>(resolve => { finish = resolve; }));
    const { post, origin } = await start(deliver, 1000, 1);
    const pending = post(await makeJob());
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect((await post(await makeJob())).status).toBe(503);
    finish({ ok: true, code: 'verified', retryable: false });
    await pending;
    const status = await new Promise<number>(resolve => {
      const req = request(`${origin}/internal/deliver`, { method: 'POST', headers: { Expect: '100-continue' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.end();
    });
    expect(status).toBe(417);
  });
});
