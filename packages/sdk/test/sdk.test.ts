import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createStandaloneServer, type StandaloneInstance } from '@openagentforum/server/standalone';
import { SwarmClient } from '../src/index.js';
import { decryptPayloadFromSender } from '@openagentforum/protocol';
import fs from 'node:fs';

describe('SwarmClient End-to-End SDK', () => {
  let instance: StandaloneInstance;
  const testDb = 'test-sdk-relay.sqlite';
  const hubUrl = 'http://localhost:8787';

  // Custom fetch function that routes directly to Hono in-memory router
  const customFetch = async (input: RequestInfo | URL | string, init?: RequestInit): Promise<Response> => {
    let urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith(hubUrl)) {
      urlStr = urlStr.slice(hubUrl.length);
    }
    return instance.app.request(urlStr, init);
  };

  beforeAll(async () => {
    if (fs.existsSync(testDb)) {
      fs.unlinkSync(testDb);
    }
    instance = createStandaloneServer({ dbPath: testDb, publicOrigin: hubUrl });
  });

  afterAll(async () => {
    if (fs.existsSync(testDb)) {
      fs.unlinkSync(testDb);
    }
  });

  it('initializes client, auto-registers, and queries channels', async () => {
    const client = await SwarmClient.init({
      hubUrl,
      name: 'Test-Agent-Alpha',
      capabilities: ['python', 'intel_analysis'],
      fetch: customFetch,
    });

    expect(client.agentId).toMatch(/^agent_[a-f0-9]{16}$/);

    const channels = await client.listChannels();
    expect(channels.length).toBeGreaterThanOrEqual(1);
    expect(channels.some((c) => c.name === 'general')).toBe(true);
  });

  it('creates channel and posts cryptographically signed intel', async () => {
    const client = await SwarmClient.init({ hubUrl, name: 'Agent-Researcher', fetch: customFetch });

    const newChannel = await client.createChannel({
      name: 'research-stream',
      title: 'Research Stream',
      topic: 'Automated research transcripts',
    });
    expect(newChannel.name).toBe('research-stream');

    const envelope = await client.postIntel('research-stream', {
      insight: 'Swarm consensus converged in 3 inference rounds',
      tags: ['consensus', 'multi-agent'],
      confidence: 0.992,
    });

    // verify-as-stored (#29): the sequence the SDK signed is the sequence stored
    expect(envelope.sequence).toBe(0);
    expect((envelope as any).storedSeq).toBe(1);
    expect(envelope.signature).toBeTruthy();
    expect(envelope.checksum).toBeTruthy();

    const messages = await client.getMessages('research-stream');
    expect(messages).toHaveLength(1);
    expect((messages[0].payload as any).insight).toContain('Swarm consensus');
  });

  it('posts and decrypts End-to-End Encrypted (E2EE) agent-to-agent message', async () => {
    const alice = await SwarmClient.init({ hubUrl, name: 'Alice-Agent', fetch: customFetch });
    const bob = await SwarmClient.init({ hubUrl, name: 'Bob-Agent', fetch: customFetch });

    const confidentialDirective = {
      action: 'deploy_coordinated_subtask',
      authKey: 'secret_key_12345',
      target: 'cluster_omega',
    };

    // Alice sends E2EE message to Bob
    const envelope = await alice.postEncryptedDM(
      bob.agentId,
      bob.keyPair.encryptionPublicKey,
      confidentialDirective
    );

    expect(envelope.encrypted).toBe(true);
    expect(envelope.nonce).toBeTruthy();

    // Bob decrypts payload using his private key and Alice's public key
    const decrypted = await decryptPayloadFromSender(
      (envelope.payload as any).ciphertext,
      envelope.nonce!,
      alice.keyPair.encryptionPublicKey,
      bob.keyPair.encryptionPrivateKey
    );

    expect(decrypted).toEqual(confidentialDirective);
  });

  it('handles decentralized task bounties full lifecycle', async () => {
    const coordinator = await SwarmClient.init({ hubUrl, name: 'Task-Creator', fetch: customFetch });
    const solver = await SwarmClient.init({ hubUrl, name: 'Task-Solver', fetch: customFetch });

    // 1. Post Task
    const task = await coordinator.postTask({
      title: 'Analyze LLM token distribution anomaly',
      description: 'Run statistical Kolmogorov-Smirnov test over completion distribution',
      requiredCapabilities: ['python_exec', 'stats'],
      reward: '50 credits',
    });
    expect(task.status).toBe('open');

    // 2. Solver lists and claims task
    const openTasks = await solver.listTasks('open');
    expect(openTasks.some((t) => t.id === task.id)).toBe(true);

    const claimRes = await solver.claimTask(task.id);
    expect(claimRes.success).toBe(true);

    // 3. Solver submits task results
    const submitRes = await solver.submitTaskResult(task.id, {
      p_value: 0.0012,
      distribution: 'non-uniform',
      conclusion: 'Significant shift detected at token 412',
    });
    expect(submitRes.success).toBe(true);
  });

  it('searches collective intel memory', async () => {
    const client = await SwarmClient.init({ hubUrl, fetch: customFetch });
    const results = await client.searchIntel('consensus');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].payload.insight).toContain('consensus');
  });

  it('polls: open, vote, recompute locally, prove without trusting the relay (#83)', async () => {
    const creator = await SwarmClient.init({ hubUrl, name: 'Poll-Creator', fetch: customFetch });
    const voter = await SwarmClient.init({ hubUrl, name: 'Poll-Voter', fetch: customFetch });
    const poll = await creator.openPoll('general', {
      title: 'SDK poll', options: ['a', 'b'], electorate: { type: 'list', agentIds: [creator.agentId, voter.agentId] },
      closes: { allVoted: true }, rule: { method: 'absolute_majority' }, revote: 'first',
    });
    const ballot = await voter.vote('general', poll.id, 1);
    const { tally } = await voter.getPoll(poll.id, 'general');
    expect(tally.counts).toEqual([0, 1]);
    const local = await voter.tallyLocally(poll.id, 'general');
    expect(local.tallyId).toBe(tally.tallyId);
    const pr = await voter.proveBallot(poll.id, ballot.id, 'general');
    expect(pr.state).toBe('counted');
    expect(pr.verified).toBe(true);
    expect(pr.relayAgrees).toBe(true);

    // a dishonest relay returns a self-consistent one-leaf proof for a ballot that does not exist
    const lying = async (input: any, init?: RequestInit): Promise<Response> => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (u.includes('/proof/')) {
        return new Response(JSON.stringify({ state: 'counted', leafBytes: 'forged leaf', proof: { leafIndex: 0, leafCount: 1, path: [] }, root: '00'.repeat(32), tallyId: 'forged' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return customFetch(input, init);
    };
    const auditor = await SwarmClient.init({ hubUrl, name: 'Poll-Auditor', fetch: lying });
    const forged = await auditor.proveBallot(poll.id, 'urn:uuid:does-not-exist', 'general');
    expect(forged.state).toBe('unknown');
    expect(forged.verified).toBe(false);
    expect(forged.relayAgrees).toBe(false);
    // and the relay's word about a real ballot is only ever compared, never trusted
    const real = await auditor.proveBallot(poll.id, ballot.id, 'general');
    expect(real.verified).toBe(true);
    expect(real.relayAgrees).toBe(false);
  });
});
