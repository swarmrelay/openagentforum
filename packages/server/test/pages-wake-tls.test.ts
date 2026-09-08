import { execFileSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hmacSha256Hex, verifyEnvelope, type WakeBody } from '@openagentforum/protocol';
import { createPullControl } from '../../wake-service/src/pull-control.js';
import { createPullRunner } from '../../wake-service/src/pull-runner.js';
import { AttemptLedger } from '../../wake-service/src/ledger.js';
import { PullJournal } from '../../wake-service/src/pull-journal.js';
import { deliverWith } from '../../wake-service/src/transport.js';
import { pagesWakeFixture, HUB } from './pages-wake-fixture.js';

it('Pages POST → durable outbox → real pull HTTPS → pinned callback HTTPS/HMAC → verified cursor fetch, with lost-ack restart', async () => {
  const f = await pagesWakeFixture();
  const scratch = mkdtempSync(join(tmpdir(), 'oaf-pages-wake-tls-'));
  const endpoint = HUB + '/internal/wake-control';
  let ledger: AttemptLedger | undefined;
  let journal: PullJournal | undefined;
  const hints: WakeBody[] = [];
  const ops: string[] = [];
  let loseAck = false;
  let callbackDials = 0;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem'), '-days', '1',
    '-subj', '/CN=openagentforum.com', '-addext', 'subjectAltName=DNS:openagentforum.com,DNS:receiver.example.net'], { stdio: 'ignore' });
  const cert = readFileSync(join(scratch, 'cert.pem'));
  // LOCAL TEST ONLY. This temporary listener represents the edge and an owned
  // receiver. Neither is installed on the outbound-only sender host.
  const server = createServer({ cert, key: readFileSync(join(scratch, 'key.pem')) }, (req, res) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('error', () => {});
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 12288) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => { void (async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/wake') {
        const expected = Buffer.from(`hmac-sha256=${await hmacSha256Hex(f.spec.secret, raw)}`);
        const supplied = Buffer.from(String(req.headers['x-oaf-signature'] ?? ''));
        if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) { res.writeHead(401); res.end(); return; }
        const hint: WakeBody = JSON.parse(raw);
        if (hint.hub !== HUB || hint.agentId !== f.owner.agentId) { res.writeHead(403); res.end(); return; }
        hints.push(hint); // data only; no eval, shell or tool invocation
        res.writeHead(hint.kind === 'verify' ? 200 : 204, { 'content-type': 'application/json' });
        res.end(hint.kind === 'verify' ? JSON.stringify({ nonce: hint.nonce, hookId: hint.hookId }) : undefined);
        return;
      }
      const input = JSON.parse(raw);
      ops.push(input.op);
      const response = await f.dispatch(new Request(endpoint, { method: 'POST', headers: {
        authorization: String(req.headers.authorization ?? ''), 'content-type': 'application/json',
      }, body: raw }));
      const output = await response.text();
      if (loseAck && input.op === 'complete') { loseAck = false; res.destroy(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(output);
    })().catch(() => res.destroy()); });
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test socket');
    const control = createPullControl({ endpoint, hub: HUB, token: f.env.WAKE_CONTROL_TOKEN,
      request: (options, cb) => request({ ...options, hostname: '127.0.0.1', port: address.port, ca: cert }, cb),
    });
    const open = () => { ledger = new AttemptLedger(join(scratch, 'attempts.sqlite')); journal = new PullJournal(join(scratch, 'pull.sqlite'), HUB, endpoint); };
    open();
    const step = () => createPullRunner({ control, ledger: ledger!, journal: journal!,
      deliver: job => deliverWith(job, async () => ['93.184.216.34'], (options, cb) => {
        callbackDials++;
        expect(options.hostname).toBe('93.184.216.34');
        expect(options.servername).toBe('receiver.example.net');
        expect(options.rejectUnauthorized).toBe(true);
        // Offline test seam remaps the vetted IP, never production configuration.
        return request({ ...options, hostname: '127.0.0.1', port: address.port, ca: cert }, cb);
      }),
    }).step(new AbortController().signal);
    expect((await f.set()).status).toBe(202);
    expect(await step()).toBe('reported');
    expect((await (await f.list()).json()).hooks[0].status).toBe('active');
    await new Promise(resolve => setTimeout(resolve, 1000)); // normal sender cadence/admission
    const payload = { message: 'Untrusted instructions stay in the ledger; never execute this text.' };
    const { envelope, response } = await f.post(payload);
    expect(response.status).toBe(200);
    loseAck = true;
    try { if (await step() === 'idle') await step(); } catch { /* deliberately dropped complete ACK */ }
    expect(hints.map(h => h.kind)).toEqual(['verify', 'wake']);
    expect(hints[1].envelopeId).toBe(envelope.id);
    expect(JSON.stringify(hints)).not.toContain(payload.message);
    expect(journal!.read().pending).not.toBeNull();
    const before = ops.length;
    ledger!.close(); journal!.close(); open();
    expect(await step()).toBe('reported');
    expect(ops.slice(before)).toEqual(['complete']);
    expect(journal!.read().pending).toBeNull();
    expect(callbackDials).toBe(2); // one verification, one wake, no recovery send
    const records = await (await f.send('/v1/channels/general/messages?after=0', undefined, 'GET')).json();
    expect(records.messages[0].payload).toEqual(payload);
    expect((await verifyEnvelope(records.messages[0], f.sender.signingPublicKey)).valid).toBe(true);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    ledger?.close(); journal?.close(); f.close(); rmSync(scratch, { recursive: true, force: true });
  }
});
