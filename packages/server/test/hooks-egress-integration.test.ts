import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@openagentforum/protocol';
import { createHookEgressClient } from '../src/hooks/egress.js';
import { runHookDispatchBatch } from '../src/hooks/dispatcher.js';
import { STATE_LIMITS } from '../src/hooks/types.js';
import { createWakeService } from '../../wake-service/src/service.js';
import { AttemptLedger } from '../../wake-service/src/ledger.js';
import type { DeliveryJob, DeliveryResult } from '../../wake-service/src/job.js';
import { fixture, HUB } from './hooks-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(backend: 'sqlite' | 'd1', mode: 'normal' | 'lost_response' | 'crash' | 'wrong_token' = 'normal') {
  const f = await fixture(backend);
  cleanup.push(async () => f.close());
  f.clock.now = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'oaf-dispatch-service-'));
  const path = join(dir, 'attempts.sqlite');
  let ledger = new AttemptLedger(path);
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const deliver = vi.fn(async (job: DeliveryJob): Promise<DeliveryResult> => {
    if (mode === 'crash') throw new Error('simulated loss after durable reservation');
    return { ok: true, code: job.body.kind === 'verify' ? 'verified' : 'delivered', retryable: false, status: job.body.kind === 'verify' ? 200 : 204 };
  });
  let server = createWakeService({ token, hub: HUB, ledger, deliver });
  let origin = '';
  async function listen() {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener');
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function closeServer() { await new Promise<void>(resolve => server.close(() => resolve())); }
  await listen();
  cleanup.push(async () => { await closeServer(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  let requests = 0;
  const egress = createHookEgressClient({
    endpoint: 'https://egress.example.net/internal/deliver',
    token: mode === 'wrong_token' ? bytesToHex(crypto.getRandomValues(new Uint8Array(32))) : token,
    // Test-only loopback remapping exercises the real authenticated service and
    // ledger. TLS/pinned callback dialing is covered by the wake-service tests.
    fetch: async (_url, init) => {
      requests++;
      const response = await fetch(`${origin}/internal/deliver`, init);
      const body = await response.arrayBuffer(); // actual service responses are fixed, bounded JSON
      if (mode === 'lost_response' && requests === 1) {
        await closeServer(); ledger.close();
        ledger = new AttemptLedger(path);
        server = createWakeService({ token, hub: HUB, ledger, deliver });
        await listen();
        throw new Error('response lost after service committed and restarted');
      }
      // A synthetic response preserves status/headers but not the injected HTTP
      // URL: production requires its response URL to be the configured HTTPS URL.
      return new Response(body, { status: response.status, headers: response.headers });
    },
  });
  const run = () => runHookDispatchBatch({ manager: f.manager, store: f.makeStore(), egress, now: () => f.clock.now });
  return { f, run, deliver, get requests() { return requests; } };
}

describe.each(['sqlite', 'd1'] as const)('hub → real internal Node HTTP/ledger (%s)', backend => {
  it('verifies, activates, then sends a metadata-only wake', async () => {
    const { f, run, deliver } = await setup(backend);
    await f.manager.mutate(await f.setProof());
    expect(await run()).toMatchObject({ submitted: 1, completed: 1 });
    expect((await f.list()).hooks[0].status).toBe('active');
    const record = await f.message(1);
    await f.manager.enqueue(f.owner.agentId, record);
    expect(await run()).toMatchObject({ submitted: 1, completed: 1 });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][0].body).toMatchObject({ kind: 'wake', storedSeq: 1, envelopeId: record.id });
    expect(deliver.mock.calls[1][0].body).not.toHaveProperty('payload');
  });

  it('recovers the recorded result across a lost response and egress restart without resending', async () => {
    const state = await setup(backend, 'lost_response');
    await state.f.manager.mutate(await state.f.setProof());
    expect(await state.run()).toMatchObject({ claimed: 1, submitted: 2, completed: 1, uncertain: 0 });
    expect(state.requests).toBe(2);
    expect(state.deliver).toHaveBeenCalledTimes(1);
    expect((await state.f.list()).hooks[0].status).toBe('active');
  });

  it('does not repeat an attempt whose service reservation survived an interrupted delivery', async () => {
    const { f, run, deliver } = await setup(backend, 'crash');
    await f.manager.mutate(await f.setProof());
    expect(await run()).toMatchObject({ submitted: 2, completed: 1 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await f.list()).hooks[0]).toMatchObject({ status: 'disabled', lastError: 'indeterminate' });
    await f.restart();
    expect(await run()).toMatchObject({ submitted: 0 });
  });

  it('fails closed with a wrong service credential and lets the hub claim expire', async () => {
    const { f, run, deliver } = await setup(backend, 'wrong_token');
    await f.manager.mutate(await f.setProof());
    expect(await run()).toMatchObject({ submitted: 1, uncertain: 1, completed: 0 });
    expect(deliver).not.toHaveBeenCalled();
    f.clock.now += STATE_LIMITS.leaseMs;
    expect(await run()).toMatchObject({ submitted: 0 });
    expect((await f.list()).hooks[0]).toMatchObject({ status: 'disabled', lastError: 'indeterminate' });
  });
});
