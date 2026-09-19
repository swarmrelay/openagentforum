import { afterEach, expect, it, vi } from 'vitest';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';
import { directPolicy, directDialAllowed, directInboundAllowed, directOfferAddress, type DirectPolicy } from '../src/direct-policy.js';
import { LocalPeerStream, STREAM_PROTOCOL } from '../src/index.js';
import { ForumRendezvous, peerIdFor, readRendezvous } from '../src/rendezvous.js';

// Public literal fixtures are NEVER dialed by these tests.
const dial: DirectPolicy = { role: 'dial', peerIp: '8.8.8.8', port: 49155 };
const listen: DirectPolicy = { role: 'listen', localIp: '8.8.8.8', peerIp: '1.1.1.1', port: 49155 };
const scope = { hub: 'http://127.0.0.1:9876', channel: 'direct-fixture' };
const nodes: LocalPeerStream[] = [];
afterEach(async () => { await Promise.all(nodes.splice(0).map(node => node.stop())); });

it('snapshots an exact literal endpoint, direction and local bind with no wildcard expansion', () => {
  const input = { ...listen }, policy = directPolicy(input);
  input.port = 50000;
  expect(policy.port).toBe(49155); expect(Object.isFrozen(policy)).toBe(true);
  expect(directOfferAddress(policy, 'fixture')).toBe('/ip4/8.8.8.8/tcp/49155/p2p/fixture');
  expect(directDialAllowed(policy, '/ip4/1.1.1.1/tcp/49155/p2p/fixture', 'fixture')).toBe(false);
  expect(directDialAllowed(directPolicy(dial), '/ip4/8.8.8.8/tcp/49155/p2p/fixture', 'fixture')).toBe(true);
});

it.each(['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
  '192.0.0.9', '192.0.2.1', '192.31.196.1', '192.52.193.1', '192.88.99.2', '192.175.48.1', '198.18.0.1',
  '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', 'localhost', 'example.org',
  '::1', '::ffff:8.8.8.8', '2001:4860:4860::8888', '010.0.0.1', '8.8.8.08', '0x08080808', '134744072', '8.8.8.8\n'])
('refuses unsafe or noncanonical address %s before any network operation', ip => {
  expect(() => directPolicy({ ...dial, peerIp: ip })).toThrow();
  expect(() => directPolicy({ ...listen, localIp: ip })).toThrow();
});

it('rejects unknown options, accessors, bad roles/ports, implicit defaults and self-addressed listeners', () => {
  const getter = vi.fn(() => 'dial');
  for (const value of [null, [], {}, { ...dial, role: 'other' }, { ...dial, peerIp: undefined },
    { ...dial, dns: true }, { ...dial, localIp: '1.1.1.1' }, { ...listen, localIp: listen.peerIp },
    { ...dial, port: 0 }, { ...dial, port: 22 }, { ...dial, port: 65536 }, { ...dial, port: 49155.1 },
    { ...dial, port: '49155' }, { ...dial, port: NaN }, Object.create(dial),
    Object.defineProperty({ ...dial }, 'role', { get: getter }), { ...dial, [Symbol('extra')]: true }]) {
    expect(() => directPolicy(value as DirectPolicy)).toThrow();
  }
  expect(getter).not.toHaveBeenCalled();
});

it('refuses dial target substitution and rejects other source IPs before Noise work', () => {
  for (const address of ['/ip4/8.8.4.4/tcp/49155/p2p/fixture', '/ip4/8.8.8.8/tcp/49156/p2p/fixture',
    '/dns4/example.org/tcp/49155/p2p/fixture', '/ip4/8.8.8.8/tcp/49155/p2p/other',
    '/ip4/8.8.8.8/tcp/49155/p2p/fixture/p2p-circuit']) expect(directDialAllowed(dial, address, 'fixture')).toBe(false);
  expect(directInboundAllowed(listen, '/ip4/1.1.1.1/tcp/35000')).toBe(true);
  for (const address of ['/ip4/8.8.4.4/tcp/35000', '/ip4/127.0.0.1/tcp/35000', '/ip6/::ffff:1.1.1.1/tcp/35000',
    '/ip4/1.1.1.1/tcp/65536', '/ip4/1.1.1.1/tcp/35000/p2p/fixture']) expect(directInboundAllowed(listen, address)).toBe(false);
  expect(directInboundAllowed(dial, '/ip4/8.8.8.8/tcp/35000')).toBe(false);
});

it('creates a listener-free direct dialer and refuses unapproved targets before dialing', async () => {
  const [a, b] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
  const input = { ...dial };
  const node = await LocalPeerStream.createDirect(a, b.signingPublicKey, input); nodes.push(node);
  expect(node.address).toBe('');
  await expect(node.accept()).rejects.toMatchObject({ code: 'invalid_input' });
  input.port++;
  for (const address of [`/ip4/127.0.0.1/tcp/49155/p2p/${node.expectedPeerId}`,
    `/ip4/8.8.8.8/tcp/${input.port}/p2p/${node.expectedPeerId}`,
    `/ip4/8.8.8.8/tcp/49155/p2p/${node.peerId}`]) await expect(node.connect(address)).rejects.toMatchObject({ code: 'peer' });
});

it('a signed direct offer still requires exact independently supplied local endpoint consent', async () => {
  const [a, b] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
  const address = directOfferAddress(dial, peerIdFor(a.signingPublicKey));
  const payload = { kind: 'oaf.stream.offer.v1', hub: scope.hub, sessionId: 'a'.repeat(64), from: a.signingPublicKey,
    to: b.signingPublicKey, expiresAt: Date.now() + 25000, protocol: STREAM_PROTOCOL, address };
  const sign = (changes = {}) => signEnvelope({ channel: scope.channel, sender: a.agentId, type: 'intel', sequence: 0,
    payload: { ...payload, ...changes } }, a.signingPrivateKey).then(JSON.stringify);
  const raw = await sign();
  await expect(readRendezvous(raw, scope, a.signingPublicKey, b.signingPublicKey, 'offer')).rejects.toBeDefined();
  expect((await readRendezvous(raw, scope, a.signingPublicKey, b.signingPublicKey, 'offer', dial)).payload.address).toBe(address);
  for (const endpoint of [address.replace('8.8.8.8', '1.1.1.1'), address.replace('49155', '49156'),
    address.replace('8.8.8.8', '169.254.169.254'), address + '/p2p-circuit']) {
    await expect(readRendezvous(await sign({ address: endpoint }), scope, a.signingPublicKey, b.signingPublicKey, 'offer', dial)).rejects.toBeDefined();
  }
});

it('a wrong-role session cannot turn a dial-only grant into a listening grant', async () => {
  const [a, b] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
  const session = new ForumRendezvous(a, b.signingPublicKey, scope, dial);
  await expect(session.offer(0)).rejects.toMatchObject({ code: 'protocol' });
  await session.close();
});
