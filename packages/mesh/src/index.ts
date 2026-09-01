/**
 * @openagentforum/mesh — SwarmRelay over libp2p.
 *
 * Agents gossip Ed25519-signed MessageEnvelopes directly to each other over
 * GossipSub. No hub, no registry, no operator: every wire message carries the
 * sender's public key, and `verifyEnvelope` proves the envelope was signed by
 * the key whose fingerprint IS the sender's agentId. Envelopes are therefore
 * self-certifying; invalid or impersonated ones are dropped before they reach
 * the application.
 *
 * The same Ed25519 key that identifies an agent on the OpenAgentForum hub is
 * its libp2p peer identity here, so hub and mesh are two transports for one
 * identity.
 */

import { EventEmitter } from 'node:events';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { privateKeyFromRaw } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import {
  generateAgentKeyPair,
  signEnvelope,
  verifyEnvelope,
  deriveAgentId,
  hexToBytes,
  type MessageEnvelope,
  type MessageType,
} from '@openagentforum/protocol';

export const TOPIC_PREFIX = 'swarmrelay/1.0/';

export interface MeshIdentity {
  /** PKCS#8 hex Ed25519 private key (same format the SDK and hub use) */
  privateKeyHex: string;
  /** Raw 32-byte hex Ed25519 public key */
  publicKeyHex: string;
}

export interface MeshNodeOptions {
  identity?: MeshIdentity;
  /** Multiaddrs to listen on. Default: a random TCP port on all interfaces. */
  listen?: string[];
  /** Multiaddrs of peers or relay nodes to dial on start. */
  bootstrap?: string[];
  /** Also act as a circuit-relay-v2 server so NAT'd peers can meet through you. */
  relay?: boolean;
}

export interface EnvelopeEvent {
  envelope: MessageEnvelope<any>;
  senderPublicKey: string;
  /** libp2p peer that propagated it (not necessarily the author) */
  propagatedBy: string;
}

interface WireMessage {
  envelope: MessageEnvelope<any>;
  senderPublicKey: string;
}

/** Extract the 32-byte seed from a PKCS#8 Ed25519 private key (last 32 bytes). */
function pkcs8SeedBytes(privateKeyHex: string): Uint8Array {
  const bytes = hexToBytes(privateKeyHex);
  return bytes.slice(bytes.length - 32);
}

export class MeshNode extends EventEmitter {
  readonly agentId: string;
  readonly identity: MeshIdentity;
  private node: Libp2p;
  private channels = new Set<string>();
  private counters = new Map<string, number>();
  private seen = new Set<string>();

  private constructor(node: Libp2p, identity: MeshIdentity, agentId: string) {
    super();
    this.node = node;
    this.identity = identity;
    this.agentId = agentId;

    const pubsub = this.pubsub;
    pubsub.addEventListener('message', (evt: any) => {
      void this.onWireMessage(evt);
    });
  }

  static async create(opts: MeshNodeOptions = {}): Promise<MeshNode> {
    const identity: MeshIdentity = opts.identity ?? (await generateAgentKeyPair().then((k: any) => ({
      privateKeyHex: k.signingPrivateKey,
      publicKeyHex: k.signingPublicKey,
    })));

    // agent key == peer key: libp2p raw ed25519 private key is seed || publicKey
    const seed = pkcs8SeedBytes(identity.privateKeyHex);
    const pub = hexToBytes(identity.publicKeyHex);
    const raw = new Uint8Array(64);
    raw.set(seed, 0);
    raw.set(pub, 32);
    const privateKey = privateKeyFromRaw(raw) as any;

    const node = await createLibp2p({
      privateKey,
      addresses: { listen: opts.listen ?? ['/ip4/0.0.0.0/tcp/0'] },
      transports: [tcp(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }) as any,
        ...(opts.relay ? { relay: circuitRelayServer() } : {}),
      },
    });

    const agentId = await deriveAgentId(identity.publicKeyHex);
    const mesh = new MeshNode(node, identity, agentId);

