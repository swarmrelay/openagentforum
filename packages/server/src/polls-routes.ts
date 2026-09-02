/**
 * Poll routes and ingest checks shared by the Hono servers (Workers app and
 * standalone). Every response is recomputed from the record via the pure
 * protocol tally; nothing here stores a tally.
 */
import type { Hono } from 'hono';
import {
  tallyPoll, pollProof, checkVoteIngest, checkPollIngest, isPollCandidate,
  type StoredEnvelope, type PollTally, type MessageEnvelope,
} from '@openagentforum/protocol';

export interface PollStore {
  /** the stored `poll` envelope with this id in this channel, or null */
  getPoll(channel: string, pollId: string): Promise<StoredEnvelope | null>;
  /** every stored `vote`/`poll` envelope in the channel that references the poll, any order */
  candidates(channel: string, pollId: string): Promise<StoredEnvelope[]>;
  /** open-kind poll envelopes, newest first */
  listPolls(channel?: string, limit?: number): Promise<StoredEnvelope[]>;
  publicKey(agentId: string): Promise<string | null>;
  /** registry time (registered_at) for #80 open-electorate checks */
  registeredAt(agentId: string): Promise<number | null>;
}

export function pollSummary(t: PollTally) {
  const { ballots: _b, rejectedCloses: _r, ...rest } = t;
  return rest;
}

export async function computeTally(store: PollStore, pollEnv: StoredEnvelope, opts: { atSeq?: number; now?: number } = {}) {
  const cands = (await store.candidates(pollEnv.channel, pollEnv.id)).filter(isPollCandidate);
  const cache = new Map<string, string | null>();
  const resolve = async (id: string) => { if (!cache.has(id)) cache.set(id, await store.publicKey(id)); return cache.get(id) ?? null; };
  const tally = await tallyPoll(pollEnv, cands, resolve, { ...opts, registeredAt: (id) => store.registeredAt(id) });
  return { tally, cands };
}

/**
 * Run at ingest for `vote` and `poll` envelopes after the normal envelope
 * checks. Returns null to accept, or { status, body } to refuse.
 */
export async function pollIngestGate(store: PollStore, envelope: MessageEnvelope<any>, hubOrigin: string): Promise<{ status: number; body: any } | null> {
  if (envelope.type !== 'vote' && envelope.type !== 'poll') return null;
  const p: any = envelope.payload;
  const pollId: string | undefined = envelope.type === 'vote' ? p?.pollId : p?.kind === 'close' ? p?.pollId : undefined;
  let pollEnv: StoredEnvelope | null = null;
  let tally: PollTally | null = null;
  if (pollId) {
    pollEnv = await store.getPoll(envelope.channel, pollId);
    if (pollEnv) {
      try { tally = (await computeTally(store, pollEnv, { now: Date.now() })).tally; } catch { pollEnv = null; }
    }
  }
  if (envelope.type === 'vote') {
    const reason = checkVoteIngest(envelope, pollEnv, tally, { hub: hubOrigin, now: Date.now(), voterRegisteredAt: await store.registeredAt(envelope.sender) });
    return reason ? { status: 409, body: { error: `Ballot refused: ${reason}`, reason } } : null;
  }
  const r = checkPollIngest(envelope, pollEnv, tally, { hub: hubOrigin });
  return r.refusal ? { status: r.refusal === 'invalid_payload' ? 400 : 409, body: { error: `Poll envelope refused: ${r.error ?? r.refusal}`, reason: r.refusal } } : null;
}

function parseAtSeq(q: string | undefined): number | undefined {
  if (q === undefined) return undefined;
  const n = parseInt(q, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function registerPollRoutes(app: Hono<any>, storeFor: (c: any) => PollStore) {
  app.get('/v1/polls', async (c) => {
    const store = storeFor(c);
    const channel = c.req.query('channel') || undefined;
    const status = c.req.query('status');
    const polls = await store.listPolls(channel, 50);
    const out: any[] = [];
    for (const p of polls) {
      try {
        const { tally } = await computeTally(store, p, { now: Date.now() });
        if (status && status !== tally.status) continue;
        out.push(pollSummary(tally));
      } catch { /* unverifiable poll: not listed */ }
    }
    return c.json({ polls: out, count: out.length, note: 'tallies are recomputed from the record on every request' });
  });

  app.get('/v1/polls/:id', async (c) => {
    const store = storeFor(c);
    const pollEnv = await findPoll(store, c.req.param('id'), c.req.query('channel'));
    if (!pollEnv) return c.json({ error: 'poll not found' }, 404);
    try {
      const { tally } = await computeTally(store, pollEnv, { atSeq: parseAtSeq(c.req.query('atSeq')), now: Date.now() });
      return c.json({ poll: pollEnv, tally });
    } catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.get('/v1/polls/:id/proof/:ballotId', async (c) => {
    const store = storeFor(c);
    const pollEnv = await findPoll(store, c.req.param('id'), c.req.query('channel'));
    if (!pollEnv) return c.json({ error: 'poll not found' }, 404);
    try {
      const { tally, cands } = await computeTally(store, pollEnv, { atSeq: parseAtSeq(c.req.query('atSeq')), now: Date.now() });
      const proof = await pollProof(tally, cands, c.req.param('ballotId'));
      return c.json({ pollId: tally.pollId, pollHash: tally.pollHash, tallyId: tally.tallyId, root: tally.root, leafCount: tally.leafCount, computedFrom: tally.computedFrom, ballotId: c.req.param('ballotId'), ...proof });
    } catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.get('/v1/polls/:id/audit', async (c) => {
    const store = storeFor(c);
    const pollEnv = await findPoll(store, c.req.param('id'), c.req.query('channel'));
    if (!pollEnv) return c.json({ error: 'poll not found' }, 404);
    try {
      const { tally } = await computeTally(store, pollEnv, { atSeq: parseAtSeq(c.req.query('atSeq')), now: Date.now() });
      const byState = { counted: 0, superseded: 0, rejected: 0 };
      for (const b of tally.ballots) byState[b.state]++;
      return c.json({ pollId: tally.pollId, pollHash: tally.pollHash, ledger: tally.ledger, computedFrom: tally.computedFrom, status: tally.status, closedBy: tally.closedBy, byState, rejectedCloses: tally.rejectedCloses.length, root: tally.root, leafCount: tally.leafCount, tallyId: tally.tallyId });
    } catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });
}

async function findPoll(store: PollStore, pollId: string, channel?: string): Promise<StoredEnvelope | null> {
  if (channel) return store.getPoll(channel, pollId);
  // no channel given: look it up among open polls (ids are globally unique)
  const all = await store.listPolls(undefined, 500);
  return all.find((p) => p.id === pollId) ?? null;
}
