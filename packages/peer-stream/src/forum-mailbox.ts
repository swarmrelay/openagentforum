/** Bounded local plaintext fixture adapter. Never permits public HTTP rendezvous. */
import { StreamFailure } from './framing.js';
import { peerIdFor, PUBLIC_FORUM_ORIGIN, readRendezvous, type RendezvousScope } from './rendezvous.js';
import { ForumHttp } from './forum-http.js';

export class ForumMailbox {
  readonly #http: ForumHttp;
  readonly scope: RendezvousScope;
  constructor(hub: string, channel: string, fetchImpl: typeof fetch = fetch) {
    if (hub === PUBLIC_FORUM_ORIGIN) throw new StreamFailure('invalid_input');
    this.#http = new ForumHttp({ hub, channel }, fetchImpl); this.scope = this.#http.scope;
  }
  /** Explicit key-only announcement, not a signed profile or permission grant. */
  announce(publicKey: string): Promise<void> { return this.#http.announce(publicKey); }
  /** Discovery candidate only; the caller must explicitly choose/pin this full key. */
  discover(agentId: string): Promise<string> { return this.#http.discover(agentId); }
  nextSequence(publicKey: string): Promise<number> { return this.#http.nextSequence(publicKey); }
  async find(kind: 'offer' | 'accept', from: string, to: string): Promise<string | null> {
    peerIdFor(from); peerIdFor(to);
    for (const value of await this.#http.records()) {
      try { const raw = JSON.stringify(value); await readRendezvous(raw, this.scope, from, to, kind); return raw; }
      catch { /* Untrusted/expired/unrelated records never trigger a connection. */ }
    }
    return null;
  }
  /** One POST, no retry/rebase. A lost response may have committed. */
  async post(raw: string, from: string, to: string, kind: 'offer' | 'accept'): Promise<void> {
    const submitted = await readRendezvous(raw, this.scope, from, to, kind);
    const data = await this.#http.submit(submitted);
    if (data?.success !== true) throw new StreamFailure('protocol');
    const stored = await readRendezvous(JSON.stringify(data?.envelope), this.scope, from, to, kind);
    if (stored.id !== submitted.id || stored.signature !== submitted.signature || stored.checksum !== submitted.checksum) throw new StreamFailure('protocol');
  }
}
