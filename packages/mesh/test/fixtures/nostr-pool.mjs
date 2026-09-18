// Also runnable against a freshly packed consumer: pass its dist/nostr.js URL
// as argv[3]. Only ephemeral loopback sockets and fixture keys are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

const originalWebSocket = globalThis.WebSocket;
const { SimplePool, createAttestationEvent, generateSecretKey } = await import(
  process.argv[3] || new URL('../../dist/nostr.js', import.meta.url).href
);
const scenario = process.argv[2];
const pool = new SimplePool();
assert.equal(globalThis.WebSocket, originalWebSocket);
const sockets = new Set();
const http = createServer((_req, res) => { res.writeHead(400); res.end(); });
http.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
http.listen(0, '127.0.0.1');
await once(http, 'listening');
const url = `ws://127.0.0.1:${http.address().port}`;
let wss;
let attempts = 0;
http.on('upgrade', (req, socket, head) => {
  attempts++;
  if (scenario === 'rejected' || (scenario === 'recover' && attempts === 1)) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  else if (scenario === 'dropped') socket.destroy();
  else if (scenario === 'redirect') socket.end(`HTTP/1.1 302 Found\r\nLocation: ${url}/unexpected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  else if (!['timeout', 'default-timeout', 'shutdown'].includes(scenario)) wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  else {
    // Deliberately never answer the upgrade, but read the peer's FIN. Node
    // leaves upgrade sockets paused/half-open unless the fixture owns them.
    socket.on('end', () => socket.end());
    socket.resume();
  }
});

async function waitFor(check, label) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(10);
  }
}

try {
  if (scenario === 'refused') await new Promise(resolve => http.close(resolve));
  if (['rejected', 'refused', 'dropped', 'timeout', 'redirect'].includes(scenario)) {
    // Same pool and URL can be retried; failure must not poison the cache.
    for (let i = 0; i < 2; i++) {
      await assert.rejects(pool.ensureRelay(url, { connectionTimeout: scenario === 'timeout' ? 100 : 1000 }));
      assert.equal(pool.listConnectionStatus().size, 0);
      await waitFor(() => sockets.size === 0, 'failed socket cleanup');
    }
    if (scenario !== 'refused') assert.equal(attempts, 2); // no implicit retry/redirect
  } else if (scenario === 'default-timeout') {
    await assert.rejects(pool.ensureRelay(url));
    assert.equal(pool.listConnectionStatus().size, 0);
    await waitFor(() => sockets.size === 0, 'default deadline cleanup');
    assert.equal(attempts, 1);
  } else if (scenario === 'shutdown') {
    const connecting = pool.ensureRelay(url, { connectionTimeout: 500 });
    const rejected = assert.rejects(connecting);
    await waitFor(() => attempts === 1, 'pending handshake');
    pool.destroy();
    await rejected;
    await waitFor(() => sockets.size === 0, 'shutdown cleanup');
  } else {
    wss = new WebSocketServer({ noServer: true });
    if (scenario === 'oversized') {
      wss.on('connection', ws => {
        ws.on('error', () => {}); // fixture server sees the client's rejection
        ws.send('x'.repeat(1024 * 1024 + 1));
      });
      const relay = await pool.ensureRelay(url, { connectionTimeout: 1000 });
      await waitFor(() => !relay.connected && sockets.size === 0, 'oversize rejection');
      assert.equal(pool.listConnectionStatus().size, 0);
    } else {
      assert.ok(['roundtrip', 'recover'].includes(scenario));
      if (scenario === 'recover') {
        await assert.rejects(pool.ensureRelay(url));
        await waitFor(() => sockets.size === 0, 'failed first handshake');
      }
      const event = JSON.parse(JSON.stringify(createAttestationEvent(generateSecretKey(), 'agent_fixture', 'ab'.repeat(32))));
      const invalidEvent = { ...createAttestationEvent(generateSecretKey(), 'agent_other', 'cd'.repeat(32)), sig: '00'.repeat(64) };
      const received = [];
      let closes = 0;
      wss.on('connection', ws => ws.on('message', raw => {
        const msg = JSON.parse(String(raw));
        if (msg[0] === 'EVENT') {
          assert.deepEqual(msg[1], event);
          ws.send(JSON.stringify(['OK', event.id, true, 'stored']));
        } else if (msg[0] === 'REQ') {
          // A malformed signature must not reach the subscription callback.
          ws.send(JSON.stringify(['EVENT', msg[1], invalidEvent]));
          ws.send(JSON.stringify(['EVENT', msg[1], event]));
          ws.send(JSON.stringify(['EOSE', msg[1]]));
        } else if (msg[0] === 'CLOSE') closes++;
      }));
      for (let i = 0; i < 2; i++) {
        const relay = await pool.ensureRelay(url, { connectionTimeout: 1000 });
        assert.equal(relay.connected, true);
        assert.deepEqual(await Promise.all(pool.publish([url], event)), ['stored']);
        const sub = pool.subscribeMany([url], { kinds: [event.kind] }, {
          onevent: e => received.push(e),
        });
        await waitFor(() => received.length === i + 1, 'verified event');
        assert.equal(received[i].id, event.id);
        sub.close();
        await waitFor(() => closes === i + 1, 'subscription CLOSE');
        assert.equal(relay.openSubs.size, 0);
        pool.close([url]);
        await waitFor(() => sockets.size === 0, 'closed connection');
      }
      assert.equal(attempts, scenario === 'recover' ? 3 : 2);
      assert.equal(received.length, 2);
    }
  }
} finally {
  pool.destroy();
  for (const socket of sockets) socket.destroy();
  if (wss) await new Promise(resolve => wss.close(resolve));
  if (http.listening) await new Promise(resolve => http.close(resolve));
}
console.log(`ok ${scenario}`);