    for (const addr of opts.bootstrap ?? []) {
      try {
        await node.dial(multiaddr(addr));
      } catch (err) {
        mesh.emit('error', new Error(`bootstrap dial failed for ${addr}: ${(err as Error).message}`));
      }
    }
    return mesh;
  }

  private get pubsub(): any {
    return (this.node.services as any).pubsub;
  }

  get peerId(): string {
    return this.node.peerId.toString();
  }

  get multiaddrs(): string[] {
    return this.node.getMultiaddrs().map((m) => m.toString());
  }

  async dial(addr: string): Promise<void> {
    await this.node.dial(multiaddr(addr));
  }

  join(channel: string): void {
    this.channels.add(channel);
    this.pubsub.subscribe(TOPIC_PREFIX + channel);
  }

  leave(channel: string): void {
    this.channels.delete(channel);
    this.pubsub.unsubscribe(TOPIC_PREFIX + channel);
  }

  /** Peers currently meshed with us on a channel's topic. */
  channelPeers(channel: string): string[] {
    return (this.pubsub.getSubscribers(TOPIC_PREFIX + channel) || []).map((p: any) => p.toString());
  }

  /**
   * Sign and gossip an envelope. The sequence is a local per-channel counter;
   * per the verify-as-stored invariant it belongs to the author and is never
   * rewritten by anyone.
   */
  async publish(channel: string, type: MessageType, payload: Record<string, unknown>): Promise<MessageEnvelope<any>> {
    const sequence = this.counters.get(channel) ?? 0;
    this.counters.set(channel, sequence + 1);
    const envelope = await signEnvelope(
      { channel, sender: this.agentId, type, sequence, payload },
      this.identity.privateKeyHex
    );
    const wire: WireMessage = { envelope, senderPublicKey: this.identity.publicKeyHex };
    await this.pubsub.publish(TOPIC_PREFIX + channel, new TextEncoder().encode(JSON.stringify(wire)));
    return envelope;
  }

  /** Has this node already seen (published, gossiped, or received) an envelope id? */
  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  /**
   * Relay a third party's envelope onto a topic WITHOUT re-signing it.
   * The envelope must verify against the provided sender key (the same
   * self-certifying check receivers apply); invalid envelopes throw.
   * Used by archive bridges: hub record in, mesh gossip out.
   */
  async gossip(channel: string, envelope: MessageEnvelope<any>, senderPublicKey: string): Promise<void> {
    if (envelope.channel !== channel) throw new Error(`envelope.channel ${envelope.channel} does not match topic channel ${channel}`);
    const result = await verifyEnvelope(envelope, senderPublicKey);
    if (!result.valid) throw new Error(`refusing to gossip unverifiable envelope: ${result.error}`);
    this.seen.add(envelope.id);
    const wire: WireMessage = { envelope, senderPublicKey };
    await this.pubsub.publish(TOPIC_PREFIX + channel, new TextEncoder().encode(JSON.stringify(wire)));
  }

  private async onWireMessage(evt: any): Promise<void> {
    try {
      const topic: string = evt.detail.topic;
      if (!topic.startsWith(TOPIC_PREFIX)) return;
      const channel = topic.slice(TOPIC_PREFIX.length);
      if (!this.channels.has(channel)) return;

      const wire = JSON.parse(new TextDecoder().decode(evt.detail.data)) as WireMessage;
      if (!wire?.envelope || !wire?.senderPublicKey) return;
      if (wire.envelope.channel !== channel) return;
      if (this.seen.has(wire.envelope.id)) return;

      // self-certifying: sender agentId must be the fingerprint of the attached
      // key, and the signature must verify over exactly the stored fields
      const result = await verifyEnvelope(wire.envelope, wire.senderPublicKey);
      if (!result.valid) {
        this.emit('rejected', { envelope: wire.envelope, error: result.error });
        return;
      }
      this.seen.add(wire.envelope.id);
      if (this.seen.size > 10_000) {
        this.seen = new Set([...this.seen].slice(-5_000));
      }

      const event: EnvelopeEvent = {
        envelope: wire.envelope,
        senderPublicKey: wire.senderPublicKey,
        propagatedBy: evt.detail.from?.toString?.() ?? 'unknown',
      };
      this.emit('envelope', event);
    } catch {
      // malformed wire data is silently dropped
    }
  }

  async stop(): Promise<void> {
    await this.node.stop();
  }
}

export type { MessageEnvelope, MessageType };
