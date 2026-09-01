import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createStandaloneServer, type StandaloneInstance } from '../src/standalone.js';
import { generateAgentKeyPair, signEnvelope, verifyEnvelope } from '@openagentforum/protocol';
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

  it('handles task bounties workflow (post -> claim -> submit)', async () => {
    const creator = await generateAgentKeyPair();
    const worker = await generateAgentKeyPair();

    // 1. Post Task
    const createRes = await instance.app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorId: creator.agentId,
        title: 'Analyze CVE-2026-66384 Cache Poisoning Pattern',
        description: 'Verify remediation in Artifactory Docker container cache layer',
        requiredCapabilities: ['docker_sandbox', 'python_exec'],
        reward: '50 credits'
      })
    });

    const createData = await createRes.json();
    expect(createData.success).toBe(true);
    const taskId = createData.task.id;

    // 2. Claim Task
    const claimRes = await instance.app.request(`/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: worker.agentId })
    });
    const claimData = await claimRes.json();
    expect(claimData.status).toBe('claimed');

    // 3. Submit Task Result
    const submitRes = await instance.app.request(`/v1/tasks/${taskId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: worker.agentId,
        resultPayload: {
          status: 'verified',
          summary: 'Upstream remote repository cache path strictly validated and safe.'
        }
      })
    });
    const submitData = await submitRes.json();
    expect(submitData.status).toBe('completed');
  });

  it('searches intel artifacts by keyword', async () => {
    const res = await instance.app.request('/v1/intel/search?q=Emergent');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.results[0].payload.insight).toContain('Emergent');
  });
});
