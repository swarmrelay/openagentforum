import { AbstractSimplePool, type AbstractPoolConstructorOptions } from 'nostr-tools/abstract-pool';
import { verifyEvent } from 'nostr-tools/pure';
import WebSocket, { type ClientOptions } from 'ws';

// Node's built-in WebSocket in Node 22 can synchronously re-enter the
// nostr-tools 2.25.2 close-on-error handler (#248). Inject a maintained Node
// implementation per pool; never replace globalThis.WebSocket or patch a
// dependency's installed files. These are per-socket bounds, not shared bridge
// admission/queue budgets (tracked separately in #240).
const socketOptions = {
  handshakeTimeout: 3000,
  closeTimeout: 1000,
  maxPayload: 1024 * 1024,
  maxFragments: 128,
  maxBufferedChunks: 1024,
  perMessageDeflate: false,
  followRedirects: false,
} satisfies ClientOptions & { closeTimeout: number; maxFragments: number; maxBufferedChunks: number };

class NostrWebSocket extends WebSocket {
  constructor(url: string) {
    super(url, socketOptions);
    // nostr-tools clears its DOM-style onerror during close. ws can then emit
    // the asynchronous "closed before established" error. Keep a socket-local
    // listener so that expected teardown is not an unhandled EventEmitter
    // error. Active failures still reach nostr-tools' onerror and reject the
    // operation; no process-level exception/rejection handlers are installed.
    this.on('error', () => {});
  }
}

/** Node-only pool, retaining the existing SimplePool constructor options. */
export class SimplePool extends AbstractSimplePool {
  constructor(options: Pick<AbstractPoolConstructorOptions, 'enablePing' | 'enableReconnect'> = {}) {
    super({
      ...options,
      verifyEvent,
      // Upstream types name the DOM class (including unused dispatchEvent).
      // ws implements the event-property/socket subset the relay uses; real
      // socket regressions cover it, including early close and failed dials.
      websocketImplementation: NostrWebSocket as unknown as typeof globalThis.WebSocket,
      maxWaitForConnection: 3000,
    });
  }

  override ensureRelay(url: string, params?: Parameters<AbstractSimplePool['ensureRelay']>[1]) {
    // Upstream ensureRelay has no default timeout, unlike subscribe/publish.
    // Keep pending operations bounded even if destroy clears socket callbacks.
    const requested = params?.connectionTimeout;
    const connectionTimeout = requested !== undefined && Number.isFinite(requested) && requested > 0
      ? Math.min(requested, socketOptions.handshakeTimeout)
      : socketOptions.handshakeTimeout;
    return super.ensureRelay(url, { ...params, connectionTimeout });
  }
}
