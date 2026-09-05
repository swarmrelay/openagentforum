import { execFileSync } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type ClientRequest, type IncomingMessage } from 'node:http';
import { createServer, request, type RequestOptions } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { verifyWakeSignature } from '@openagentforum/protocol';
import { deliverWith, resolveAddresses, pinnedOptions } from '../src/transport.js';
import { makeJob } from './fixtures.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('DNS safety', () => {
  it('resolves both families, allowing a missing family but not a failed query', async () => {
    const v4 = vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['8.8.8.8']);
    const v6 = vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue(['2606:4700:4700::1111']);
    expect(await resolveAddresses('hooks.example.net', new AbortController().signal)).toEqual(['8.8.8.8', '2606:4700:4700::1111']);
    expect(v4).toHaveBeenCalledWith('hooks.example.net');
    expect(v6).toHaveBeenCalledWith('hooks.example.net');
    v6.mockRejectedValue(Object.assign(new Error(), { code: 'ENODATA' }));
    expect(await resolveAddresses('hooks.example.net', new AbortController().signal)).toEqual(['8.8.8.8']);
    for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ENOTFOUND']) {
      v6.mockRejectedValue(Object.assign(new Error(), { code }));
      await expect(resolveAddresses('hooks.example.net', new AbortController().signal)).rejects.toMatchObject({ code });
    }
  });

  it('cancels outstanding DNS work on timeout/abort', async () => {
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    vi.spyOn(Resolver.prototype, 'resolve4').mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
    const cancel = vi.spyOn(Resolver.prototype, 'cancel').mockImplementation(() => { reject(Object.assign(new Error(), { code: 'ECANCELLED' })); });
    const pending = resolveAddresses('hooks.example.net', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ECANCELLED' });
    expect(cancel).toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '10.2.3.4', '169.254.169.254', '100.64.1.1', '::1', '::ffff:127.0.0.1', '2002:7f00:1::', 'fc00::1', 'fe80::1', '2001:db8::1', 'not-an-ip'])('refuses a mixed answer containing %s without dialing', async address => {
    const send = vi.fn();
    const result = await deliverWith(await makeJob(), async () => ['8.8.8.8', address], send as typeof request);
    expect(result).toMatchObject({ code: 'unsafe_address', retryable: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses empty/failed resolution and unsafe URLs without dialing', async () => {
    const send = vi.fn();
    expect(await deliverWith(await makeJob(), async () => [], send as typeof request)).toMatchObject({ code: 'dns_failed' });
    expect(await deliverWith(await makeJob(), async () => { throw new Error('sensitive DNS details'); }, send as typeof request)).toEqual({ ok: false, code: 'dns_failed', retryable: true });
    const resolve = vi.fn();
    expect(await deliverWith(await makeJob({ url: 'https://metadata.google.internal/' }), resolve, send as typeof request)).toMatchObject({ code: 'unsafe_url' });
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('constructs direct-IP requests with Host, SNI, verification, no pooled agent and no proxy lookup', () => {
    const options = pinnedOptions(new URL('https://hooks.example.net/wake?test=1'), '2606:4700:4700::1111', 'a'.repeat(64), 'hook_0123456789abcdef', 200);
    expect(options).toMatchObject({ hostname: '2606:4700:4700::1111', family: 6, port: 443, servername: 'hooks.example.net', rejectUnauthorized: true, agent: false, method: 'POST', path: '/wake?test=1', headers: { Host: 'hooks.example.net', 'Content-Length': 200 } });
    expect(options).not.toHaveProperty('lookup');
    expect(options).not.toHaveProperty('auth');
    expect(options).not.toHaveProperty('createConnection');
  });

  it('aborts connections that do not complete TLS within the connect deadline', async () => {
    const job = await makeJob();
    let signal: AbortSignal | undefined;
    const send = vi.fn((options: RequestOptions) => {
      signal = options.signal;
      const req = Object.assign(new EventEmitter(), { end: vi.fn() });
      signal?.addEventListener('abort', () => req.emit('error', new Error('aborted')), { once: true });
      return req as ClientRequest;
    });
    vi.useFakeTimers();
    const pending = deliverWith(job, async () => ['8.8.8.8'], send as typeof request);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({ code: 'timeout', retryable: true });
    expect(signal?.aborted).toBe(true);
  });
});

describe('real HTTPS and signed verification handshake (offline test server)', () => {
  let dir: string;
  let cert: Buffer;
  let port: number;
  const received: { path: string; host?: string; sni: string | false; body: string; signature?: string }[] = [];
  let server: ReturnType<typeof createServer>;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oaf-wake-tls-'));
    // Ephemeral test-only credentials: never stored in the repo or printed.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=hooks.example.net', '-addext', 'subjectAltName=DNS:hooks.example.net'], { stdio: 'ignore' });
    cert = readFileSync(join(dir, 'cert.pem'));
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const body = JSON.parse(raw);
        const socket = req.socket as import('node:tls').TLSSocket;
        received.push({ path: req.url!, host: req.headers.host, sni: socket.servername, body: raw, signature: req.headers['x-oaf-signature'] as string });
        if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); }
        else if (req.url === '/large') res.end('x'.repeat(1025));
        else if (req.url === '/wrong') res.end(JSON.stringify({ nonce: body.nonce, hookId: 'hook_ffffffffffffffff' }));
        else if (req.url === '/bad-json') res.end('{broken');
        else if (req.url === '/slow') { /* total deadline must cancel this socket */ }
        else if (req.url?.startsWith('/status/')) { res.statusCode = Number(req.url.split('/')[2]); res.end(); }
        else if (body.kind === 'verify') res.end(JSON.stringify({ nonce: body.nonce, hookId: body.hookId }));
        else { res.statusCode = 204; res.end(); }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    port = address.port;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Only this test seam substitutes loopback/port/CA. Production has none of these overrides.
  function localRequest(trustCert = true) {
    return vi.fn((options: RequestOptions, cb: (res: IncomingMessage) => void) => {
      expect(options.hostname).toBe('8.8.8.8');
      expect(options.port).toBe(443);
      expect(options.rejectUnauthorized).toBe(true);
      expect(options.agent).toBe(false);
      return request({ ...options, hostname: '127.0.0.1', port, ...(trustCert ? { ca: cert } : {}) }, cb);
    });
  }

  it('uses the vetted address once, validates TLS for the hostname and sends a valid HMAC', async () => {
    const job = await makeJob();
    const resolve = vi.fn().mockResolvedValueOnce(['8.8.8.8']).mockResolvedValue(['127.0.0.1']);
    const send = localRequest();
    expect(await deliverWith(job, resolve, send as typeof request)).toEqual({ ok: true, code: 'verified', retryable: false, status: 200 });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const last = received.at(-1)!;
    expect(last.host).toBe('hooks.example.net');
    expect(last.sni).toBe('hooks.example.net');
    expect(await verifyWakeSignature(job.secret, last.body, last.signature!)).toBe(true);
    expect(JSON.parse(last.body)).toEqual(job.body);
    // A later attempt must re-resolve, observe the rebinding, and refuse it.
    expect(await deliverWith(job, resolve, send as typeof request)).toMatchObject({ code: 'unsafe_address' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong hostname and an untrusted certificate using real TLS', async () => {
    const wrongHost = await makeJob({ url: 'https://other.example.net/wake' });
    expect(await deliverWith(wrongHost, async () => ['8.8.8.8'], localRequest() as typeof request)).toMatchObject({ code: 'tls_error', retryable: false });
    expect(await deliverWith(await makeJob(), async () => ['8.8.8.8'], localRequest(false) as typeof request)).toMatchObject({ code: 'tls_error', retryable: false });
  });

  it.each([
    ['/redirect', 'http_error', false], ['/large', 'response_too_large', false],
    ['/wrong', 'invalid_verification', false], ['/bad-json', 'invalid_verification', false],
    ['/status/204', 'invalid_verification', false], ['/status/404', 'http_error', false], ['/status/503', 'http_error', true],
  ])('handles %s without redirects or unbounded body reads', async (path, code, retryable) => {
    const send = localRequest();
    const result = await deliverWith(await makeJob({ url: `https://hooks.example.net${path}` }), async () => ['8.8.8.8'], send as typeof request);
    expect(result).toMatchObject({ ok: false, code, retryable });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('body');
  });

  it('accepts 2xx for wake hints without requiring an echo', async () => {
    const job = await makeJob();
    const { nonce: _nonce, ...body } = job.body;
    const wake = { ...job, body: { ...body, kind: 'wake' as const, channel: 'general', storedSeq: 1, envelopeId: job.jobId, sender: 'agent_ffffffffffffffff', type: 'intel', mentioned: false } };
    expect(await deliverWith(wake, async () => ['8.8.8.8'], localRequest() as typeof request)).toMatchObject({ ok: true, code: 'delivered', status: 204 });
  });

  it('enforces the total deadline even after the TLS connection succeeds', async () => {
    const result = await deliverWith(await makeJob({ url: 'https://hooks.example.net/slow' }), async () => ['8.8.8.8'], localRequest() as typeof request);
    expect(result).toMatchObject({ code: 'timeout', retryable: true });
  }, 10_000);
});
