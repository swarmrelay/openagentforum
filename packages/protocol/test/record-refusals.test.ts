/**
 * Branch coverage for fetchChannelRecord's refusal paths (#54).
 *
 * record.test.ts pins the two happy paths (a capped relay walked to the end,
 * and a relay that ignores `after`). The three ways the walk can also give up
 * are not covered there, and they are the ones an auditor actually hits in
 * production:
 *
 *   - the relay answers with envelopes that carry no `storedSeq`, so there is
 *     no cursor to advance and the walk must not claim completeness;
 *   - the relay keeps paging forever and `maxPages` is the only thing that
 *     stops it;
 *   - a page comes back with a non-2xx status.
 *
 * Plus the de-duplication guarantee the byId map exists for: a relay that
 * repeats an envelope across pages must not inflate the record.
 *
 * Every case asserts `truncated` and `reason` explicitly, because "the record
 * looks complete" is exactly the failure this helper exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { fetchChannelRecord } from '../src/index.js';

type Msg = { id: string; sender: string; sequence: number; storedSeq?: number };

/** A relay whose page content is chosen by the test, and which records calls. */
function scriptedRelay(pages: any[][], opts: { status?: number } = {}) {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const page = pages[Math.min(index, pages.length - 1)] ?? [];
    index++;
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ messages: page }),
    } as any;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('fetchChannelRecord (#54): the ways a walk refuses to claim completeness', () => {
  it('stops and flags truncation when envelopes carry no storedSeq', async () => {
    // No cursor to advance on: continuing would re-fetch the same page forever.
    const unsequenced: Msg[] = [
      { id: 'urn:uuid:a', sender: 'a', sequence: 0 },
      { id: 'urn:uuid:b', sender: 'b', sequence: 0 },
    ];
    const r = scriptedRelay([unsequenced]);
    const out = await fetchChannelRecord('https://hub', 'general', { fetchImpl: r.fetchImpl });

    expect(out.truncated).toBe(true);
    expect(out.reason).toMatch(/without storedSeq/);
    // The envelopes that did arrive are still returned, and are not lost.
    expect(out.messages.map((m) => m.id)).toEqual(['urn:uuid:a', 'urn:uuid:b']);
    // Exactly one request: it must not loop on a page it cannot advance past.
    expect(r.calls().length).toBe(1);
  });

  it('stops at maxPages and says so, rather than paging forever', async () => {
    // Every page advances the cursor, so only maxPages can end the walk.
    let seq = 0;
    const makePage = () =>
      Array.from({ length: 2 }, () => {
        seq++;
        return { id: `urn:uuid:${seq}`, sender: 'a', sequence: seq, storedSeq: seq } as Msg;
      });
    const endless = Array.from({ length: 50 }, () => makePage());
    const r = scriptedRelay(endless);
    const out = await fetchChannelRecord('https://hub', 'general', {
      fetchImpl: r.fetchImpl,
      pageSize: 2,
      maxPages: 3,
    });

    expect(out.pages).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.reason).toMatch(/stopped after 3 pages/);
    expect(r.calls().length).toBe(3);
  });

  it('de-duplicates an envelope repeated across pages instead of inflating the record', async () => {
    // A relay that re-sends the boundary envelope is not a reason to count it twice.
    const first: Msg[] = [
      { id: 'urn:uuid:1', sender: 'a', sequence: 0, storedSeq: 1 },
      { id: 'urn:uuid:2', sender: 'b', sequence: 0, storedSeq: 2 },
    ];
    const second: Msg[] = [
      { id: 'urn:uuid:2', sender: 'b', sequence: 0, storedSeq: 2 },
      { id: 'urn:uuid:3', sender: 'a', sequence: 1, storedSeq: 3 },
    ];
    const r = scriptedRelay([first, second, []]);
    const out = await fetchChannelRecord('https://hub', 'general', { fetchImpl: r.fetchImpl });

    expect(out.messages.map((m) => m.id)).toEqual(['urn:uuid:1', 'urn:uuid:2', 'urn:uuid:3']);
    expect(out.messages.length).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it('throws with the status rather than returning a silently short record', async () => {
    const r = scriptedRelay([[]], { status: 503 });
    await expect(
      fetchChannelRecord('https://hub', 'general', { fetchImpl: r.fetchImpl })
    ).rejects.toThrow(/returned 503/);
  });

  it('treats a non-array messages field as an empty page and finishes cleanly', async () => {
    // A malformed body must not be read as "there is more": the walk ends, and
    // an empty record is reported as empty rather than as truncated.
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ messages: null }) } as any;
    }) as unknown as typeof fetch;
    const out = await fetchChannelRecord('https://hub', 'general', { fetchImpl });

    expect(out.messages).toEqual([]);
    expect(out.pages).toBe(1);
    expect(out.truncated).toBe(false);
    expect(calls.length).toBe(1);
  });

  it('strips one trailing slash from the hub so the path is not doubled', async () => {
    const r = scriptedRelay([[]]);
    await fetchChannelRecord('https://hub/', 'general', { fetchImpl: r.fetchImpl });
    expect(r.calls()[0]).toMatch(/^https:\/\/hub\/v1\/channels\/general\/messages\?/);
    expect(r.calls()[0]).not.toMatch(/hub\/\/v1/);
  });

  it('encodes a channel name with characters that would otherwise break the URL', async () => {
    const r = scriptedRelay([[]]);
    await fetchChannelRecord('https://hub', 'intel exchange/x', { fetchImpl: r.fetchImpl });
    expect(r.calls()[0]).toContain('/channels/intel%20exchange%2Fx/messages');
  });
});
