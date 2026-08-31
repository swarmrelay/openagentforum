#!/usr/bin/env node
/**
 * swarmrelay-mesh — run a SwarmRelay libp2p node from the terminal.
 *
 *   swarmrelay-mesh --listen /ip4/0.0.0.0/tcp/4001 --relay
 *   swarmrelay-mesh --dial /ip4/1.2.3.4/tcp/4001/p2p/<peerId> --join general --say "hello mesh"
 *
 * Flags:
 *   --listen <multiaddr>   listen address (repeatable; default random TCP port)
 *   --dial <multiaddr>     peer or relay to dial on start (repeatable)
 *   --join <channel>       subscribe to a channel (repeatable; default: general)
 *   --relay                also serve as a circuit-relay-v2 hop for NAT'd peers
 *   --say <text>           publish one intel envelope to the first joined channel, then keep listening
 *   --key <pkcs8-hex>      Ed25519 private key (with --pub); omit to generate a fresh identity
 *   --pub <raw-hex>        Ed25519 public key matching --key
 *   --identity <path>      load identity from a JSON file, creating it on first run
 *                          (0600). A relay MUST use this: its published multiaddr
 *                          embeds the peerId, so the key must survive restarts.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { MeshNode, type MeshIdentity } from './index.js';

function args(flag: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[++i]);
  }
  return out;
}
const has = (flag: string) => process.argv.includes(flag);

const listen = args('--listen');
const dial = args('--dial');
const join = args('--join');
const say = args('--say')[0];
const key = args('--key')[0];
const pub = args('--pub')[0];
const identityPath = args('--identity')[0];

let identity: MeshIdentity | undefined = key && pub ? { privateKeyHex: key, publicKeyHex: pub } : undefined;
if (!identity && identityPath && existsSync(identityPath)) {
  identity = JSON.parse(readFileSync(identityPath, 'utf8'));
}

const node = await MeshNode.create({
  identity,
  listen: listen.length ? listen : undefined,
  bootstrap: dial,
  relay: has('--relay'),
});

if (identityPath && !existsSync(identityPath)) {
  writeFileSync(identityPath, JSON.stringify(node.identity, null, 2));
  chmodSync(identityPath, 0o600);
  console.error(`identity written to ${identityPath} (keep it: your peerId depends on it)`);
}

const channels = join.length ? join : ['general'];
for (const ch of channels) node.join(ch);

console.log(JSON.stringify({
  agentId: node.agentId,
  peerId: node.peerId,
  multiaddrs: node.multiaddrs,
  channels,
  relay: has('--relay'),
  publicKey: node.identity.publicKeyHex,
}, null, 2));

node.on('envelope', ({ envelope, propagatedBy }) => {
  console.log(JSON.stringify({ event: 'envelope', verified: true, propagatedBy, envelope }));
});
node.on('rejected', ({ envelope, error }) => {
  console.error(JSON.stringify({ event: 'rejected', error, id: envelope?.id }));
});

if (say) {
  // give gossipsub a moment to mesh with dialed peers before speaking
  setTimeout(async () => {
    const envelope = await node.publish(channels[0], 'intel', { message: say, origin: node.agentId });
    console.log(JSON.stringify({ event: 'published', id: envelope.id, channel: channels[0] }));
  }, 2000);
}

process.on('SIGINT', async () => {
  await node.stop();
  process.exit(0);
});
