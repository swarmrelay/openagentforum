import { describe, expect, it, vi } from 'vitest';
import { generateAgentKeyPair, signEnvelope, tallyPoll, verifyPollProof, type StoredEnvelope } from '@openagentforum/protocol';
import { createSqlPollStore, createD1PollStore, createMemoryPollStore, computeTally, handlePollRead, POLL_WORK_LIMITS as limits } from '../src/polls-routes.js';
import { adapterFixture } from './adapter-fixture.js';
import { onRequest } from '../../../apps/web/functions/v1/[[route]].js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

const origin = 'https://relay.test';
async function signedHistory(channel = 'bounded-polls') {
  const creator = await generateAgentKeyPair(), voter = await generateAgentKeyPair();
  const sign = (key: typeof creator, type: 'poll' | 'vote', payload: unknown, sequence: number, storedSeq: number) =>
    signEnvelope({ channel, sender: key.agentId, type, payload, sequence }, key.signingPrivateKey).then(e => ({ ...e, storedSeq }));
  const poll = await sign(creator, 'poll', { kind: 'open', title: 'Bounded tally', options: ['yes', 'no'],
    ledger: { hub: origin }, electorate: { type: 'list', agentIds: [voter.agentId, creator.agentId] }, quorum: { minVoters: 1 },
    closes: { allVoted: true }, closePolicy: { creator: true }, rule: { method: 'absolute_majority' }, revote: 'latest' }, 701, 1);
  const ballot = (choice: number) => ({ pollId: poll.id, pollHash: poll.checksum, choice });
  const first = await sign(voter, 'vote', ballot(0), 31, 2);
  const latest = await sign(voter, 'vote', ballot(1), 32, 3);
  const close = await sign(creator, 'poll', { kind: 'close', pollId: poll.id, pollHash: poll.checksum }, 702, 4);
  const after = await sign(voter, 'vote', ballot(0), 33, 5);
  const keys = new Map([[creator.agentId, creator.signingPublicKey], [voter.agentId, voter.signingPublicKey]]);
  return { poll, votes: [first, latest, close, after], creator, voter, keys };
}
function seed(db: DatabaseSync, rows: StoredEnvelope[], keys = new Map<string, string>()) {
  for (const [id, key] of keys) db.prepare('INSERT OR IGNORE INTO agents (agent_id,name,public_key,registered_at,last_seen_at) VALUES (?,?,?,?,?)').run(id, id, key, 1, 1);
  for (const row of rows) {
    db.prepare("INSERT OR IGNORE INTO channels (name,title,topic,creator_id,created_at) VALUES (?,?,'','fixture',1)").run(row.channel, row.channel);
    db.prepare(`INSERT INTO messages (id,channel,sender,type,sequence,stored_seq,timestamp,payload_json,signature,checksum,encrypted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.channel, row.sender, row.type, row.sequence, row.storedSeq ?? row.sequence,
        row.timestamp, JSON.stringify(row.payload), row.signature, row.checksum, row.encrypted ? 1 : 0);
  }
}
const filler = (poll: StoredEnvelope, n: number, payload = {}) => ({ ...poll, id: `${poll.id}-ballot-${n}`, sender: 'unknown',
  type: 'vote' as const, storedSeq: n + 2, payload: { pollId: poll.id, pollHash: poll.checksum, choice: 0, ...payload } });

describe('bounded poll SQL and verification work', () => {
  it('matches the pure tally, signatures, revotes, closes, cutoffs and Merkle proofs', async () => {
    const f = adapterFixture('standalone');
    try {
      const h = await signedHistory(); seed(f.db, [h.poll, ...h.votes], h.keys);
      for (const atSeq of [undefined, 0, 2, 3, 4]) {
        let queries = 0;
        const store = createSqlPollStore(async (sql, args) => { queries++; return f.db.prepare(sql).all(...args); });
        const root = (await store.getPoll(undefined, h.poll.id))!;
        const actual = (await computeTally(store, root, { atSeq, now: 1 })).tally;
        const expected = await tallyPoll(h.poll, h.votes, async id => h.keys.get(id) ?? null, { atSeq, now: 1 });
        expect(actual).toEqual(expected); expect(queries).toBe(2);
        expect(root.sequence).toBe(701); expect(root.signature).toBe(h.poll.signature);
      }
      const proof = await (await f.request(`/v1/polls/${h.poll.id}/proof/${h.votes[1].id}`)).json() as any;
      expect(await verifyPollProof(proof.leafBytes, proof.proof, proof.root)).toBe(true);
    } finally { f.close(); }
  });

  it('accepts the complete record boundary and refuses one extra before returning payloads', async () => {
    const f = adapterFixture('standalone');
    let verification: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const h = await signedHistory();
      // Valid payload checksums and known keys force actual Ed25519 work;
      // changed IDs then fail signatures without being silently omitted.
      seed(f.db, [h.poll, ...Array.from({ length: limits.records - 1 }, (_, n) => ({ ...h.votes[0], id: `${h.poll.id}-ballot-${n}`, storedSeq: n + 2 }))], h.keys);
      verification = vi.spyOn(crypto.subtle, 'verify');
      const make = (seen: Record<string, unknown>[][] = []) => createSqlPollStore(async (sql, args) => {
        const rows = f.db.prepare(sql).all(...args); seen.push(rows); return rows;
      });
      const store = make(), root = (await store.getPoll(undefined, h.poll.id))!;
      expect((await computeTally(store, root)).tally.ballots).toHaveLength(limits.records - 1);
      expect(verification).toHaveBeenCalledTimes(limits.records);
      verification.mockClear();
      seed(f.db, [filler(h.poll, limits.records)]);
      const seen: Record<string, unknown>[][] = [], over = make(seen);
      const response = await handlePollRead(new Request(`${origin}/v1/polls/${h.poll.id}`), over);
      expect(response?.status).toBe(503); expect(await response?.json()).toMatchObject({ code: 'poll_work_limit' });
      expect(seen.at(-1)).toHaveLength(1); expect(seen.at(-1)?.[0].payload_json).toBeNull();
      expect(verification).not.toHaveBeenCalled();
      expect((await f.request(`/v1/polls/${h.poll.id}?atSeq=2`)).status).toBe(200);
    } finally { verification?.mockRestore(); f.close(); }
  });

  it.each(['single bytes', 'aggregate bytes', 'depth', 'nodes', 'width'] as const)('refuses %s before any verification resolver is called', async kind => {
    const f = adapterFixture('standalone');
    try {
      const h = await signedHistory(); seed(f.db, [h.poll], h.keys);
      const padding = kind === 'single bytes' ? 'x'.repeat(limits.recordBytes) : 'x'.repeat(240000);
      let rows = [filler(h.poll, 0, { padding })];
      if (kind === 'aggregate bytes') rows = Array.from({ length: 18 }, (_, n) => filler(h.poll, n, { padding }));
      if (kind === 'width') rows = [filler(h.poll, 0, { padding: Array(1025).fill(0) })];
      if (kind === 'nodes') rows = Array.from({ length: 9 }, (_, n) => filler(h.poll, n, { padding: Array.from({ length: 8 }, () => Array(1000).fill(0)) }));
      if (kind === 'depth') { let nested: any = 0; for (let i = 0; i < 18; i++) nested = [nested]; rows = [filler(h.poll, 0, { padding: nested })]; }
      seed(f.db, rows);
      const seen: Record<string, unknown>[][] = [];
      const store = createSqlPollStore(async (sql, args) => { const rows = f.db.prepare(sql).all(...args); seen.push(rows); return rows; });
      const root = (await store.getPoll(undefined, h.poll.id))!;
      let resolutions = 0; store.publicKey = async () => { resolutions++; return h.creator.signingPublicKey; };
      await expect(computeTally(store, root)).rejects.toMatchObject({ code: 'poll_work_limit' });
      expect(resolutions).toBe(0);
      if (kind.endsWith('bytes')) { expect(seen.at(-1)).toHaveLength(1); expect(seen.at(-1)?.[0].payload_json).toBeNull(); }
      expect((await f.request(`/v1/polls/${h.poll.id}?atSeq=1`)).status).toBe(200);
    } finally { f.close(); }
  });

  it('seeks indexes through unrelated history, whitespace/escaped references and global timestamp ties', async () => {
    const f = adapterFixture('standalone');
    try {
      const h = await signedHistory(); seed(f.db, [h.poll, h.votes[0]], h.keys);
      f.db.prepare('UPDATE messages SET payload_json = ? WHERE id = ?').run(JSON.stringify(h.votes[0].payload, null, 2).replace('msg_', '\\u006dsg_'), h.votes[0].id);
      seed(f.db, Array.from({ length: 600 }, (_, n) => ({ ...h.poll, channel: `other-${n}`, id: `other-poll-${n}`, storedSeq: 1 })));
      const plans: string[][] = [];
      const store = createSqlPollStore(async (sql, args) => {
        // Inspect just the unbounded-source selection. The outer sort is over
        // the already bounded materialized result and is intentionally allowed.
        const picked = sql.includes('SELECT rowid') ? sql.slice(sql.indexOf('SELECT rowid'), sql.indexOf('), bounds')) : sql;
        const count = (picked.match(/\?/g) ?? []).length;
        plans.push(f.db.prepare('EXPLAIN QUERY PLAN ' + picked).all(...args.slice(0, count)).map(r => String(r.detail)));
        return f.db.prepare(sql).all(...args);
      });
      const root = (await store.getPoll(undefined, h.poll.id))!;
      expect((await computeTally(store, root)).tally.counts).toEqual([1, 0]);
      await store.listPolls(); await store.listPolls(h.poll.channel);
      expect(plans.flat().join('\n')).not.toMatch(/SCAN messages\b(?! USING INDEX)|TEMP B-TREE/);
      for (const name of ['idx_messages_poll_reference', 'idx_messages_poll_open', 'idx_messages_poll_open_channel']) expect(plans.flat().join('\n')).toContain(name);
      // The old latest-500 global scan could not locate this poll.
      expect((await f.request(`/v1/polls/${h.poll.id}`)).status).toBe(200);
    } finally { f.close(); }
  });

  it('shares one allowance across list tallies and does not hide an oversized poll', async () => {
    const f = adapterFixture('standalone');
    try {
      for (const channel of ['list-a', 'list-b']) {
        const h = await signedHistory(channel); seed(f.db, [h.poll, ...Array.from({ length: 600 }, (_, n) => filler(h.poll, n))], h.keys);
        expect((await f.request(`/v1/polls/${h.poll.id}`)).status).toBe(200);
      }
      const response = await f.request('/v1/polls'); expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.polls).toEqual([]); expect(body.unavailable).toHaveLength(2);
      expect(body.unavailable.every((p: any) => p.code === 'poll_work_limit' && p.status === 'unavailable')).toBe(true);
    } finally { f.close(); }
  });

  it('keeps 49 ordinary catalog tallies available beside one over-limit history within the aggregate allowance', async () => {
    const f = adapterFixture('standalone');
    let verification: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const bad = await signedHistory('catalog-bad'); bad.poll.storedSeq = 1000000;
      seed(f.db, [bad.poll, ...Array.from({ length: limits.records }, (_, n) => filler(bad.poll, n))], bad.keys);
      for (let i = 0; i < 49; i++) {
        const h = await signedHistory(`catalog-${i}`);
        seed(f.db, [h.poll, ...Array.from({ length: 19 }, (_, n) => ({ ...h.votes[0], id: `${h.poll.id}-ballot-${n}`, storedSeq: n + 2 }))], h.keys);
      }
      let returnedBytes = 0, queries = 0;
      const store = createSqlPollStore(async (sql, args) => {
        queries++;
        const rows = f.db.prepare(sql).all(...args);
        if (rows[0]?.payload_json != null) returnedBytes += Number(rows[0].total_bytes);
        return rows;
      });
      verification = vi.spyOn(crypto.subtle, 'verify');
      const response = await handlePollRead(new Request(`${origin}/v1/polls?status=open`), store);
      expect(response?.status).toBe(200);
      const body = await response!.json() as any;
      expect(body.polls).toHaveLength(49); expect(body.count).toBe(49);
      expect(body.unavailable).toEqual([{ pollId: bad.poll.id, channel: bad.poll.channel, status: 'unavailable', code: 'poll_work_limit' }]);
      expect(verification).toHaveBeenCalledTimes(49 * 20);
      expect(returnedBytes).toBeLessThanOrEqual(limits.bytes); expect(queries).toBe(101);
      const closed = await (await f.request('/v1/polls?status=closed')).json() as any;
      expect(closed.polls).toEqual([]); expect(closed.unavailable).toEqual(body.unavailable);
    } finally { verification?.mockRestore(); f.close(); }
  });

  it.each(['SQL', 'memory'] as const)('%s catalog isolates oversized roots and bounds unavailable identifiers', async adapter => {
    const f = adapterFixture('standalone');
    try {
      const h = await signedHistory(), bad = await signedHistory('bad-root');
      const rows = [h.poll, ...h.votes, { ...bad.poll, storedSeq: 10, payload: { ...bad.poll.payload, padding: 'x'.repeat(limits.recordBytes) } },
        { ...bad.poll, id: 'x'.repeat(2000), channel: 'y'.repeat(2000), storedSeq: 11 }];
      const keys = new Map([...h.keys, ...bad.keys]); seed(f.db, rows, keys);
      let discovery: Record<string, unknown>[] = [];
      const store = adapter === 'memory' ? createMemoryPollStore(() => rows, id => ({ publicKey: keys.get(id) ?? null, registeredAt: 1 })) :
        createSqlPollStore(async (sql, args) => { const result = f.db.prepare(sql).all(...args); if (!discovery.length) discovery = result; return result; });
      const response = await handlePollRead(new Request(`${origin}/v1/polls`), store);
      expect(response?.status).toBe(200);
      const body = await response!.json() as any;
      expect(body.polls).toHaveLength(1); expect(body.polls[0].counts).toEqual([0, 1]);
      expect(body.unavailable).toEqual([
        { pollId: null, channel: null, status: 'unavailable', code: 'poll_work_limit' },
        { pollId: bad.poll.id, channel: bad.poll.channel, status: 'unavailable', code: 'poll_work_limit' },
      ]);
      if (adapter === 'SQL') expect(discovery.every(row => Object.keys(row).sort().join(',') === 'channel,pollId')).toBe(true);
    } finally { f.close(); }
  });

  it('does not reuse failed shares or let a completed child access storage', async () => {
    const f = adapterFixture('standalone');
    try {
      const h = await signedHistory(); seed(f.db, [h.poll], h.keys);
      let child: ReturnType<typeof createSqlPollStore> | undefined, reads = 0;
      const store = createSqlPollStore(async (sql, args) => { reads++; return f.db.prepare(sql).all(...args); });
      await store.withShare(1, async selected => { child = selected; await selected.getPoll(undefined, h.poll.id); });
      await expect(child!.getPoll(undefined, h.poll.id)).rejects.toMatchObject({ code: 'poll_work_unavailable' });
      expect(reads).toBe(1);
      await expect(store.withShare(1, async () => { throw new Error('failed tally'); })).rejects.toThrow('failed tally');
      await expect(store.getPoll(undefined, h.poll.id)).rejects.toMatchObject({ code: 'poll_work_limit' });
    } finally { f.close(); }
  });

  it.each(['bytes', 'nodes'] as const)('keeps failed catalog %s reservations inside the aggregate budget', async kind => {
    const f = adapterFixture('standalone');
    let verification: ReturnType<typeof vi.spyOn> | undefined;
    try {
      for (let i = 0; i < 3; i++) {
        const h = await signedHistory(`share-${kind}-${i}`);
        const padding = kind === 'bytes' ? 'x'.repeat(160000) : Array.from({ length: 8 }, () => Array(1000).fill(0));
        seed(f.db, [h.poll, ...Array.from({ length: kind === 'bytes' ? 9 : 3 }, (_, n) => filler(h.poll, n, { padding }))], h.keys);
        expect((await f.request(`/v1/polls/${h.poll.id}`)).status).toBe(200);
      }
      verification = vi.spyOn(crypto.subtle, 'verify');
      let returnedBytes = 0;
      const store = createSqlPollStore(async (sql, args) => {
        const rows = f.db.prepare(sql).all(...args);
        if (rows[0]?.payload_json != null) returnedBytes += Number(rows[0].total_bytes);
        return rows;
      });
      const response = await handlePollRead(new Request(`${origin}/v1/polls`), store);
      const body = await response!.json() as any;
      expect(response?.status).toBe(200); expect(body.polls).toEqual([]); expect(body.unavailable).toHaveLength(3);
      expect(returnedBytes).toBeLessThanOrEqual(limits.bytes); expect(verification).not.toHaveBeenCalled();
    } finally { verification?.mockRestore(); f.close(); }
  });

  it('uses fresh primary sessions, fails closed on missing indexes/storage errors, and contains cancellation', async () => {
    const f = adapterFixture('standalone');
    try {
      const h = await signedHistory(); seed(f.db, [h.poll, h.votes[0]], h.keys);
      let sessions = 0;
      const db = { withSession(mode: string) { expect(mode).toBe('first-primary'); sessions++;
        return { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ all: async <T>() => ({ success: true, results: f.db.prepare(sql).all(...args as SQLInputValue[]) as T[] }) }) }) };
      } };
      const store = createD1PollStore(db), root = (await store.getPoll(undefined, h.poll.id))!;
      await computeTally(store, root); expect(sessions).toBe(2);
      const controller = new AbortController(); controller.abort();
      await expect(createD1PollStore(db, controller.signal).getPoll(undefined, h.poll.id)).rejects.toMatchObject({ code: 'poll_work_unavailable' });
      expect(sessions).toBe(2);
      const interrupted = new AbortController();
      const late = createSqlPollStore(async (sql, args) => { const rows = f.db.prepare(sql).all(...args); interrupted.abort(); return rows; }, interrupted.signal);
      await expect(late.getPoll(undefined, h.poll.id)).rejects.toMatchObject({ code: 'poll_work_unavailable' });
      expect((await f.request(`/v1/polls/${h.poll.id}`)).status).toBe(200);
      f.db.exec('DROP INDEX idx_messages_poll_reference');
      const response = await f.request(`/v1/polls/${h.poll.id}`);
      expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'poll_work_unavailable' });
      const broken = createSqlPollStore(async () => { throw new Error('private storage detail'); });
      expect(await (await handlePollRead(new Request(`${origin}/v1/polls`), broken))?.text()).not.toContain('private');
    } finally { f.close(); }
  });

  it('accounts legacy text in numeric-affinity columns before it leaves SQL', async () => {
    const f = adapterFixture('standalone');
    try {
      const h = await signedHistory(); seed(f.db, [h.poll], h.keys);
      f.db.prepare('UPDATE messages SET sequence = ? WHERE id = ?').run('x'.repeat(limits.recordBytes), h.poll.id);
      const seen: Record<string, unknown>[][] = [];
      const store = createSqlPollStore(async (sql, args) => { const rows = f.db.prepare(sql).all(...args); seen.push(rows); return rows; });
      await expect(store.getPoll(undefined, h.poll.id)).rejects.toMatchObject({ code: 'poll_work_limit' });
      expect(seen[0]).toHaveLength(1); expect(seen[0][0].sequence).toBeNull();
    } finally { f.close(); }
  });

  it('uses joined registry times for open electorates without per-ballot queries', async () => {
    const f = adapterFixture('standalone');
    try {
      const h = await signedHistory();
      const poll = { ...await signEnvelope({ channel: h.poll.channel, sender: h.creator.agentId, type: 'poll', sequence: 1,
        payload: { ...h.poll.payload, electorate: { type: 'open' }, closes: { at: Date.now() + 60000 } } }, h.creator.signingPrivateKey), storedSeq: 1 };
      const vote = { ...await signEnvelope({ channel: poll.channel, sender: h.voter.agentId, type: 'vote', sequence: 1,
        payload: { pollId: poll.id, pollHash: poll.checksum, choice: 1 } }, h.voter.signingPrivateKey), storedSeq: 2 };
      seed(f.db, [poll, vote], h.keys);
      for (const registeredAt of [1, poll.timestamp + 1]) {
        f.db.prepare('UPDATE agents SET registered_at = ? WHERE agent_id = ?').run(registeredAt, h.voter.agentId);
        let queries = 0;
        const store = createSqlPollStore(async (sql, args) => { queries++; return f.db.prepare(sql).all(...args); });
        const root = (await store.getPoll(undefined, poll.id))!;
        const tally = (await computeTally(store, root)).tally;
        expect(tally.counts).toEqual([0, registeredAt === 1 ? 1 : 0]); expect(queries).toBe(2);
      }
    } finally { f.close(); }
  });
});

describe.each(['Worker', 'standalone', 'Pages D1', 'Pages memory'] as const)('%s poll HTTP contract', adapter => {
  it('preserves ordinary signed participation and rejects invalid queries before history reads', async () => {
    const f = adapterFixture(adapter === 'Worker' ? 'Worker' : 'standalone');
    const stmt = (sql: string, args: SQLInputValue[] = []): any => ({ bind: (...args: SQLInputValue[]) => stmt(sql, args),
      first: async () => f.db.prepare(sql).get(...args) ?? null,
      all: async () => ({ success: true, results: f.db.prepare(sql).all(...args) }), run: async () => f.db.prepare(sql).run(...args) });
    const DB = { prepare: (sql: string) => stmt(sql), withSession: (mode: string) => { expect(mode).toBe('first-primary'); return { prepare: (sql: string) => stmt(sql) }; } };
    const request = adapter.startsWith('Pages') ? async (path: string, body?: unknown) => onRequest({
      request: new Request(origin + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      env: { PUBLIC_ORIGIN: origin, ...(adapter === 'Pages D1' ? { DB } : {}) }, waitUntil() {},
    } as any) as Promise<Response> : f.request;
    try {
      const h = await signedHistory(`poll-${crypto.randomUUID()}`);
      for (const key of [h.creator, h.voter]) expect((await request('/v1/agents/register', { publicKey: key.signingPublicKey })).status).toBe(200);
      for (const envelope of [h.poll, ...h.votes.slice(0, 3)]) {
        const r = await request(`/v1/channels/${h.poll.channel}/messages`, envelope);
        expect(r.status, await r.clone().text()).toBe(200);
      }
      const route = `/v1/polls/${h.poll.id}`;
      const response = await request(route); expect(response.status).toBe(200);
      const body = await response.json() as any; expect(body.tally.counts).toEqual([0, 1]); expect(body.tally.closedBy).toBe('creator');
      for (const cutoff of ['-1', '2junk', '1.5', '', '9007199254740992']) {
        const r = await request(`${route}?atSeq=${cutoff}`); expect(r.status).toBe(400); expect(r.headers.get('cache-control')).toBe('no-store');
      }
      expect((await request(`${route}?atSeq=0`)).status).toBe(200);
      if (adapter !== 'Pages memory') {
        seed(f.db, [filler(h.poll, 100, { padding: 'x'.repeat(limits.recordBytes) })]);
        const before = f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n, broadcasts = f.broadcasts.length;
        for (const path of [route, route + '/audit', route + '/proof/' + h.votes[0].id]) {
          const r = await request(path); expect(r.status).toBe(503); expect(await r.json()).toMatchObject({ code: 'poll_work_limit' });
        }
        const catalog = await request(`/v1/polls?channel=${h.poll.channel}`); expect(catalog.status).toBe(200);
        expect((await catalog.json() as any).unavailable).toEqual([{ pollId: h.poll.id, channel: h.poll.channel, status: 'unavailable', code: 'poll_work_limit' }]);
        for (const envelope of [h.votes[3], await signEnvelope({ channel: h.poll.channel, sender: h.creator.agentId, type: 'poll', sequence: 703,
          payload: { kind: 'close', pollId: h.poll.id, pollHash: h.poll.checksum } }, h.creator.signingPrivateKey)]) {
          const r = await request(`/v1/channels/${h.poll.channel}/messages`, envelope); expect(r.status).toBe(503);
        }
        expect(f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n).toBe(before); expect(f.broadcasts.length).toBe(broadcasts);
      }
    } finally { f.close(); }
  });
});

it('bounds fallback scans and legacy object complexity without truncating memory tallies', async () => {
  const h = await signedHistory(), agent = (id: string) => ({ publicKey: h.keys.get(id) ?? null, registeredAt: 1 });
  const rows = [h.poll, ...Array.from({ length: limits.records }, (_, n) => filler(h.poll, n))];
  const store = createMemoryPollStore(() => rows, agent);
  const r = await handlePollRead(new Request(`${origin}/v1/polls/${h.poll.id}`), store);
  expect(r?.status).toBe(503); expect(await r?.json()).toMatchObject({ code: 'poll_work_limit' });
  const many = Array.from({ length: limits.memoryScans + 1 }, (_, n) => ({ ...h.poll, id: `irrelevant-${n}`, type: 'intel' as const }));
  await expect(createMemoryPollStore(() => many, agent).getPoll(undefined, 'absent')).rejects.toMatchObject({ code: 'poll_work_limit' });
  const deep = filler(h.poll, 0, { padding: Array(1025).fill(0) });
  await expect(createMemoryPollStore(() => [deep], agent).candidates(h.poll.channel, h.poll.id)).rejects.toMatchObject({ code: 'poll_work_limit' });
});
