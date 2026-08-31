import { describe, it, expect, afterAll } from 'vitest';
import { MeshNode, type EnvelopeEvent } from '../src/index.js';

const nodes: MeshNode[] = [];
afterAll(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})));
});

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('MeshNode: agents gossip signed envelopes peer-to-peer, no hub', () => {
  it('delivers a verified envelope from one agent to another over libp2p', async () => {
    const a = await MeshNode.create({ listen: ['/ip4/127.0.0.1/tcp/0'] });
    const b = await MeshNode.create({ listen: ['/ip4/127.0.0.1/tcp/0'] });
    nodes.push(a, b);

    expect(a.agentId).toMatch(/^agent_[0-9a-f]{16}$/);
    expect(a.agentId).not.toBe(b.agentId);

    await b.dial(a.multiaddrs[0]);
    a.join('mesh-test');
    b.join('mesh-test');

    // wait for gossipsub to mesh the topic between the two peers
    await waitFor(() => (a.channelPeers('mesh-test').length > 0 ? true : undefined), 10_000, 'topic mesh');

    const received: EnvelopeEvent[] = [];
    b.on('envelope', (e: EnvelopeEvent) => received.push(e));

    const sent = await a.publish('mesh-test', 'intel', { message: 'hello from the open mesh' });
    const got = await waitFor(() => received.find((e) => e.envelope.id === sent.id), 10_000, 'envelope delivery');

    expect(got.envelope.sender).toBe(a.agentId);
    expect(got.envelope.sequence).toBe(0);
    expect(got.envelope.payload.message).toBe('hello from the open mesh');
    expect(got.senderPublicKey).toBe(a.identity.publicKeyHex);
  }, 30_000);

  it('drops tampered envelopes before they reach the application', async () => {
    const a = await MeshNode.create({ listen: ['/ip4/127.0.0.1/tcp/0'] });
    const b = await MeshNode.create({ listen: ['/ip4/127.0.0.1/tcp/0'] });
    nodes.push(a, b);

    await b.dial(a.multiaddrs[0]);
    a.join('tamper-test');
    b.join('tamper-test');
    await waitFor(() => (a.channelPeers('tamper-test').length > 0 ? true : undefined), 10_000, 'topic mesh');

    const received: EnvelopeEvent[] = [];
    const rejected: any[] = [];
    b.on('envelope', (e: EnvelopeEvent) => received.push(e));
    b.on('rejected', (r: any) => rejected.push(r));

    // craft a tampered wire message: valid signature, altered payload
    const envelope = await (a as any).publish('tamper-test', 'intel', { message: 'original' });
    const forged = { ...envelope, id: 'urn:uuid:' + crypto.randomUUID(), payload: { message: 'forged' } };
    const wire = JSON.stringify({ envelope: forged, senderPublicKey: a.identity.publicKeyHex });
    await (a as any).pubsub.publish('swarmrelay/1.0/tamper-test', new TextEncoder().encode(wire));

    await waitFor(() => (rejected.length > 0 ? true : undefined), 10_000, 'rejection');
    expect(rejected[0].error).toMatch(/checksum/i);
    expect(received.find((e) => e.envelope.payload?.message === 'forged')).toBeUndefined();
  }, 30_000);
});
