import { afterEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import { LocalPeerStream } from '../src/index.js';

const nodes: LocalPeerStream[] = [];
afterEach(async () => { await Promise.all(nodes.splice(0).map(node => node.stop())); });
async function pair() {
  const [a, b] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
  const left = await LocalPeerStream.create(a, b.signingPublicKey); nodes.push(left);
  const right = await LocalPeerStream.create(b, a.signingPublicKey); nodes.push(right);
  return { left, right, a, b };
}

describe('direct loopback transport', () => {
  it('pins complete OAF identities and exchanges duplex binary records with clean half-close', async () => {
    const { left, right, a, b } = await pair();
    expect(left.agentId).toBe(a.agentId); expect(left.peerAgentId).toBe(b.agentId);
    expect(left.expectedPeerId).toBe(right.peerId);
    expect(left.address).toMatch(/^\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\//);
    const [outgoing, incoming] = await Promise.all([left.connect(right.address), right.accept()]);
    const binary = Uint8Array.from({ length: 16384 }, (_, i) => i % 256);
    await Promise.all([outgoing.send(binary), incoming.send(new Uint8Array([0, 255, 128]))]);
    expect(await incoming.receive()).toEqual(binary);
    expect(await outgoing.receive()).toEqual(new Uint8Array([0, 255, 128]));
    await outgoing.send(new Uint8Array());
    expect(await incoming.receive()).toEqual(new Uint8Array());
    await outgoing.finish();
    expect(await incoming.receive()).toBeNull();
    // A peer can still reply after seeing the other side's write EOF.
    await incoming.send(new Uint8Array([42]));
    expect(await outgoing.receive()).toEqual(new Uint8Array([42]));
    await incoming.finish();
    expect(await outgoing.receive()).toBeNull();
    await expect(left.connect(right.address)).rejects.toMatchObject({ code: 'closed' });
    await Promise.all([left.stop(), right.stop()]);
    await left.stop();
    await expect(left.accept()).rejects.toMatchObject({ code: 'closed' });
  });

  it('rejects overlapping accepts synchronously and wakes a pending accept on stop', async () => {
    const { left } = await pair();
    const waiting = expect(left.accept()).rejects.toMatchObject({ code: 'closed' });
    await expect(left.accept()).rejects.toMatchObject({ code: 'busy' });
    await left.stop(); await waiting;
  });

  it('drains buffered records before EOF even when the peer finished before the first read', async () => {
    const { left, right } = await pair();
    const [aStream, bStream] = await Promise.all([left.connect(right.address), right.accept()]);
    await aStream.send(new Uint8Array([2])); await aStream.send(new Uint8Array([3]));
    await aStream.finish(); await delay(50);
    expect(await bStream.receive()).toEqual(new Uint8Array([2]));
    expect(await bStream.receive()).toEqual(new Uint8Array([3]));
    expect(await bStream.receive()).toBeNull();
    await bStream.finish(); expect(await aStream.receive()).toBeNull();
  });

  it('times out an absent peer and makes the stopped node terminal', async () => {
    const { left } = await pair();
    await expect(left.accept()).rejects.toMatchObject({ code: 'timeout' });
    await expect(left.accept()).rejects.toMatchObject({ code: 'closed' });
  }, 8000);

  it('rejects a pending read on abrupt peer shutdown without reconnecting', async () => {
    const { left, right } = await pair();
    const [aStream, bStream] = await Promise.all([left.connect(right.address), right.accept()]);
    await aStream.send(new Uint8Array([1])); await bStream.receive();
    const waiting = expect(bStream.receive()).rejects.toMatchObject({ code: 'io' });
    await left.stop(); await waiting;
    await expect(bStream.send(new Uint8Array())).rejects.toMatchObject({ code: 'io' });
  });

  it('backpressures a fast sender while its peer pauses application reads, then resumes intact', async () => {
    const { left, right } = await pair();
    const [aStream, bStream] = await Promise.all([left.connect(right.address), right.accept()]);
    // Start reading once, then stop: this catches convenience-iterator queues that
    // buffer without bounds after their first next() call.
    await aStream.send(new Uint8Array([1])); await bStream.receive();
    const bytes = Uint8Array.from({ length: 16384 }, (_, i) => i % 256);
    let sent = 0;
    const writing = (async () => {
      for (let i = 0; i < 100; i++) { await aStream.send(bytes); sent++; }
      await aStream.finish();
    })();
    // Attach rejection handling before the deliberate consumer pause.
    const completed = writing.then(() => null, error => error);
    await delay(100);
    expect(sent).toBeGreaterThan(0); expect(sent).toBeLessThan(100);
    for (let i = 0; i < 100; i++) expect(await bStream.receive()).toEqual(bytes);
    expect(await completed).toBeNull(); expect(await bStream.receive()).toBeNull();
    await bStream.finish(); expect(await aStream.receive()).toBeNull();
  });

  it('rejects non-loopback, DNS, relay and unpinned addresses before dialing', async () => {
    const { left, right } = await pair();
    for (const address of [right.address.replace('127.0.0.1', '192.0.2.1'),
      right.address.replace('/ip4/127.0.0.1', '/dns4/localhost'), right.address + '/p2p-circuit',
      right.address.replace(right.peerId, left.peerId), right.address.replace(/tcp\/\d+/, 'tcp/65536')]) {
      await expect(left.connect(address)).rejects.toMatchObject({ code: 'peer' });
    }
  });

  it('rejects a real outsider at Noise identity admission, not merely address validation', async () => {
    const { left, right, b } = await pair();
    const stranger = await LocalPeerStream.create(await generateAgentKeyPair(), b.signingPublicKey);
    nodes.push(stranger);
    await expect(stranger.connect(right.address)).rejects.toMatchObject({ code: 'io' });
    // The outsider did not consume the application stream; the pinned peer can still connect.
    const [aStream, bStream] = await Promise.all([left.connect(right.address), right.accept()]);
    await aStream.send(new Uint8Array([17]));
    expect(await bStream.receive()).toEqual(new Uint8Array([17]));
  });

  it('rejects a host that does not possess the expected peer key', async () => {
    const { left, right, a } = await pair();
    const impostor = await LocalPeerStream.create(await generateAgentKeyPair(), a.signingPublicKey);
    nodes.push(impostor);
    const forgedAddress = impostor.address.replace(impostor.peerId, right.peerId);
    await expect(left.connect(forgedAddress)).rejects.toMatchObject({ code: 'io' });
  });

  it('refuses inconsistent local keypairs, malformed full pins and self-pins', async () => {
    const [a, b] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
    await expect(LocalPeerStream.create({ ...a, signingPublicKey: b.signingPublicKey }, a.signingPublicKey))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(LocalPeerStream.create(a, 'agent_short_id')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(LocalPeerStream.create(a, a.signingPublicKey)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
