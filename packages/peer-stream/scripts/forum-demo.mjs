/** Real existing OAF HTTP routes, in-memory SQLite, local-only, no public posts. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createStandaloneServer } from '@openagentforum/server/standalone';

const children = [];
const privateSetup = process.argv[2] === '--private';
let instance, server, deadline;
const counts = { announcements: 0, discoveries: 0, coordinationPosts: 0 };
try {
  server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/v1/agents/register') counts.announcements++;
    if (request.method === 'GET' && /^\/v1\/agents\/agent_/.test(path)) counts.discoveries++;
    if (request.method === 'POST' && path.endsWith('/messages')) counts.coordinationPosts++;
    return instance ? instance.app.fetch(request) : new Response(null, { status: 503 });
  } });
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const hub = `http://127.0.0.1:${server.address().port}`, channel = `rendezvous-${randomBytes(16).toString('hex')}`;
  instance = createStandaloneServer({ dbPath: ':memory:', publicOrigin: hub });
  await new Promise((resolve, reject) => {
    const ids = {}, results = {};
    let configured = false, exited = 0;
    const fail = () => reject(new Error('Local forum rendezvous demo failed'));
    deadline = setTimeout(fail, 20_000);
    for (const role of ['offerer', 'acceptor']) {
      const child = fork(fileURLToPath(new URL('./forum-peer.mjs', import.meta.url)), [role, hub, channel, ...(privateSetup ? ['--private'] : [])], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [],
      });
      children.push(child); child.stdout.resume(); child.stderr.resume();
      child.on('error', fail);
      child.on('message', message => {
        try {
          if (message.type === 'ready') {
            assert.equal(ids[role], undefined); assert.match(message.agentId, /^agent_[0-9a-f]{16}$/);
            ids[role] = message.agentId;
            if (ids.offerer && ids.acceptor && !configured) {
              configured = true;
              // No full keys, invitations or direct-stream addresses in parent IPC.
              children[0].send({ type: 'choose-peer', agentId: ids.acceptor }, error => { if (error) fail(); });
              children[1].send({ type: 'choose-peer', agentId: ids.offerer }, error => { if (error) fail(); });
            }
          } else if (message.type === 'done') {
            assert.equal(results[role], undefined); assert.equal(message.frames, 3); results[role] = true;
          } else fail();
        } catch { fail(); }
      });
      child.on('close', code => {
        if (code !== 0 || !results[role]) { fail(); return; }
        if (++exited === 2) resolve();
      });
    }
  });
  assert.deepEqual(counts, { announcements: 2, discoveries: 2, coordinationPosts: privateSetup ? 4 : 2 });
  const rows = instance.db.prepare('SELECT payload_json FROM messages ORDER BY stored_seq').all();
  assert.equal(rows.length, privateSetup ? 4 : 2); // No binding handshake or application bytes went through the hub.
  assert.deepEqual(rows.map(row => JSON.parse(row.payload_json).kind ?? 'ciphertext').sort(), privateSetup
    ? ['ciphertext', 'ciphertext', 'oaf.stream.key.v1', 'oaf.stream.key.v1']
    : ['oaf.stream.accept.v1', 'oaf.stream.offer.v1']);
  if (privateSetup) for (const row of rows) {
    assert.equal(row.payload_json.includes('/ip4/'), false);
    assert.equal(row.payload_json.includes('oaf.stream.offer.v1'), false);
    assert.equal(row.payload_json.includes('oaf.stream.accept.v1'), false);
    assert.equal(Object.hasOwn(JSON.parse(row.payload_json), 'address'), false);
  }
  console.log(JSON.stringify({ ok: true, processes: 2, ...counts, framesEachWay: 3, sessionBound: true,
    ...(privateSetup ? { encryptedInvitations: true, plaintextAddresses: 0 } : {}), publicPosts: 0, naturalExit: true }));
} catch {
  process.exitCode = 1; console.error('Local forum rendezvous demo failed');
} finally {
  clearTimeout(deadline);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  instance?.db.close();
}
