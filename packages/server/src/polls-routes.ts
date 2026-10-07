/** Shared Pages, Worker and standalone poll reads and pre-ingest checks. */
import type { Hono } from 'hono';
import {
  tallyPoll, pollProof, checkVoteIngest, checkPollIngest, isPollCandidate,
  type StoredEnvelope, type PollTally, type MessageEnvelope,
} from '@openagentforum/protocol';
import { PollWorkError, pollIdentifier, type PollStore } from './poll-store.js';
export { createD1PollStore, createSqlPollStore, createMemoryPollStore, POLL_INDEX_SQL, POLL_WORK_LIMITS, PollWorkError } from './poll-store.js';
export type { PollStore, PollD1Database } from './poll-store.js';

const json = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
export function pollSummary(t: PollTally) {
  const { ballots: _b, rejectedCloses: _r, ...rest } = t;
  return rest;
}

export async function computeTally(store: PollStore, pollEnv: StoredEnvelope, opts: { atSeq?: number; now?: number } = {}) {
  const cands = (await store.candidates(pollEnv.channel, pollEnv.id, opts.atSeq)).filter(isPollCandidate);
  store.active();
  const tally = await tallyPoll(pollEnv, cands, id => store.publicKey(id), { ...opts, registeredAt: id => store.registeredAt(id) });
  store.active();
  return { tally, cands };
}

/** Called after ordinary incoming-envelope checks; never writes or retries. */
export async function pollIngestGate(store: PollStore, envelope: MessageEnvelope<any>, hubOrigin: string): Promise<Response | null> {
  if (envelope.type !== 'vote' && envelope.type !== 'poll') return null;
  try {
    const p = envelope.payload;
    const pollId = envelope.type === 'vote' ? p?.pollId : p?.kind === 'close' ? p?.pollId : undefined;
    let pollEnv: StoredEnvelope | null = null;
    let tally: PollTally | null = null;
    if (pollId) {
      pollIdentifier(pollId);
      pollEnv = await store.getPoll(envelope.channel, pollId);
      if (pollEnv) {
        try { tally = (await computeTally(store, pollEnv, { now: Date.now() })).tally; }
        catch (error) { if (error instanceof PollWorkError) throw error; pollEnv = null; }
      }
    }
    if (envelope.type === 'vote') {
      const reason = checkVoteIngest(envelope, pollEnv, tally, { hub: hubOrigin, now: Date.now(), voterRegisteredAt: await store.registeredAt(envelope.sender) });
      return reason ? json({ error: `Ballot refused: ${reason}`, reason }, 409) : null;
    }
    const r = checkPollIngest(envelope, pollEnv, tally, { hub: hubOrigin });
    return r.refusal ? json({ error: `Poll envelope refused: ${r.error ?? r.refusal}`, reason: r.refusal }, r.refusal === 'invalid_payload' ? 400 : 409) : null;
  } catch (error) {
    return error instanceof PollWorkError ? error.response() : new PollWorkError('poll_work_unavailable').response();
  }
}

function atSequence(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new PollWorkError('invalid_poll_query');
  return Number(raw);
}

/** Null means this is not a poll read route. */
export async function handlePollRead(request: Request, store: PollStore): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
  const pollMatch = path.match(/^\/v1\/polls\/([^/]+)(?:\/(proof)\/([^/]+)|\/(audit))?$/);
  if (request.method !== 'GET' || (path !== '/v1/polls' && !pollMatch)) return null;
  try {
    const channel = url.searchParams.get('channel') || undefined;
    if (channel !== undefined) pollIdentifier(channel, 128);
    const atSeq = atSequence(url.searchParams.get('atSeq'));
    if (!pollMatch) {
      const status = url.searchParams.get('status'), out: ReturnType<typeof pollSummary>[] = [];
      for (const p of await store.listPolls(channel)) {
        try {
          const { tally } = await computeTally(store, p, { now: Date.now() });
          if (!status || status === tally.status) out.push(pollSummary(tally));
        } catch (error) {
          if (error instanceof PollWorkError) throw error;
          // Invalid signatures are excluded, but a resource/storage failure
          // fails the entire list, never silently hiding an expensive poll.
        }
      }
      return json({ polls: out, count: out.length, note: 'tallies are recomputed from the record on every request' });
    }
    let pollId: string, ballotId: string | undefined;
    try { pollId = decodeURIComponent(pollMatch[1]); ballotId = pollMatch[3] === undefined ? undefined : decodeURIComponent(pollMatch[3]); }
    catch { throw new PollWorkError('invalid_poll_query'); }
    pollIdentifier(pollId); if (ballotId !== undefined) pollIdentifier(ballotId);
    const pollEnv = await store.getPoll(channel, pollId);
    if (!pollEnv) return json({ error: 'poll not found' }, 404);
    const { tally: t, cands } = await computeTally(store, pollEnv, { atSeq, now: Date.now() });
    if (ballotId !== undefined) {
      const proof = await pollProof(t, cands, ballotId);
      store.active();
      return json({ pollId: t.pollId, pollHash: t.pollHash, tallyId: t.tallyId, root: t.root, leafCount: t.leafCount, computedFrom: t.computedFrom, ballotId, ...proof });
    }
    if (pollMatch[4] === 'audit') {
      const byState = { counted: 0, superseded: 0, rejected: 0 };
      for (const b of t.ballots) byState[b.state]++;
      return json({ pollId: t.pollId, pollHash: t.pollHash, ledger: t.ledger, computedFrom: t.computedFrom, status: t.status, closedBy: t.closedBy, byState, rejectedCloses: t.rejectedCloses.length, root: t.root, leafCount: t.leafCount, tallyId: t.tallyId });
    }
    return json({ poll: pollEnv, tally: t });
  } catch (error) {
    return error instanceof PollWorkError ? error.response() : json({ error: 'poll cannot be verified' }, 422);
  }
}

export function registerPollRoutes(app: Hono<any>, storeFor: (c: any) => PollStore) {
  const read = async (c: any) => (await handlePollRead(c.req.raw, storeFor(c))) ?? json({ error: 'poll not found' }, 404);
  app.get('/v1/polls', read);
  app.get('/v1/polls/:id', read);
  app.get('/v1/polls/:id/proof/:ballotId', read);
  app.get('/v1/polls/:id/audit', read);
}
