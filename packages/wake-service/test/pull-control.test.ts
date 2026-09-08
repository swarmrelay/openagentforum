import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:https';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONTROL_TIMEOUT_MS, createPullControl, type ControlRequest } from '../src/pull-control.js';
import { INDETERMINATE, type WorkRef } from '../src/pull-protocol.js';
import { HUB, TOKEN, makeJob } from './fixtures.js';

const endpoint = 'https://control.example.net/internal/wake-control';
const refFor = (job: Awaited<ReturnType<typeof makeJob>>): WorkRef => ({ agentId: job.body.agentId, jobId: job.jobId, kind: job.body.kind });
const signal = () => new AbortController().signal;

describe('fixed outbound HTTPS control contract (offline TLS)', () => {
  let dir: string;
  let cert: Buffer;
  let port: number;
  let server: ReturnType<typeof createServer>;
  let respond: (body: Record<string, unknown>, res: ServerResponse) => void;
  const requests: { path: string; authorization?: string; body: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oaf-pull-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=control.example.net', '-addext', 'subjectAltName=DNS:control.example.net'], { stdio: 'ignore' });
    cert = readFileSync(join(dir, 'cert.pem'));
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('error', () => {});
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push({ path: req.url!, authorization: req.headers.authorization, body });
        res.setHeader('Content-Type', 'application/json');
        respond(body, res);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    port = address.port;
  });
  afterEach(() => { requests.length = 0; vi.restoreAllMocks(); });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  function client(trust = true, url = endpoint) {
    const send: ControlRequest = (options, callback) => {
      expect(options).toMatchObject({ hostname: new URL(url).hostname, port: 443, method: 'POST',
        path: '/internal/wake-control', agent: false, rejectUnauthorized: true, maxHeaderSize: 8192 });
      // Offline test-only loopback/CA mapping. No runtime config can inject these.
      return request({ ...options, hostname: '127.0.0.1', port, ...(trust ? { ca: cert } : {}) }, callback);
    };
    return createPullControl({ endpoint: url, hub: HUB, token: TOKEN, request: send });
  }

  it('pulls references only, validates freshly authorized jobs, and acknowledges exactly the same reference', async () => {
    const job = await makeJob();
    const ref = refFor(job);
    const after = { agentId: ref.agentId, dueAt: Date.now() };
    respond = (body, res) => res.end(JSON.stringify(body.op === 'poll' ? { ref, after } : body.op === 'authorize' ? { job } : { ack: ref }));
    const control = client();
    expect(await control.poll(null, signal())).toEqual({ ref, after });
    expect(await control.authorize(ref, signal())).toEqual(job);
    await control.complete(ref, INDETERMINATE, signal());
    expect(requests.map(r => r.body)).toEqual([{ op: 'poll', after: null }, { op: 'authorize', ref }, { op: 'complete', ref, result: INDETERMINATE }]);
    expect(requests.every(r => r.path === '/internal/wake-control' && r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(requests)).not.toContain(job.url);
    expect(JSON.stringify(requests)).not.toContain(job.secret);
  });

  it('accepts cancellation and end-of-scan without inventing work', async () => {
    const ref = refFor(await makeJob());
    respond = (body, res) => res.end(JSON.stringify(body.op === 'poll' ? { ref: null, after: null } : { job: null }));
    expect(await client().poll(null, signal())).toEqual({ ref: null, after: null });
    expect(await client().authorize(ref, signal())).toBeNull();
  });

  it.each([
    'http://control.example.net/internal/wake-control', 'https://control.example.net:8443/internal/wake-control',
    'https://user:pass@control.example.net/internal/wake-control', 'https://control.example.net/internal/deliver',
    `${endpoint}?token=x`, `${endpoint}#x`, 'https://127.0.0.1/internal/wake-control',
    'https://CONTROL.example.net/internal/wake-control', 'https://control.example.net/x/../internal/wake-control',
  ])('refuses unsafe/noncanonical endpoint %s before I/O', url => {
    const send = vi.fn();
    expect(() => createPullControl({ endpoint: url, hub: HUB, token: TOKEN, request: send })).toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects weak tokens and noncanonical hub settings', () => {
    expect(() => createPullControl({ endpoint, hub: HUB, token: 'weak' })).toThrow();
    expect(() => createPullControl({ endpoint, hub: HUB + '/', token: TOKEN })).toThrow();
  });

  it.each(['redirect', 'wrong-type', 'encoding', 'length', 'large', 'headers', 'bad-json', 'bad-utf8', 'extra', 'bad-ref', 'bad-cursor'])('rejects %s without forwarding raw response data', async mode => {
    respond = (_body, res) => {
      if (mode === 'redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); res.end(); }
      else if (mode === 'wrong-type') { res.setHeader('Content-Type', 'text/plain'); res.end('{}'); }
      else if (mode === 'encoding') { res.setHeader('Content-Encoding', 'gzip'); res.end('{}'); }
      else if (mode === 'length') { res.setHeader('Content-Length', 1025); res.end(); }
      else if (mode === 'large') { res.write('x'.repeat(1025)); res.end(); }
      else if (mode === 'headers') { res.setHeader('X-Large', 'x'.repeat(9000)); res.end('{}'); }
      else if (mode === 'bad-json') res.end('raw confidential error');
      else if (mode === 'bad-utf8') res.end(Buffer.from([0xff]));
      else if (mode === 'extra') res.end(JSON.stringify({ ref: null, after: null, command: 'do not execute' }));
      else if (mode === 'bad-ref') res.end(JSON.stringify({ ref: { agentId: 'x', jobId: 'x', kind: 'wake' }, after: null }));
      else res.end(JSON.stringify({ ref: null, after: { dueAt: -1, agentId: 'agent_0123456789abcdef' } }));
    };
    await expect(client().poll(null, signal())).rejects.not.toThrow('confidential');
    expect(requests).toHaveLength(1);
  });

  it.each(['id', 'owner', 'kind', 'hub', 'old', 'secret', 'extra'])('rejects an authorized job with mismatched/invalid %s', async mode => {
    const job = await makeJob();
    const ref = refFor(job);
    const altered = structuredClone(job);
    if (mode === 'id') altered.jobId = '0'.repeat(36);
    if (mode === 'owner') altered.body.agentId = 'agent_ffffffffffffffff';
    if (mode === 'kind') ref.kind = 'wake';
    if (mode === 'hub') altered.body.hub = 'https://other.example.net';
    if (mode === 'old') altered.body.sentAt -= 60_001;
    if (mode === 'secret') altered.secret = 'short';
    respond = (_body, res) => res.end(JSON.stringify({ job: mode === 'extra' ? { ...altered, command: 'unused' } : altered }));
    await expect(client().authorize(ref, signal())).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects mismatched acknowledgments and inconsistent result vocabularies', async () => {
    const ref = refFor(await makeJob());
    respond = (_body, res) => res.end(JSON.stringify({ ack: { ...ref, agentId: 'agent_ffffffffffffffff' } }));
    await expect(client().complete(ref, INDETERMINATE, signal())).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client().complete(ref, { ...INDETERMINATE, retryable: true }, signal())).rejects.toMatchObject({ code: 'rejected' });
    expect(requests).toHaveLength(1);
  });

  it('validates the control server certificate and original hostname', async () => {
    await expect(client(false).poll(null, signal())).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client(true, 'https://wrong.example.net/internal/wake-control').poll(null, signal())).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toHaveLength(0);
  });

  it('bounds a response that never finishes and destroys its connection', async () => {
    let closed!: Promise<unknown>;
    respond = (_body, res) => { closed = once(res, 'close'); res.write('{'); };
    const started = performance.now();
    await expect(client().poll(null, signal())).rejects.toMatchObject({ code: 'timeout' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(CONTROL_TIMEOUT_MS - 100);
    await closed;
  }, 6000);

  it('does no I/O on early abort and interrupts an active response', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client().poll(null, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(requests).toHaveLength(0);
    const active = new AbortController();
    respond = (_body, res) => { res.write('{'); active.abort(); };
    await expect(client().poll(null, active.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(requests).toHaveLength(1);
  });
});
