/**
 * Fetch a channel's full stored record by paging on the relay's unsigned
 * storedSeq cursor (#54). A single GET against a capped relay returns only
 * the newest page; an auditor that declares completeness over that page is
 * lying by omission. This helper walks `?after=<storedSeq>&limit=N` until
 * the relay returns an empty page, and reports honestly when it could not.
 */
import type { MessageEnvelope } from './types.js';

export type StoredEnvelope = MessageEnvelope<any> & { storedSeq?: number };

export interface FetchRecordOptions {
  headers?: Record<string, string>;
  /** page size requested from the relay (relays may cap it lower) */
  pageSize?: number;
  /** safety valve against a relay that never returns an empty page */
  maxPages?: number;
  fetchImpl?: typeof fetch;
}

export interface ChannelRecord {
  messages: StoredEnvelope[];
  pages: number;
  /**
   * true when the walk could not prove it reached the end: the relay ignored
   * the cursor (kept returning the same page), returned envelopes without a
   * storedSeq, or maxPages was hit. Never treat a truncated record as complete.
   */
  truncated: boolean;
  reason?: string;
}

export async function fetchChannelRecord(hub: string, channel: string, opts: FetchRecordOptions = {}): Promise<ChannelRecord> {
  const f = opts.fetchImpl ?? fetch;
  const pageSize = opts.pageSize ?? 200;
  const maxPages = opts.maxPages ?? 10_000;
  const base = hub.replace(/\/$/, '');
  const byId = new Map<string, StoredEnvelope>();
  let cursor = 0;
  let pages = 0;
  let truncated = false;
  let reason: string | undefined;

  for (;;) {
    const res = await f(`${base}/v1/channels/${encodeURIComponent(channel)}/messages?after=${cursor}&limit=${pageSize}`, { headers: opts.headers });
    if (!res.ok) throw new Error(`GET ${channel}/messages returned ${res.status}`);
    const body: any = await res.json();
    const page: StoredEnvelope[] = Array.isArray(body?.messages) ? body.messages : [];
    pages++;
    if (page.length === 0) break;

    let advanced = false;
    let unsequenced = false;
    for (const m of page) {
      if (m && typeof m.id === 'string' && !byId.has(m.id)) byId.set(m.id, m);
      const s = (m as any)?.storedSeq;
      if (typeof s === 'number' && Number.isFinite(s)) {
        if (s > cursor) { cursor = s; advanced = true; }
      } else {
        unsequenced = true;
      }
    }
    if (unsequenced) { truncated = true; reason = 'relay returned envelopes without storedSeq; cannot page reliably'; break; }
    if (!advanced) { truncated = true; reason = 'relay ignored the after cursor (same page returned twice); record may be capped'; break; }
    if (pages >= maxPages) { truncated = true; reason = `stopped after ${maxPages} pages`; break; }
  }

  const messages = [...byId.values()].sort((a, b) => (a.storedSeq ?? 0) - (b.storedSeq ?? 0));
  return { messages, pages, truncated, ...(reason ? { reason } : {}) };
}

/** Next signed per-channel sequence for a sender, derived from the full record (#53). */
export function nextSequenceFor(sender: string, messages: StoredEnvelope[]): number {
  let max = -1;
  for (const m of messages) if (m.sender === sender && Number.isFinite(m.sequence) && m.sequence > max) max = m.sequence;
  return max + 1;
}
