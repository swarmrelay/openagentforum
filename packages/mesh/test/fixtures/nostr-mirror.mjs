// Hub->Nostr mirror outcomes against real nostr-tools sockets (0.4.5).
// Only ephemeral loopback servers, a fake hub and fixture keys are used; no
// public relay is contacted (#240).
//
//   classify:<case>  publish one event through the real pool to a loopback
//                    relay that answers as <case>; print the classified status.
//   bridge:<case>    run dist/nostr-bridge.js against a fake hub and a
//                    loopback relay; assert on what the relay receives.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

const dist = new URL('../../dist/', import.meta.url);
const { SimplePool, createAttestationEvent, generateSecretKey } = await import(new URL('nostr.js', dist).href);
const { classifyPublish } = await import(new URL('nostr-mirror.js', dist).href);
const [kind, name] = (process.argv[2] || '').split(':');

async function waitFor(check, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(20);
  }
}

/** A loopback relay; `onEvent(event)` returns [ok, reason] or null for no answer. */
async function startRelay(onEvent, { dropOnEvent = false } = {}) {
  const http = createServer((_req, res) => { res.writeHead(400); res.end(); });
  const sockets = new Set();
  http.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws)));
  const events = [];
  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg[0] === 'REQ') ws.send(JSON.stringify(['EOSE', msg[1]]));
      else if (msg[0] === 'EVENT') {
        events.push(msg[1]);
        if (dropOnEvent) { ws.terminate(); return; }
        const answer = onEvent(msg[1]);
        if (answer) ws.send(JSON.stringify(['OK', msg[1].id, answer[0], answer[1]]));
      }
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  return {
    url: `ws://127.0.0.1:${http.address().port}`,
    events,
    sockets,
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      for (const s of sockets) s.destroy();
      await new Promise((r) => http.close(r));
    },
  };
}

const ANSWERS = {
  ok: [true, ''],
  duplicate: [true, 'duplicate: already have this event'],
  invalid: [false, 'invalid: event creation date is too far off from the current time'],
  blocked: [false, 'blocked: you are banned'],
  'auth-required': [false, 'auth-required: this relay requires authentication'],
  'free-text': [false, 'spam detected'],
  'rate-limited': [false, 'rate-limited: slow down'],
  error: [false, 'error: database busy'],
  silent: null,
};

if (kind === 'classify') {
  const pool = new SimplePool();
  const event = createAttestationEvent(generateSecretKey(), 'agent_fixture', 'ab'.repeat(32));
  let relay = null;
  let url;
  if (name === 'closed-port') {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    url = `ws://127.0.0.1:${probe.address().port}`;
    await new Promise((r) => probe.close(r));
  } else {
    assert.ok(name === 'drop' || name in ANSWERS, `unknown case ${name}`);
    relay = await startRelay(() => ANSWERS[name], { dropOnEvent: name === 'drop' });
    url = relay.url;
  }
  const [outcome] = classifyPublish([url], await Promise.allSettled(pool.publish([url], event)));
  pool.destroy();
  if (relay) await relay.close();
  console.log('ok', process.argv[2], outcome.status, JSON.stringify(outcome.reason ?? ''));
} else if (kind === 'bridge') {
  const HOUR = 3600_000;
  const message = {
    id: '5b0c9e1a-3f7d-4c2e-9a41-7d2f0c6b8e15', channel: 'general', sender: 'agent_fixture', type: 'intel',
    sequence: 0, timestamp: Date.now() - 10 * HOUR, payload: { message: 'signed hours before the hub stored it' },
    signature: '00'.repeat(64), checksum: '00'.repeat(32), storedSeq: 1,
  };
  const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const hub = createServer((req, res) => {
    const u = new URL(req.url, 'http://hub');
    if (u.pathname === '/v1/agents/agent_fixture') return json(res, { agent: { publicKey: 'ab'.repeat(32) } });
    if (u.pathname === '/v1/channels/general/messages') {
      if (u.searchParams.has('limit')) return json(res, { messages: [] }); // priming: empty record, cursor 0
      if (Number(u.searchParams.get('after')) < 1) return json(res, { messages: [message] });
      return setTimeout(() => json(res, { messages: [] }), 200); // short long-poll
    }
    res.writeHead(404); res.end('{}');
  });
  hub.listen(0, '127.0.0.1');
  await once(hub, 'listening');
  const now = () => Math.floor(Date.now() / 1000);
  const relay = await startRelay((ev) => {
    if (name === 'age-limited') return ev.created_at >= now() - 600 ? [true, ''] : [false, 'invalid: event too old'];
    if (name === 'refusing') return [false, 'blocked: fixture policy'];
    throw new Error(`unknown case ${name}`);
  });
  const dir = mkdtempSync(join(tmpdir(), 'oaf-nostr-mirror-'));
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('nostr-bridge.js', dist)), 'bridge',
    '--hub', `http://127.0.0.1:${hub.address().port}`, '--relays', relay.url, '--channels', 'general',
    '--state', join(dir, 'state.json'), '--nostr-key', join(dir, 'nostr.key'),
  ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  try {
    if (name === 'age-limited') {
      // created_at is the relay time, so a relay with an age limit accepts it
      // and the carried envelope still holds the original signed timestamp.
      await waitFor(() => out.includes(`mirrored hub->nostr general ${message.id} relays 1/1`), 'mirrored');
      assert.equal(relay.events.length, 1);
      assert.ok(relay.events[0].created_at >= now() - 60);
      assert.equal(JSON.parse(relay.events[0].content).envelope.timestamp, message.timestamp);
      await waitFor(() => { try { return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).cursors.general === 1; } catch { return false; } }, 'cursor advanced');
    } else {
      // A refusal holds the cursor with backoff, not a hot loop. The first
      // retry comes 2.5-5 s later, the second no sooner than 7.5 s after the
      // first attempt. Every retry is the same event, and the reason is logged.
      await waitFor(() => relay.events.length >= 1, 'first attempt');
      const first = Date.now();
      await waitFor(() => relay.events.length >= 2, 'first retry', 6000);
      assert.ok(Date.now() - first >= 2000, 'retry waited');
      await delay(Math.max(0, 7000 - (Date.now() - first)));
      assert.equal(relay.events.length, 2);
      assert.equal(relay.events[1].id, relay.events[0].id);
      assert.match(out, /no relay accepted, holding cursor general 5b0c9e1a-\S+ 127\.0\.0\.1:\d+=refused\(blocked: fixture policy\) retry 1 in \d+s/);
      assert.doesNotMatch(out, /mirrored hub->nostr|PERMANENT/);
    }
    assert.equal(err, '');
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    await relay.close();
    await new Promise((r) => hub.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('ok', process.argv[2]);
} else {
  throw new Error('usage: nostr-mirror.mjs classify:<case>|bridge:<case>');
}
