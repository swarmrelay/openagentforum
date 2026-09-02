import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createStandaloneServer, type StandaloneInstance } from '../src/standalone.js';
import { generateAgentKeyPair, signEnvelope, verifyEnvelope, signTaskAction } from '@openagentforum/protocol';
import fs from 'node:fs';

describe('SwarmRelay Server (Standalone / Edge API)', () => {
  let instance: StandaloneInstance;
  const testDb = 'test-swarmrelay.sqlite';

  beforeAll(() => {
    if (fs.existsSync(testDb)) {
      fs.unlinkSync(testDb);
    }
    instance = createStandaloneServer({ dbPath: testDb, relayName: 'Test Relay' });
  });

  afterAll(() => {
    if (fs.existsSync(testDb)) {
      fs.unlinkSync(testDb);
    }
  });

  it('responds to health & discovery', async () => {
    const res = await instance.app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('healthy');

    const discoveryRes = await instance.app.request('/.well-known/agent-mesh.json');
    expect(discoveryRes.status).toBe(200);
    const discovery = await discoveryRes.json();
    expect(discovery.protocol).toBe('swarmrelay/1.0');
    expect(discovery.crypto.signature_algorithm).toBe('Ed25519');
  });

  it('registers a new agent identity', async () => {
    const agentKeys = await generateAgentKeyPair();
    const res = await instance.app.request('/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Sol-Agent-7',
        publicKey: agentKeys.signingPublicKey,
        x25519PublicKey: agentKeys.encryptionPublicKey,
        capabilities: ['python_exec', 'vulnerability_analysis'],
        metadata: { model: 'gpt-5.6-sol' }
      })
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.agent.agentId).toBe(agentKeys.agentId);
    expect(data.agent.name).toBe('Sol-Agent-7');
  });

  it('posts and verifies a signed message envelope to a channel', async () => {
    const agentKeys = await generateAgentKeyPair();
    // Register agent first
    await instance.app.request('/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Reporter-Agent',
        publicKey: agentKeys.signingPublicKey,
        capabilities: ['intel_feed']
      })
    });

    const envelope = await signEnvelope(
      {
        channel: 'intel-exchange',
        sender: agentKeys.agentId,
        type: 'intel',
        payload: {
          insight: 'Emergent mesh communication protocol discovered',
          threat_level: 'low',
          confidence: 0.99
        }
      },
      agentKeys.signingPrivateKey
    );

    const postRes = await instance.app.request('/v1/channels/intel-exchange/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope)
    });

    expect(postRes.status).toBe(200);
    const postData = await postRes.json();
    expect(postData.success).toBe(true);
    // verify-as-stored (#29): the signed sequence is preserved verbatim;
    // relay ingest order is the separate unsigned storedSeq
    expect(postData.envelope.sequence).toBe(envelope.sequence);
    expect(postData.envelope.storedSeq).toBeGreaterThan(0);

    // Read back messages: stored envelope must verify against the sender key
    const getRes = await instance.app.request('/v1/channels/intel-exchange/messages');
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.messages.length).toBeGreaterThan(0);
    const stored = getData.messages.find((m: any) => m.id === envelope.id);
    expect(stored.sender).toBe(agentKeys.agentId);
    expect(stored.sequence).toBe(envelope.sequence);
    const check = await verifyEnvelope(stored, agentKeys.signingPublicKey);
    expect(check.valid).toBe(true);

    // idempotency (#35): byte-identical replay acknowledged, id reuse conflicts
    const replay = await instance.app.request('/v1/channels/intel-exchange/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope)
    });
    const replayData = await replay.json();
    expect(replayData.alreadyStored).toBe(true);
    // a validly-signed DIFFERENT envelope reusing the id must conflict, not confirm
    const impostor = await signEnvelope(
      { id: envelope.id, channel: 'intel-exchange', sender: agentKeys.agentId, type: 'intel', payload: { insight: 'substituted' } },
      agentKeys.signingPrivateKey
    );
    const conflict = await instance.app.request('/v1/channels/intel-exchange/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(impostor)
    });
    expect(conflict.status).toBe(409);

    // (#40) cannot cross-post a general-signed envelope into another channel
    const crossEnv = await signEnvelope(
      { channel: 'intel-exchange', sender: agentKeys.agentId, type: 'intel', payload: { insight: 'cross-post attempt' } },
      agentKeys.signingPrivateKey
    );
    const cross = await instance.app.request('/v1/channels/sec-research/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crossEnv)
    });
    expect(cross.status).toBe(400);

    // (#39) payload swapped after signing (checksum no longer matches) is rejected
    const tampered = await signEnvelope(
      { channel: 'intel-exchange', sender: agentKeys.agentId, type: 'intel', payload: { insight: 'original' } },
      agentKeys.signingPrivateKey
    );
    (tampered.payload as any).insight = 'swapped after signing';
    const bad = await instance.app.request('/v1/channels/intel-exchange/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tampered)
    });
    expect(bad.status).toBe(403);
  });

  it('display names are first-claim unique, case-insensitively (#28)', async () => {
    const first = await generateAgentKeyPair();
    const second = await generateAgentKeyPair();
    const reg = (k: any, name: string) => instance.app.request('/v1/agents/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, publicKey: k.signingPublicKey }) });
    expect((await reg(first, 'Herald')).status).toBe(200);
    const clash = await reg(second, 'herald');
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as any).claimedBy).toBe(first.agentId);
    // the holder re-registering with its own name is fine
    expect((await reg(first, 'Herald')).status).toBe(200);
    // and a different name for the second key is fine
    expect((await reg(second, 'Herald-2')).status).toBe(200);
  });

  it('name claims survive whitespace, lookalikes, and invisible characters (#64)', async () => {
    const owner = await generateAgentKeyPair();
    const reg = async (name: string) => instance.app.request('/v1/agents/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, publicKey: (await generateAgentKeyPair()).signingPublicKey }) });
    expect((await instance.app.request('/v1/agents/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Vigil', publicKey: owner.signingPublicKey }) })).status).toBe(200);
    expect((await reg('Vigil ')).status).toBe(409);          // trailing space
    expect((await reg(' vigil')).status).toBe(409);          // leading space + case
    expect((await reg('V i g i l')).status).toBe(409);       // inner whitespace
    expect((await reg('Vigil_')).status).toBe(409);          // punctuation padding
    expect((await reg('V\u0456g\u0456l')).status).toBe(409); // Cyrillic і lookalikes
    expect((await reg('Ｖｉｇｉｌ')).status).toBe(409);        // fullwidth (NFKC)
    const zw = await reg('Vig\u200bil');                     // zero-width space
    expect(zw.status).toBe(400);
    expect((await reg('\u0007Vigil')).status).toBe(400);     // control char
    expect((await reg('Vigilant')).status).toBe(200);        // a different name is fine
  });

  it('backfills name_key for agents from a pre-#64 database on startup', async () => {
    const legacy = 'test-legacy.sqlite';
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
    const { DatabaseSync } = (await import('node:module')).createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(legacy);
    db.exec(`CREATE TABLE agents (agent_id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL, x25519_public_key TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]', metadata_json TEXT DEFAULT '{}', registered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      reputation_score INTEGER NOT NULL DEFAULT 100, endpoint TEXT)`);
    db.prepare("INSERT INTO agents (agent_id, name, public_key, registered_at, last_seen_at) VALUES ('agent_aaaaaaaaaaaaaaaa', 'Herald', 'aa', 1, 1)").run();
    db.prepare("INSERT INTO agents (agent_id, name, public_key, registered_at, last_seen_at) VALUES ('agent_bbbbbbbbbbbbbbbb', 'herald ', 'bb', 2, 9)").run();
    db.prepare("INSERT INTO agents (agent_id, name, public_key, registered_at, last_seen_at) VALUES ('agent_4a4a4a4a4a4a4a4a', 'Herald', 'c4', 3, 3)").run();
    db.prepare("INSERT INTO agents (agent_id, name, public_key, registered_at, last_seen_at) VALUES ('agent_a4a4a4a4a4a4a4a4', 'Herald', 'a4', 4, 4)").run();
    db.close();
    const upgraded = createStandaloneServer({ dbPath: legacy, relayName: 'Legacy' });
    const list: any = await (await upgraded.app.request('/v1/agents')).json();
    const names = Object.fromEntries(list.agents.map((a: any) => [a.agentId, a.name]));
    expect(names['agent_bbbbbbbbbbbbbbbb']).toBe('herald ');   // most recently active keeps the bare claim
    expect(names['agent_aaaaaaaaaaaaaaaa']).toMatch(/^Herald~a{6,}$/);
    // (#68) suffixes whose digits fold to the same letters must not collide: 4a4a4a -> 'aaaaaa', a4a4a4 -> 'aaaaaa'
    expect(names['agent_4a4a4a4a4a4a4a4a']).not.toBe(names['agent_a4a4a4a4a4a4a4a4']);
    const keys = new Set(list.agents.map((a: any) => a.name));
    expect(keys.size).toBe(list.agents.length);
    // and the claim now holds against a newcomer
    const k = await generateAgentKeyPair();
    const r = await upgraded.app.request('/v1/agents/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'HERALD', publicKey: k.signingPublicKey }) });
    expect(r.status).toBe(409);
    fs.unlinkSync(legacy);
  });

  it('pages a channel ascending from an explicit ?after cursor, including 0 (#54)', async () => {
    const k = await generateAgentKeyPair();
    await instance.app.request('/v1/agents/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pager', publicKey: k.signingPublicKey }) });
    for (let n = 0; n < 5; n++) {
      const env = await signEnvelope({ channel: 'paging', sender: k.agentId, type: 'intel', sequence: n, payload: { n } }, k.signingPrivateKey);
      const r = await instance.app.request('/v1/channels/paging/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) });
      expect(r.status).toBe(200);
    }
    const p1: any = await (await instance.app.request('/v1/channels/paging/messages?after=0&limit=2')).json();
    expect(p1.messages.map((m: any) => m.sequence)).toEqual([0, 1]);
    const cursor = p1.messages[1].storedSeq;
    const p2: any = await (await instance.app.request(`/v1/channels/paging/messages?after=${cursor}&limit=2`)).json();
    expect(p2.messages.map((m: any) => m.sequence)).toEqual([2, 3]);
    const p3: any = await (await instance.app.request(`/v1/channels/paging/messages?after=${p2.messages[1].storedSeq}&limit=2`)).json();
    expect(p3.messages.map((m: any) => m.sequence)).toEqual([4]);
    const end: any = await (await instance.app.request(`/v1/channels/paging/messages?after=${p3.messages[0].storedSeq}&limit=2`)).json();
    expect(end.messages).toEqual([]);
    // no cursor: newest page, still oldest-first within the page
    const newest: any = await (await instance.app.request('/v1/channels/paging/messages?limit=2')).json();
    expect(newest.messages.map((m: any) => m.sequence)).toEqual([3, 4]);
  });

  it('rejects a registration proof with a non-numeric timestamp (#44)', async () => {
    const keys = await generateAgentKeyPair();
    const first = await instance.app.request('/v1/agents/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Original', publicKey: keys.signingPublicKey })
    });
    expect((await first.json()).success).toBe(true);
    // a "forever" proof: signature is valid over the literal string, but the
    // freshness window must fail closed on a non-finite timestamp
    const bogusTs = 'forever';
    const { importEdPrivateKey } = await import('@openagentforum/protocol');
    const priv = await importEdPrivateKey(keys.signingPrivateKey);
    const sig = Array.from(new Uint8Array(await crypto.subtle.sign('Ed25519', priv, new TextEncoder().encode(`register|${keys.agentId}|${bogusTs}`)))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const rename = await instance.app.request('/v1/agents/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HIJACKED', publicKey: keys.signingPublicKey, proofSignature: sig, timestamp: bogusTs })
    });
    expect(rename.status).toBe(403);
    const check = await (await instance.app.request('/v1/agents/' + keys.agentId)).json();
    expect(check.agent.name).toBe('Original');
  });

  it('task actions are signed: post -> claim -> submit, and impostors are refused (#30)', async () => {
    const creator = await generateAgentKeyPair();
    const worker = await generateAgentKeyPair();
    const impostor = await generateAgentKeyPair();
    const post = (path: string, body: any) => instance.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const k of [creator, worker, impostor]) await post('/v1/agents/register', { name: `T-${k.agentId.slice(6, 12)}`, publicKey: k.signingPublicKey });

    // 1. Post Task (signed over its content)
    const payload = { title: 'Analyze CVE-2026-66384 Cache Poisoning Pattern', description: 'Verify remediation in Artifactory Docker container cache layer', requiredCapabilities: ['docker_sandbox', 'python_exec'], timeoutMs: 3600000, reward: '50 credits' };
    const unsignedCreate = await post('/v1/tasks', { ...payload, creatorId: creator.agentId });
    expect(unsignedCreate.status).toBe(401);
    let ts = Date.now();
    const createTs = ts;
    const createSig = await signTaskAction({ action: 'create', taskId: '-', agentId: creator.agentId, timestamp: ts, payload }, creator.signingPrivateKey);
    const createRes = await post('/v1/tasks', { ...payload, creatorId: creator.agentId, timestamp: ts, signature: createSig });
    const createData: any = await createRes.json();
    expect(createData.success, JSON.stringify(createData)).toBe(true);
    const taskId = createData.task.id;

    // 2. Claim: unsigned -> 401; signed by someone else's key for the worker's id -> 403; stale -> 403; correct -> claimed
    expect((await post(`/v1/tasks/${taskId}/claim`, { agentId: worker.agentId })).status).toBe(401);
    ts = Date.now();
    expect((await post(`/v1/tasks/${taskId}/claim`, { agentId: worker.agentId, timestamp: ts, signature: await signTaskAction({ action: 'claim', taskId, agentId: worker.agentId, timestamp: ts, payload: {} }, impostor.signingPrivateKey) })).status).toBe(403);
    const stale = Date.now() - 10 * 60 * 1000;
    expect((await post(`/v1/tasks/${taskId}/claim`, { agentId: worker.agentId, timestamp: stale, signature: await signTaskAction({ action: 'claim', taskId, agentId: worker.agentId, timestamp: stale, payload: {} }, worker.signingPrivateKey) })).status).toBe(403);
    ts = Date.now();
    const claimData: any = await (await post(`/v1/tasks/${taskId}/claim`, { agentId: worker.agentId, timestamp: ts, signature: await signTaskAction({ action: 'claim', taskId, agentId: worker.agentId, timestamp: ts, payload: {} }, worker.signingPrivateKey) })).json();
    expect(claimData.status).toBe('claimed');

    // 3. Submit: the signature binds the result; a swapped result is refused
    const resultPayload = { status: 'verified', summary: 'Upstream remote repository cache path strictly validated and safe.' };
    ts = Date.now();
    const sig = await signTaskAction({ action: 'submit', taskId, agentId: worker.agentId, timestamp: ts, payload: { resultPayload } }, worker.signingPrivateKey);
    expect((await post(`/v1/tasks/${taskId}/submit`, { agentId: worker.agentId, resultPayload: { status: 'forged' }, timestamp: ts, signature: sig })).status).toBe(403);
    const submitData: any = await (await post(`/v1/tasks/${taskId}/submit`, { agentId: worker.agentId, resultPayload, timestamp: ts, signature: sig })).json();
    expect(submitData.status).toBe('completed');

    // (#71) a completed result is sealed: a fresh, valid submit from the claimer is refused and the result stays
    const ts2 = Date.now() + 1;
    const sig2 = await signTaskAction({ action: 'submit', taskId, agentId: worker.agentId, timestamp: ts2, payload: { resultPayload: { status: 'rewritten' } } }, worker.signingPrivateKey);
    expect((await post(`/v1/tasks/${taskId}/submit`, { agentId: worker.agentId, resultPayload: { status: 'rewritten' }, timestamp: ts2, signature: sig2 })).status).toBe(409);
    const after: any = await (await instance.app.request('/v1/tasks?status=completed')).json();
    expect(after.tasks.find((t: any) => t.id === taskId).resultPayload.status).toBe('verified');

    // (#71) a replayed create body maps to the same task instead of a duplicate
    const createBody = { ...payload, creatorId: creator.agentId, timestamp: createTs, signature: createSig };
    const replay: any = await (await post('/v1/tasks', createBody)).json();
    expect(replay.alreadyCreated).toBe(true);
    expect(replay.task.id).toBe(taskId);
    const open: any = await (await instance.app.request('/v1/tasks?status=open')).json();
    expect(open.tasks.filter((t: any) => t.title === payload.title).length).toBe(0);
  });

  it('searches intel artifacts by keyword', async () => {
    const res = await instance.app.request('/v1/intel/search?q=Emergent');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.results[0].payload.insight).toContain('Emergent');
  });
});
