/** Bounded local OAF HTTP adapter. No background polling, registration or posting on import. */
import { deriveAgentId, verifyEnvelope } from '@openagentforum/protocol';
import { StreamFailure, withDeadline } from './framing.js';
import { peerIdFor, readRendezvous, rendezvousScope, type RendezvousScope } from './rendezvous.js';

const responseBytes = 262_144, maxMessages = 100;
export class ForumMailbox {
  readonly scope: RendezvousScope;
  readonly #fetch: typeof fetch;
  #busy = false;
  constructor(hub: string, channel: string, fetchImpl: typeof fetch = fetch) {
    this.scope = rendezvousScope(hub, channel); this.#fetch = fetchImpl;
  }
  async #request(path: string, body?: string): Promise<any> {
    if (this.#busy) throw new StreamFailure('busy');
    this.#busy = true;
    try {
      return await withDeadline(async signal => {
        const response = await this.#fetch(this.scope.hub + path, { method: body === undefined ? 'GET' : 'POST', body,
          signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' } });
        if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
          void response.body?.cancel().catch(() => {}); throw new StreamFailure('io');
        }
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let total = 0, ended = false;
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          for (let reads = 0; reads < 4096; reads++) {
            if (signal.aborted) throw new StreamFailure('timeout');
            const next = await reader.read();
            if (signal.aborted) throw new StreamFailure('timeout');
            if (next.done) { ended = true; break; }
            total += next.value.byteLength;
            if (total > responseBytes) throw new StreamFailure('limit');
            chunks.push(next.value);
          }
          if (!ended) throw new StreamFailure('limit');
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
        } finally {
          signal.removeEventListener('abort', cancel);
          if (!ended) cancel(); reader.releaseLock();
        }
      }, 5000);
    } catch (error) { throw error instanceof StreamFailure ? error : new StreamFailure('io'); }
    finally { this.#busy = false; }
  }
  /** Key-only announcement, not a signed profile, vetting or permission grant. Explicit write. */
  async announce(publicKey: string): Promise<void> {
    peerIdFor(publicKey);
    await this.#request('/v1/agents/register', JSON.stringify({ publicKey }));
  }
  /** Discovery candidate only. The caller must explicitly choose/pin this full key. */
  async discover(agentId: string): Promise<string> {
    if (!/^agent_[0-9a-f]{16}$/.test(agentId)) throw new StreamFailure('invalid_input');
    const data = await this.#request(`/v1/agents/${agentId}`), key = data?.agent?.publicKey;
    peerIdFor(key);
    if (await deriveAgentId(key) !== agentId) throw new StreamFailure('peer');
    return key;
  }
  async #records(): Promise<unknown[]> {
    // A short-lived dedicated rendezvous channel only; never claim full history or
    // persist/ack an unsigned cursor. At the cap, fail rather than silently omit.
    const data = await this.#request(`/v1/channels/${this.scope.channel}/messages?after=0&limit=${maxMessages}`);
    if (!Array.isArray(data?.messages) || data.messages.length >= maxMessages) throw new StreamFailure('limit');
    return data.messages;
  }
  async nextSequence(publicKey: string): Promise<number> {
    peerIdFor(publicKey); const agentId = await deriveAgentId(publicKey);
    let next = 0;
    for (const record of await this.#records()) {
      const value = record as any;
      if (value?.sender !== agentId) continue;
      if (value.channel !== this.scope.channel || !Number.isSafeInteger(value.sequence) || value.sequence < 0
          || !(await verifyEnvelope(value, publicKey)).valid || !Number.isSafeInteger(value.sequence + 1)) throw new StreamFailure('protocol');
      next = Math.max(next, value.sequence + 1);
    }
    return next;
  }
  /** Validate an expected peer's signed record, not arbitrary posts or unsigned replies. */
  async find(kind: 'offer' | 'accept', from: string, to: string): Promise<string | null> {
    peerIdFor(from); peerIdFor(to);
    for (const value of await this.#records()) {
      try { const raw = JSON.stringify(value); await readRendezvous(raw, this.scope, from, to, kind); return raw; }
      catch { /* Untrusted/expired/unrelated records never trigger a connection. */ }
    }
    return null;
  }
  /** One POST, no retry/rebase. A lost response is uncertain and may have committed. */
  async post(raw: string, from: string, to: string, kind: 'offer' | 'accept'): Promise<void> {
    const submitted = await readRendezvous(raw, this.scope, from, to, kind);
    const data = await this.#request(`/v1/channels/${this.scope.channel}/messages`, JSON.stringify(submitted));
    if (data?.success !== true) throw new StreamFailure('protocol');
    const stored = await readRendezvous(JSON.stringify(data?.envelope), this.scope, from, to, kind);
    if (stored.id !== submitted.id || stored.signature !== submitted.signature || stored.checksum !== submitted.checksum) throw new StreamFailure('protocol');
  }
}
