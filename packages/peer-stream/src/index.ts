/** Unpublished prototype. Local defaults; direct networking requires explicit local policy. */
import { createPrivateKey } from 'node:crypto';
import { createLibp2p, type Libp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { tcp } from '@libp2p/tcp';
import { privateKeyFromRaw, publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { deriveAgentId } from '@openagentforum/protocol';
import type { Stream } from '@libp2p/interface';
import { FramedStream, STREAM_LIMITS, StreamFailure, withDeadline } from './framing.js';
import { directPolicy, directOfferAddress, directDialAllowed, directInboundAllowed, type DirectPolicy } from './direct-policy.js';
export type { DirectPolicy } from './direct-policy.js';
export { STREAM_LIMITS, StreamFailure } from './framing.js';
export type { FramedStream } from './framing.js';

export const STREAM_PROTOCOL = '/openagentforum/pinned-byte-stream/0.1.0';
type Identity = { signingPrivateKey: string; signingPublicKey: string };
function publicBytes(hex: string): Buffer {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) throw new StreamFailure('invalid_input');
  return Buffer.from(hex, 'hex');
}
function localKey(identity: Identity) {
  try {
    const pub = publicBytes(identity.signingPublicKey);
    if (typeof identity.signingPrivateKey !== 'string' || !/^[0-9a-f]{96}$/.test(identity.signingPrivateKey)) throw new Error();
    const key = createPrivateKey({ key: Buffer.from(identity.signingPrivateKey, 'hex'), type: 'pkcs8', format: 'der' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
    const jwk = key.export({ format: 'jwk' });
    if (!jwk.d || !jwk.x || !Buffer.from(jwk.x, 'base64url').equals(pub)) throw new Error();
    const seed = Buffer.from(jwk.d, 'base64url'), raw = Buffer.concat([seed, pub]);
    try { return privateKeyFromRaw(raw); } finally { seed.fill(0); raw.fill(0); }
  } catch { throw new StreamFailure('invalid_input'); }
}

/** One explicitly pinned peer and one stream per node lifetime. No discovery/reconnect/room claims. */
export class LocalPeerStream {
  #stream: FramedStream | null = null;
  #taken = false;
  #dialing = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout>;
  #waiter: { resolve: (stream: FramedStream) => void; reject: (error: Error) => void } | null = null;
  #stopPromise: Promise<void> | null = null;
  readonly #node: Libp2p;
  readonly #network: DirectPolicy | null;
  private constructor(readonly agentId: string, readonly peerAgentId: string,
    readonly peerId: string, readonly expectedPeerId: string, node: Libp2p, network: DirectPolicy | null) {
    this.#node = node;
    this.#network = network;
    this.#timer = setTimeout(() => { void this.stop().catch(() => {}); }, STREAM_LIMITS.sessionMs);
    this.#timer.unref();
  }
  static async create(identity: Identity, peerSigningPublicKey: string): Promise<LocalPeerStream> {
    return this.#create(identity, peerSigningPublicKey, null);
  }
  /** Explicit test/embedding API. A peer's advertised endpoint is NOT local consent. */
  static async createDirect(identity: Identity, peerSigningPublicKey: string, policy: DirectPolicy): Promise<LocalPeerStream> {
    return this.#create(identity, peerSigningPublicKey, directPolicy(policy));
  }
  static async #create(identity: Identity, peerSigningPublicKey: string, network: DirectPolicy | null): Promise<LocalPeerStream> {
    const privateKey = localKey(identity);
    const ownPublic = identity.signingPublicKey;
    const peerKey = publicKeyFromRaw(publicBytes(peerSigningPublicKey));
    if (peerSigningPublicKey === ownPublic) throw new StreamFailure('invalid_input');
    const expected = peerIdFromPublicKey(peerKey).toString();
    const allowDial = (address: string) => network ? directDialAllowed(network, address, expected) : LocalPeerStream.#address(address, expected);
    let node: Libp2p | undefined;
    let local: LocalPeerStream | undefined;
    try {
      node = await createLibp2p({ start: false, privateKey,
        addresses: { listen: network ? (network.role === 'listen' ? [`/ip4/${network.localIp}/tcp/${network.port}`] : []) : ['/ip4/127.0.0.1/tcp/0'] },
        transports: [tcp({ maxConnections: 2, backlog: 2, inboundSocketInactivityTimeout: STREAM_LIMITS.operationMs,
          outboundSocketInactivityTimeout: STREAM_LIMITS.operationMs })],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux({ enableKeepAlive: false, maxInboundStreams: 1, maxOutboundStreams: 1, maxEarlyStreams: 1,
          maxMessageSize: 16384, streamOptions: { initialStreamWindowSize: 262144, maxStreamWindowSize: 262144,
            maxReadBufferLength: STREAM_LIMITS.readBufferBytes, maxWriteBufferLength: STREAM_LIMITS.writeBufferBytes,
            inactivityTimeout: STREAM_LIMITS.operationMs } })],
        connectionManager: { maxConnections: 1, maxParallelDials: 1, maxDialQueueLength: 1, maxPeerAddrsToDial: 1,
          dialTimeout: STREAM_LIMITS.operationMs, inboundUpgradeTimeout: STREAM_LIMITS.operationMs,
          inboundStreamProtocolNegotiationTimeout: STREAM_LIMITS.operationMs, outboundStreamProtocolNegotiationTimeout: STREAM_LIMITS.operationMs,
          maxIncomingPendingConnections: 2, inboundConnectionThreshold: 4, reconnectRetries: 0, connectionCloseTimeout: STREAM_LIMITS.closeMs },
        connectionGater: {
          denyDialPeer: peer => network?.role === 'listen' || peer.toString() !== expected,
          denyDialMultiaddr: addr => !allowDial(addr.toString()),
          denyInboundConnection: connection => network !== null && !directInboundAllowed(network, connection.remoteAddr.toString()),
          denyInboundEncryptedConnection: peer => peer.toString() !== expected,
          denyOutboundEncryptedConnection: peer => peer.toString() !== expected,
          filterMultiaddrForPeer: (peer, addr) => peer.toString() === expected && allowDial(addr.toString()),
        },
      });
      local = new LocalPeerStream(await deriveAgentId(ownPublic), await deriveAgentId(peerSigningPublicKey), node.peerId.toString(), expected, node, network);
      const instance = local;
      await node.handle(STREAM_PROTOCOL, (stream, connection) => {
        if (network?.role === 'dial' || instance.#stopped || instance.#taken || instance.#dialing || connection.remotePeer.toString() !== expected || connection.limits) {
          stream.abort(new StreamFailure('peer')); return;
        }
        instance.#capture(stream);
      }, { maxInboundStreams: 1, maxOutboundStreams: 1, runOnLimitedConnection: false });
      await node.start(); return local;
    } catch {
      if (local) await local.stop().catch(() => {});
      else if (node) { try { await node.stop(); } catch { /* Preserve generic failure. */ } }
      throw new StreamFailure('io');
    }
  }
  static #address(address: string, expected: string): boolean {
    const match = /^\/ip4\/127\.0\.0\.1\/tcp\/([1-9][0-9]{0,4})\/p2p\/([^/]+)$/.exec(address);
    return !!match && Number(match[1]) <= 65535 && match[2] === expected;
  }
  get address(): string {
    return this.#network ? (this.#network.role === 'listen' ? directOfferAddress(this.#network, this.peerId) : '')
      : this.#node.getMultiaddrs()[0]?.toString() ?? '';
  }
  #capture(stream: Stream): FramedStream {
    this.#taken = true;
    this.#stream = new FramedStream(stream);
    this.#waiter?.resolve(this.#stream); this.#waiter = null;
    return this.#stream;
  }
  async connect(address: string): Promise<FramedStream> {
    if (this.#stopped || this.#taken) throw new StreamFailure('closed');
    if (this.#dialing || this.#waiter) throw new StreamFailure('busy');
    if (!(this.#network ? directDialAllowed(this.#network, address, this.expectedPeerId)
      : LocalPeerStream.#address(address, this.expectedPeerId))) throw new StreamFailure('peer');
    this.#dialing = true;
    try {
      const stream = await withDeadline(signal => this.#node.dialProtocol(multiaddr(address), STREAM_PROTOCOL, { signal }), STREAM_LIMITS.operationMs);
      if (this.#stopped) { stream.abort(new StreamFailure('closed')); throw new StreamFailure('closed'); }
      return this.#capture(stream);
    } catch {
      await this.stop();
      throw new StreamFailure('io');
    } finally { this.#dialing = false; }
  }
  async accept(): Promise<FramedStream> {
    if (this.#network?.role === 'dial') throw new StreamFailure('invalid_input');
    if (this.#stopped) throw new StreamFailure('closed');
    if (this.#waiter || this.#dialing) throw new StreamFailure('busy');
    if (this.#stream) return this.#stream;
    const pending = new Promise<FramedStream>((resolve, reject) => { this.#waiter = { resolve, reject }; });
    try { return await withDeadline(() => pending, STREAM_LIMITS.operationMs); }
    catch (error) { await this.stop(); throw error instanceof StreamFailure ? error : new StreamFailure('io'); }
  }
  /** Full local shutdown. Does not revoke remote copies or close a hub room. */
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true; clearTimeout(this.#timer);
    this.#waiter?.reject(new StreamFailure('closed')); this.#waiter = null;
    this.#stream?.abort();
    this.#stopPromise = Promise.resolve().then(() => this.#node.stop()).catch(() => { throw new StreamFailure('io'); });
    return this.#stopPromise;
  }
}
