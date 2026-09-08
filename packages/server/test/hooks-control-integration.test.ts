import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@openagentforum/protocol';
import { createHookControlHandler, HOOK_CONTROL_SCHEMA } from '../src/hooks/control.js';
import { sqliteHookControlAdmission } from '../src/hooks/sqlite.js';
import { createPullControl } from '../../wake-service/src/pull-control.js';
import { createPullRunner } from '../../wake-service/src/pull-runner.js';
import { AttemptLedger } from '../../wake-service/src/ledger.js';
import { PullJournal } from '../../wake-service/src/pull-journal.js';
import type { DeliveryJob, DeliveryResult } from '../../wake-service/src/job.js';
import { fixture, HUB } from './hooks-fixture.js';

const endpoint = 'https://control.example.net/internal/wake-control';
const cleanup: (() => Promise<void>)[] = [];
let certDir: string;
let cert: Buffer;
let key: Buffer;
beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'oaf-hub-control-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=control.example.net', '-addext', 'subjectAltName=DNS:control.example.net'], { stdio: 'ignore' });
  cert = readFileSync(join(certDir, 'cert.pem'));
  key = readFileSync(join(certDir, 'key.pem'));
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
afterAll(() => rmSync(certDir, { recursive: true, force: true }));

describe.each(['sqlite', 'd1'] as const)('real Node pull client → HTTPS → hub-control/manager (%s)', backend => {
  async function setup() {
    const f = await fixture(backend);
    cleanup.push(async () => f.close());
    f.clock.now = Date.now();
    f.db.exec(HOOK_CONTROL_SCHEMA);
    const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const makeHandler = () => createHookControlHandler({ endpoint, hub: HUB, token, manager: f.manager,
      store: f.makeStore(), admission: sqliteHookControlAdmission(f.db, 16), now: () => f.clock.now });
    let handler = await makeHandler();
    let beforeRequest = async (_value: Record<string, unknown>) => {};
    let loseAck = false;
    const ops: string[] = [];
    // Test-only TLS bridge with an ephemeral loopback certificate/listener. This
    // is not a production host adapter or a deployable endpoint configuration.
    const server = createServer({ key, cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('error', () => {});
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => { void (async () => {
        const body = Buffer.concat(chunks);
        const value = JSON.parse(body.toString());
        ops.push(value.op);
        await beforeRequest(value);
        const response = await handler(new Request(new URL(req.url!, endpoint), {
          method: req.method, headers: { authorization: req.headers.authorization ?? '', 'content-type': req.headers['content-type'] ?? '' }, body,
        }));
        const output = await response.text();
        if (loseAck && value.op === 'complete') { loseAck = false; res.destroy(); return; }
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(output);
      })().catch(() => res.destroy()); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listener');
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const control = createPullControl({ endpoint, hub: HUB, token,
      request: (options, callback) => request({ ...options, hostname: '127.0.0.1', port: address.port, ca: cert }, callback),
    });
    const dir = mkdtempSync(join(tmpdir(), 'oaf-control-recovery-'));
    let ledger = new AttemptLedger(join(dir, 'attempts.sqlite'));
    let journal = new PullJournal(join(dir, 'pull.sqlite'), HUB, endpoint);
    cleanup.push(async () => { ledger.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
    const deliver = vi.fn(async (job: DeliveryJob): Promise<DeliveryResult> => ({ ok: true,
      code: job.body.kind === 'verify' ? 'verified' : 'delivered', retryable: false, status: job.body.kind === 'verify' ? 200 : 204 }));
    const step = () => createPullRunner({ control, journal, ledger, deliver }).step(new AbortController().signal);
    return { f, step, deliver, ops, loseNextAck() { loseAck = true; }, before(fn: typeof beforeRequest) { beforeRequest = fn; },
      pending: () => journal.read().pending,
      async restart() {
        ledger.close(); journal.close();
        await f.restart(); handler = await makeHandler();
        ledger = new AttemptLedger(join(dir, 'attempts.sqlite'));
        journal = new PullJournal(join(dir, 'pull.sqlite'), HUB, endpoint);
      },
    };
  }
  it('verifies then sends a metadata-only wake using the unchanged Node wire contract', async () => {
    const s = await setup();
    await s.f.manager.mutate(await s.f.setProof());
    await s.step();
    expect((await s.f.list()).hooks[0].status).toBe('active');
    await s.f.manager.enqueue(s.f.owner.agentId, await s.f.message(1, 'general', { confidential: 'not a wake payload' }));
    await s.step();
    expect(s.ops).toEqual(['poll', 'authorize', 'complete', 'poll', 'authorize', 'complete']);
    expect(s.deliver).toHaveBeenCalledTimes(2);
    expect(s.deliver.mock.calls[1][0].body).toMatchObject({ kind: 'wake', storedSeq: 1 });
    expect(s.deliver.mock.calls[1][0].body).not.toHaveProperty('payload');
    expect(s.pending()).toBeNull();
  });
  it('recovers a lost acknowledgment across sender and manager restart without authorizing or sending again', async () => {
    const s = await setup();
    await s.f.manager.mutate(await s.f.setProof());
    s.loseNextAck();
    await expect(s.step()).rejects.toThrow();
    expect(s.pending()).not.toBeNull();
    expect((await s.f.list()).hooks[0].status).toBe('active');
    await s.restart();
    await s.step();
    expect(s.ops).toEqual(['poll', 'authorize', 'complete', 'complete']);
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.pending()).toBeNull();
  });
  it.each(['delete', 'membership'])('cancels %s in the gap between poll and authorization over HTTP', async mode => {
    const s = await setup();
    s.f.access.set('private', { isPrivate: true, isMember: true });
    const hook = await s.f.activate(s.f.spec({ channels: ['private'] }));
    await s.f.manager.enqueue(s.f.owner.agentId, await s.f.message(1, 'private', 'ciphertext', true));
    s.before(async value => {
      if (value.op !== 'authorize') return;
      if (mode === 'delete') { s.f.clock.now++; await s.f.manager.mutate(await s.f.proof('delete', hook.hookId)); }
      else s.f.access.set('private', { isPrivate: true, isMember: false });
    });
    expect(await s.step()).toBe('cancelled');
    expect(s.ops).toEqual(['poll', 'authorize']);
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.pending()).toBeNull();
  });
});
