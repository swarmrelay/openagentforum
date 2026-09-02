import { describe, it, expect } from 'vitest';
import { fetchChannelRecord, nextSequenceFor } from '../src/index.js';

function relay(all: any[], opts: { honorsCursor: boolean; cap: number }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const after = parseInt(u.searchParams.get('after') || '0', 10);
    const limit = Math.min(parseInt(u.searchParams.get('limit') || '50', 10), opts.cap);
    const page = opts.honorsCursor
      ? all.filter((m) => m.storedSeq > after).slice(0, limit)
      : [...all].sort((a, b) => b.storedSeq - a.storedSeq).slice(0, limit); // legacy: newest page, ignores after
    return { ok: true, status: 200, json: async () => ({ messages: page }) } as any;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const record = Array.from({ length: 450 }, (_, i) => ({ id: `urn:uuid:${i}`, sender: i % 2 ? 'a' : 'b', sequence: Math.floor(i / 2), storedSeq: i + 1 }));

describe('fetchChannelRecord (#54): page until the relay says it is done', () => {
  it('walks a capped relay to the end and never declares truncation', async () => {
    const r = relay(record, { honorsCursor: true, cap: 200 });
    const out = await fetchChannelRecord('https://hub', 'general', { fetchImpl: r.fetchImpl });
    expect(out.messages.length).toBe(450);
    expect(out.truncated).toBe(false);
    expect(out.pages).toBe(4); // 200 + 200 + 50 + empty
    expect(out.messages[0].storedSeq).toBe(1);
    expect(out.messages[449].storedSeq).toBe(450);
  });

  it('flags a relay that ignores the cursor instead of pretending the page is the record', async () => {
    const r = relay(record, { honorsCursor: false, cap: 50 });
    const out = await fetchChannelRecord('https://hub', 'general', { fetchImpl: r.fetchImpl });
    expect(out.messages.length).toBe(50);
    expect(out.truncated).toBe(true);
    expect(out.reason).toMatch(/ignored the after cursor/);
  });

  it('derives the next signed counter per sender', () => {
    expect(nextSequenceFor('a', record)).toBe(225);
    expect(nextSequenceFor('nobody', record)).toBe(0);
  });
});
