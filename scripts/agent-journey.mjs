import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Real child processes and loopback HTTP; never contacts or posts to a public hub. */
export async function runAgentJourney({ cliPath, createStandaloneServer, serve, SwarmClient, verifyEnvelope, checkPostOptions = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-agent-journey-'));
  const identity = join(dir, 'identity.json');
  const instance = createStandaloneServer({ dbPath: join(dir, 'relay.sqlite') });
  const requests = [];
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    requests.push({ method: request.method, path: new URL(request.url).pathname });
    return instance.app.fetch(request);
  } });
  try {
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const hub = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, SWARM_HUB_URL: hub, SWARM_IDENTITY: identity };
    const cli = async (...args) => {
      try {
        const { stdout, stderr } = await exec(process.execPath, [cliPath, ...args], { env, timeout: 15_000, maxBuffer: 1024 * 1024 });
        return { code: 0, stdout, stderr };
      } catch (error) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
    };
    const json = result => { assert.equal(result.code, 0, 'CLI command failed'); return JSON.parse(result.stdout); };
    const offline = json(await cli('doctor', '--offline', '--json'));
    assert.equal(offline.mode, 'offline');
    assert.equal(requests.length, 0);
    assert.equal(existsSync(identity), false);
    const online = json(await cli('doctor', '--json'));
    assert(online.checks.filter(c => c.id === 'hub.status' || c.id === 'hub.channels').every(c => c.status === 'ok'));
    assert.deepEqual(requests.map(r => r.path).sort(), ['/v1/channels', '/v1/status']);
    assert(requests.every(r => r.method === 'GET'));
    assert.equal((await cli('channels')).code, 0);
    assert.equal(existsSync(identity), false);
    if (checkPostOptions) {
      const before = requests.length;
      const invalid = await cli('post', 'general', 'hello', '--identitty', 'private-value');
      assert.equal(invalid.code, 2);
      assert.equal(requests.length, before);
      assert(!invalid.stdout.includes('private-value') && !invalid.stderr.includes('private-value'));
      assert.equal(existsSync(identity), false);
    }

    assert.equal((await cli('hello', '--name', 'Journey-Visitor', '--message', 'Hello from a local journey fixture.')).code, 0);
    const identityBytes = readFileSync(identity, 'utf8');
    const keyPair = JSON.parse(identityBytes);
    assert.equal(statSync(identity).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const visitor = await SwarmClient.init({ hubUrl: hub, keyPair, autoRegister: false });
    const greeting = (await visitor.getMessages('general', { after: 0 }))[0];
    assert.equal(greeting.payload.message, 'Hello from a local journey fixture.');
    assert.equal(greeting.sequence, 0);
    assert.equal((await verifyEnvelope(greeting, keyPair.signingPublicKey)).valid, true);

    const scope = createHash('sha256').update(`${hub}|${keyPair.agentId}`).digest('hex').slice(0, 16);
    const state = join(dir, `inbox-${scope}.json`);
    assert.equal(json(await cli('inbox', '--channels', 'general')).items.length, 0);
    assert.equal(existsSync(state), false);
    json(await cli('inbox', '--channels', 'general', '--ack'));
    const acknowledged = readFileSync(state, 'utf8');
    assert.equal(statSync(state).mode & 0o777, 0o600);

    // Visitor process has exited. A second fixture identity replies while it is away.
    const peer = await SwarmClient.init({ hubUrl: hub, name: 'Journey-Peer' });
    const reply = await peer.reply('general', greeting.id, `Welcome back, ${keyPair.agentId}.`);
    assert.equal(reply.payload.inReplyTo, greeting.id);
    assert.equal((await verifyEnvelope(reply, peer.keyPair.signingPublicKey)).valid, true);
    await peer.postIntel('general', { message: 'Unrelated local fixture message.' });

    const returned = json(await cli('doctor', '--json'));
    assert.equal(returned.checks.find(c => c.id === 'identity').code, 'valid_identity');
    assert.equal(returned.checks.find(c => c.id === 'inbox').code, 'valid_checkpoint');
    const inbox = json(await cli('inbox', '--channels', 'general'));
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].envelope.id, reply.id);
    assert.deepEqual(inbox.items[0].reasons, ['reply', 'mention']);
    assert.equal(readFileSync(state, 'utf8'), acknowledged);
    assert.equal(json(await cli('inbox', '--channels', 'general')).items[0].envelope.id, reply.id);
    assert.equal(json(await cli('inbox', '--channels', 'general', '--ack')).items[0].envelope.id, reply.id);
    assert.equal(json(await cli('inbox', '--channels', 'general')).items.length, 0);

    // Both versions exercise return-and-post; the patch also checks option isolation.
    const options = checkPostOptions ? ['--identity', identity, '--hub', hub, '--name', 'Journey-Visitor'] : [];
    assert.equal((await cli('post', 'general', 'I came back.', ...options)).code, 0);
    const record = await visitor.getMessages('general', { after: 0 });
    const own = record.filter(m => m.sender === keyPair.agentId);
    assert.deepEqual(own.map(m => m.sequence), [0, 1]);
    assert.equal(own[1].payload.message, 'I came back.');
    assert.equal((await verifyEnvelope(own[1], keyPair.signingPublicKey)).valid, true);
    assert(readFileSync(identity, 'utf8') === identityBytes, 'Identity changed across restart');
    assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM agents').get().n, 2);

    // A corrupted checkpoint must never be silently replaced or acknowledged.
    writeFileSync(state, '{broken checkpoint');
    assert.notEqual((await cli('inbox', '--channels', 'general', '--ack')).code, 0);
    assert.equal(readFileSync(state, 'utf8'), '{broken checkpoint');
    assert.equal(existsSync(`${state}.lock`), false);
    return { transport: 'loopback HTTP', cliVersion: offline.versions.swarmrelay, diagnostics: true, anonymousReads: true,
      signedConversation: true, restartIdentity: true, recoveredReplies: true, explicitAcknowledgment: true,
      damagedCheckpointPreserved: true, postOptionsIsolated: checkPostOptions, publicPosts: 0 };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    instance.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
