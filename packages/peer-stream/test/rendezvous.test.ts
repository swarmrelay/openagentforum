import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';
import { ForumRendezvous, readRendezvous, rendezvousScope } from '../src/rendezvous.js';
import { LocalPeerStream } from '../src/index.js';

const scope = rendezvousScope('http://127.0.0.1:9876', 'rendezvous-fixture');
const sessions: ForumRendezvous[] = [], nodes: LocalPeerStream[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...sessions.splice(0).map(session => session.close()), ...nodes.splice(0).map(node => node.stop())]);
});
async function pair() {
  const [a, b] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
  const alice = new ForumRendezvous(a, b.signingPublicKey, scope), bob = new ForumRendezvous(b, a.signingPublicKey, scope);
  sessions.push(alice, bob);
  return { a, b, alice, bob };
}
async function resign(raw: string, privateKey: string, changes: Record<string, unknown>) {
  const envelope = JSON.parse(raw);
  return JSON.stringify(await signEnvelope({ ...envelope, ...changes }, privateKey));
}

describe('signed forum rendezvous', () => {
  it('binds a real Noise stream to both signed records before returning application bytes', async () => {
    const { alice, bob } = await pair();
    const offer = await alice.offer(0), acceptance = await bob.accept(offer, 0);
    const [a, b] = await Promise.all([alice.wait(acceptance), bob.connect()]);
    await a.send(new Uint8Array([0, 255, 10]));
    expect(await b.receive()).toEqual(new Uint8Array([0, 255, 10]));
    await a.finish(); expect(await b.receive()).toBeNull();
    await b.finish(); expect(await a.receive()).toBeNull();
    await expect(alice.wait(acceptance)).rejects.toMatchObject({ code: 'closed' });
    await expect(bob.accept(offer, 1)).rejects.toMatchObject({ code: 'closed' });
    await expect(bob.connect()).rejects.toMatchObject({ code: 'closed' });
  });

  it('does not connect before explicit acceptance, or implicitly accept a second invitation', async () => {
    const { alice, bob } = await pair();
    await expect(bob.connect()).rejects.toMatchObject({ code: 'closed' });
    const offer = await alice.offer(3); await bob.accept(offer, 8);
    await expect(alice.offer(4)).rejects.toMatchObject({ code: 'closed' });
    await expect(bob.accept(offer, 9)).rejects.toMatchObject({ code: 'closed' });
  });

  it('does not rely on unsigned storedSeq, encrypted flags or top-level replyTo', async () => {
    const { a, b, alice } = await pair();
    const offer = await alice.offer(0), altered = JSON.stringify({ ...JSON.parse(offer), storedSeq: 999, encrypted: true, replyToId: 'fake' });
    expect(await readRendezvous(altered, scope, a.signingPublicKey, b.signingPublicKey, 'offer'))
      .toEqual(await readRendezvous(offer, scope, a.signingPublicKey, b.signingPublicKey, 'offer'));
  });

  it('rejects unsigned tampering, wrong full pins, scope, kind and caller-controlled destinations', async () => {
    const { a, b, alice } = await pair();
    const offer = await alice.offer(0), envelope = JSON.parse(offer);
    for (const change of [{ hub: 'http://127.0.0.1:9877' }, { to: a.signingPublicKey }, { protocol: '/other/1' },
      { address: '/ip4/192.0.2.1/tcp/1234' }, { sessionId: 'a'.repeat(64) }]) {
      await expect(readRendezvous(JSON.stringify({ ...envelope, payload: { ...envelope.payload, ...change } }), scope,
        a.signingPublicKey, b.signingPublicKey, 'offer')).rejects.toBeDefined();
    }
    await expect(readRendezvous(offer, { ...scope, channel: 'other' }, a.signingPublicKey, b.signingPublicKey, 'offer')).rejects.toBeDefined();
    await expect(readRendezvous(offer, scope, b.signingPublicKey, a.signingPublicKey, 'offer')).rejects.toBeDefined();
    await expect(readRendezvous(offer, scope, a.signingPublicKey, b.signingPublicKey, 'accept')).rejects.toBeDefined();
  });

  it('rejects extra/prototype fields, oversize and incorrect values even with a valid author signature', async () => {
    const { a, b, alice } = await pair(); const offer = await alice.offer(0), envelope = JSON.parse(offer);
    for (const change of [{ constructor: 'bad' }, { address: envelope.payload.address + '/p2p-circuit' },
      { address: envelope.payload.address.replace('/ip4/127.0.0.1', '/dns4/localhost') }, { expiresAt: Date.now() + 120_000 },
      { arbitrary: true }, { sessionId: ['wrong'] }, JSON.parse('{"__proto__":"bad"}')]) {
      const raw = await resign(offer, a.signingPrivateKey, { payload: { ...envelope.payload, ...change } });
      await expect(readRendezvous(raw, scope, a.signingPublicKey, b.signingPublicKey, 'offer')).rejects.toBeDefined();
    }
    await expect(readRendezvous(' '.repeat(8193), scope, a.signingPublicKey, b.signingPublicKey, 'offer')).rejects.toBeDefined();
  });

  it('rejects expired and excessively future-issued setup', async () => {
    const { a, b, alice, bob } = await pair(); const offer = await alice.offer(0);
    const envelope = JSON.parse(offer);
    const future = await resign(offer, a.signingPrivateKey, { timestamp: Date.now() + 10_000 });
    await expect(readRendezvous(future, scope, a.signingPublicKey, b.signingPublicKey, 'offer')).rejects.toBeDefined();
    vi.spyOn(Date, 'now').mockReturnValue(envelope.payload.expiresAt);
    await expect(bob.accept(offer, 0)).rejects.toMatchObject({ code: 'protocol' });
  });

  it('rejects a valid acceptance for another transcript before any application stream', async () => {
    const { a, b, alice, bob } = await pair(); const offer = await alice.offer(0), acceptance = await bob.accept(offer, 0);
    const altered = await resign(acceptance, b.signingPrivateKey, { payload: { ...JSON.parse(acceptance).payload, offerHash: 'a'.repeat(64) } });
    await expect(alice.wait(altered)).rejects.toMatchObject({ code: 'protocol' });
    await expect(alice.wait(acceptance)).rejects.toMatchObject({ code: 'closed' });
    expect(a.agentId).not.toBe(b.agentId);
  });

  it('rechecks expiry after signature verification and closes an in-flight local offer', async () => {
    const { a, b, alice, bob } = await pair(); const raw = await alice.offer(0), envelope = JSON.parse(raw);
    vi.spyOn(Date, 'now').mockReturnValueOnce(envelope.timestamp).mockReturnValue(envelope.payload.expiresAt);
    await expect(readRendezvous(raw, scope, a.signingPublicKey, b.signingPublicKey, 'offer')).rejects.toBeDefined();
    vi.restoreAllMocks();
    const offering = expect(bob.offer(0)).rejects.toMatchObject({ code: 'protocol' });
    await bob.close(); await offering;
    await expect(bob.offer(1)).rejects.toMatchObject({ code: 'closed' });
  });

  it('rejects wrong-session bytes from an otherwise correctly authenticated peer', async () => {
    const { a, b, alice, bob } = await pair(); const offer = await alice.offer(0), acceptance = await bob.accept(offer, 0);
    await bob.close();
    const rawPeer = await LocalPeerStream.create(b, a.signingPublicKey); nodes.push(rawPeer);
    const waiting = expect(alice.wait(acceptance)).rejects.toMatchObject({ code: 'protocol' });
    const raw = await rawPeer.connect(JSON.parse(offer).payload.address);
    await raw.receive(); // receive the challenge but supply no matching transcript
    await raw.send(Buffer.from(JSON.stringify({ kind: 'oaf.stream.hello.v1', role: 'acceptor', transcript: '0'.repeat(64), nonce: 'a'.repeat(64) })));
    await waiting;
  });

  it('never restarts a closed session or accepts non-loopback rendezvous hubs', async () => {
    const { alice } = await pair(); await alice.close();
    await expect(alice.offer(0)).rejects.toMatchObject({ code: 'closed' });
    for (const hub of ['https://example.org', 'http://localhost:9876', 'http://127.0.0.1:9876/', 'http://user@127.0.0.1:9876']) {
      expect(() => rendezvousScope(hub, 'fixture')).toThrow();
    }
  });
});
