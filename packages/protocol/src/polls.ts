/**
 * Polls and ballots on the ledger (RFC 0001 v2).
 *
 * A poll is a `poll` envelope (kind open); a ballot is a `vote` envelope
 * bound to it by pollId and pollHash; the creator may `close` if the poll
 * allowed it. The tally is a pure function over the authoritative ledger's
 * record in storedSeq order. Everything the record can settle is re-applied
 * here, so a relay cannot smuggle a ballot into an honest count. The one
 * rule the record cannot settle, the wall-clock deadline, is reported as
 * ingest-enforced rather than pretended.
 */
import { verifyEnvelope, sha256Hex, bytesToHex } from './crypto.js';
import { merkleLeafHash, merkleRoot, merkleProof, verifyMerkleProof, type MerkleProof } from './merkle.js';
import type { MessageEnvelope } from './types.js';
import type { StoredEnvelope } from './record.js';
import type { PublicKeyResolver } from './audit.js';

export type PollMethod = 'plurality' | 'absolute_majority' | 'threshold';
export interface PollRule {
  method: PollMethod;
  /** threshold only: exact ratio numerator/denominator */
  numerator?: number;
  denominator?: number;
  /** threshold only: fraction of counted ballots or of the list electorate */
  of?: 'ballots' | 'electorate';
}
export type PollElectorate = { type: 'open' } | { type: 'list'; agentIds: string[] };

export interface PollOpenPayload {
  kind: 'open';
  title: string;
  description?: string;
  options: string[];
  ledger: { hub: string };
  electorate: PollElectorate;
  quorum?: { minVoters: number };
  closes: { at?: number; allVoted?: boolean };
  closePolicy?: { creator: boolean };
  rule: PollRule;
  revote?: 'latest' | 'first';
}
export interface PollClosePayload { kind: 'close'; pollId: string; pollHash: string }
export interface VotePayload { pollId: string; pollHash: string; choice: number; justificationRef?: string }

export const POLL_REFUSALS = [
  'poll_not_found', 'wrong_ledger', 'poll_hash_mismatch', 'poll_closed', 'not_in_electorate',
  'invalid_choice', 'already_voted', 'encrypted_unsupported', 'invalid_close', 'invalid_payload',
] as const;
export type PollRefusal = (typeof POLL_REFUSALS)[number];

export const POLL_LIMITS = { titleMax: 200, descriptionMax: 4000, optionsMin: 2, optionsMax: 32, optionMax: 200, listMin: 2, listMax: 1000 };

/** NFKC, collapse whitespace, trim: the form every human-facing poll string must already be in. */
export function normalizePollText(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function normalizeHub(hub: string): string {
  return hub.trim().toLowerCase().replace(/\/+$/, '');
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const isAgentId = (s: unknown): s is string => typeof s === 'string' && /^agent_[0-9a-f]{16}$/.test(s);

/** Validate a `poll` open payload. Strings must already be normalized (the creator signs them that way). */
export function validatePollOpen(p: any): { ok: true; payload: PollOpenPayload } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!p || typeof p !== 'object' || p.kind !== 'open') return bad('kind must be "open"');
  if (typeof p.title !== 'string' || p.title.length === 0 || p.title.length > POLL_LIMITS.titleMax) return bad('title required, up to 200 characters');
  if (p.title !== normalizePollText(p.title)) return bad('title must be NFKC-normalized and trimmed');
  if (p.description !== undefined) {
    if (typeof p.description !== 'string' || p.description.length > POLL_LIMITS.descriptionMax) return bad('description must be a string up to 4000 characters');
    if (p.description !== normalizePollText(p.description)) return bad('description must be NFKC-normalized and trimmed');
  }
  if (!Array.isArray(p.options) || p.options.length < POLL_LIMITS.optionsMin || p.options.length > POLL_LIMITS.optionsMax) return bad('options must have 2 to 32 entries');
  const seen = new Set<string>();
  for (const o of p.options) {
    if (typeof o !== 'string' || o.length === 0 || o.length > POLL_LIMITS.optionMax) return bad('each option must be a non-empty string up to 200 characters');
    if (o !== normalizePollText(o)) return bad('options must be NFKC-normalized and trimmed');
    if (seen.has(o)) return bad('options must be distinct');
    seen.add(o);
  }
  const hubOk = typeof p.ledger?.hub === 'string' && (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(p.ledger.hub.replace(/\/+$/, '')) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(p.ledger.hub.replace(/\/+$/, '')));
  if (!hubOk) return bad('ledger.hub must be an https origin (http only for localhost relays)');
  const e = p.electorate;
  if (!e || (e.type !== 'open' && e.type !== 'list')) return bad('electorate.type must be "open" or "list"');
  if (e.type === 'list') {
    if (!Array.isArray(e.agentIds) || e.agentIds.length < POLL_LIMITS.listMin || e.agentIds.length > POLL_LIMITS.listMax) return bad('electorate.agentIds must list 2 to 1000 agents');
    if (!e.agentIds.every(isAgentId)) return bad('electorate.agentIds must be agent ids');
    if (new Set(e.agentIds).size !== e.agentIds.length) return bad('electorate.agentIds must be distinct');
  }
  if (p.quorum !== undefined && (!p.quorum || !isInt(p.quorum.minVoters) || p.quorum.minVoters < 1)) return bad('quorum.minVoters must be a positive integer');
  const c = p.closes;
  if (!c || typeof c !== 'object') return bad('closes required');
  if (c.at !== undefined && (!isInt(c.at) || c.at <= 0)) return bad('closes.at must be an epoch ms integer');
  if (c.allVoted !== undefined && typeof c.allVoted !== 'boolean') return bad('closes.allVoted must be boolean');
  if (c.at === undefined && !c.allVoted) return bad('closes needs at least one of at or allVoted');
  if (c.allVoted && e.type !== 'list') return bad('closes.allVoted requires a list electorate');
  if (p.closePolicy !== undefined && (!p.closePolicy || typeof p.closePolicy.creator !== 'boolean')) return bad('closePolicy.creator must be boolean');
  const r = p.rule;
  if (!r || !['plurality', 'absolute_majority', 'threshold'].includes(r.method)) return bad('rule.method must be plurality, absolute_majority, or threshold');
  if (r.method === 'threshold') {
    if (!isInt(r.numerator) || !isInt(r.denominator) || r.numerator < 1 || r.denominator < 1 || r.numerator > r.denominator) return bad('threshold needs integer numerator <= denominator');
    if (r.of !== undefined && r.of !== 'ballots' && r.of !== 'electorate') return bad('rule.of must be ballots or electorate');
    if (r.of === 'electorate' && e.type !== 'list') return bad('rule.of electorate requires a list electorate');
  }
  if (p.revote !== undefined && p.revote !== 'latest' && p.revote !== 'first') return bad('revote must be latest or first');
  return { ok: true, payload: p as PollOpenPayload };
}

export function validateVotePayload(p: any): { ok: true; payload: VotePayload } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!p || typeof p !== 'object') return bad('payload required');
  if (typeof p.pollId !== 'string' || !p.pollId) return bad('pollId required');
  if (typeof p.pollHash !== 'string' || !/^[0-9a-f]{64}$/i.test(p.pollHash)) return bad('pollHash must be a sha256 hex');
  if (!isInt(p.choice) || p.choice < 0) return bad('choice must be a non-negative integer index');
  if (p.justificationRef !== undefined && (typeof p.justificationRef !== 'string' || p.justificationRef.length > 200)) return bad('justificationRef must be an envelope id');
  return { ok: true, payload: p as VotePayload };
}

export function validateClosePayload(p: any): { ok: true; payload: PollClosePayload } | { ok: false; error: string } {
  if (!p || p.kind !== 'close' || typeof p.pollId !== 'string' || typeof p.pollHash !== 'string') return { ok: false, error: 'close needs kind, pollId, pollHash' };
  return { ok: true, payload: p as PollClosePayload };
}

// ── tally ───────────────────────────────────────────────────────────

export type BallotState = 'counted' | 'superseded' | 'rejected';
export interface BallotRecord { id: string; sender: string; storedSeq?: number; choice?: number; state: BallotState; reason: string | null }

export interface PollTally {
  pollId: string;
  pollHash: string;
  channel: string;
  creator: string;
  title: string;
  options: string[];
  ledger: { hub: string };
  computedFrom: { channel: string; maxStoredSeq: number };
  status: 'open' | 'closed';
  closedBy: 'allVoted' | 'creator' | 'deadline' | null;
  closedAtSeq: number | null;
  deadline: 'ingest-enforced';
  deadlineAt: number | null;
  /** open electorates depend on the ledger's registry times; list electorates are pinned by construction */
  electorateBasis: 'list' | 'registry-trusted';
  counts: number[];
  validBallots: number;
  countedBallots: number;
  distinctVoters: number;
  quorumMet: boolean;
  outcome: { valid: boolean; winner: number | null; reason: string };
  ballots: BallotRecord[];
  rejectedCloses: Array<{ id: string; sender: string; reason: string }>;
  root: string;
  leafCount: number;
  tallyId: string;
}

export interface TallyOptions {
  /** cutoff: only envelopes with storedSeq <= atSeq are considered */
  atSeq?: number;
  /**
   * (#80) open electorates: the ledger's registry time for an agent. A voter
   * registered after the poll envelope's timestamp is not in the electorate.
   * Registry time is asserted by the authoritative ledger, so open-electorate
   * membership is reported as registry-trusted, like the deadline.
   */
  registeredAt?: (agentId: string) => Promise<number | null | undefined>;
  /** relay clock, used only to report deadline status for an open poll (never to drop a stored ballot) */
  now?: number;
}

export function pollLeafBytes(pollHash: string, env: StoredEnvelope): string {
  return `oaf-poll-leaf-v1|${pollHash}|${env.storedSeq ?? 0}|${env.id}|${env.sender}|${env.sequence}|${env.checksum}|${env.signature}`;
}

async function verifyStored(env: StoredEnvelope, resolve: PublicKeyResolver, cache: Map<string, string | null>): Promise<string | null> {
  if (!cache.has(env.sender)) cache.set(env.sender, (await resolve(env.sender)) ?? null);
  const pub = cache.get(env.sender);
  if (!pub) return 'sender public key not resolvable';
  const r = await verifyEnvelope(env, pub);
  return r.valid ? null : (r.error || 'signature does not verify');
}

/**
 * Pure tally. `candidates` are every stored envelope in the channel that
 * could concern this poll (all `vote` and `poll` envelopes is fine; the
 * function filters by pollId). Deterministic for a given record and cutoff.
 */
export async function tallyPoll(
  pollEnv: StoredEnvelope,
  candidates: StoredEnvelope[],
  resolvePublicKey: PublicKeyResolver,
  opts: TallyOptions = {}
): Promise<PollTally> {
  const cache = new Map<string, string | null>();
  const pollErr = await verifyStored(pollEnv, resolvePublicKey, cache);
  if (pollErr) throw new Error(`poll envelope does not verify as stored: ${pollErr}`);
  const v = validatePollOpen(pollEnv.payload);
  if (!v.ok) throw new Error(`poll payload invalid: ${v.error}`);
  const poll = v.payload;
  const pollId = pollEnv.id;
  const pollHash = pollEnv.checksum;
  const channel = pollEnv.channel;
  const revote = poll.revote ?? 'first';
  const cutoff = opts.atSeq ?? Number.MAX_SAFE_INTEGER;
  const listSet = poll.electorate.type === 'list' ? new Set(poll.electorate.agentIds) : null;
  // (#88) an open electorate cannot be tallied without registry times: refusing is
  // honest, silently counting everyone registered-now is not
  if (!listSet && !opts.registeredAt) throw new Error('open-electorate poll requires a registeredAt resolver (registry time per agent); see RFC 0001 #80');

  const inScope = candidates
    .filter((e) => e.channel === channel && (e.storedSeq ?? 0) <= cutoff && e.id !== pollId)
    .filter((e) => (e.type === 'vote' || e.type === 'poll') && e.payload && (e.payload as any).pollId === pollId)
    .sort((a, b) => (a.storedSeq ?? 0) - (b.storedSeq ?? 0));

  // closes: only the creator, only if allowed, only binding this poll
  let closedAtSeq: number | null = null;
  let closedBy: PollTally['closedBy'] = null;
  const rejectedCloses: PollTally['rejectedCloses'] = [];
  for (const e of inScope.filter((e) => e.type === 'poll')) {
    const c = validateClosePayload(e.payload);
    let reason: string | null = null;
    if (!c.ok) reason = c.error;
    else if (e.encrypted) reason = 'encrypted_unsupported';
    else if (!(poll.closePolicy?.creator)) reason = 'poll does not allow creator close';
    else if (e.sender !== pollEnv.sender) reason = 'close not signed by the poll creator';
    else if (c.payload.pollHash !== pollHash) reason = 'poll_hash_mismatch';
    else reason = await verifyStored(e, resolvePublicKey, cache);
    if (reason) { rejectedCloses.push({ id: e.id, sender: e.sender, reason }); continue; }
    if (closedAtSeq === null) { closedAtSeq = e.storedSeq ?? 0; closedBy = 'creator'; }
    else rejectedCloses.push({ id: e.id, sender: e.sender, reason: 'poll already closed by an earlier close' });
  }

  // ballots in storedSeq order, re-applying every record-settleable rule
  const ballots: BallotRecord[] = [];
  const countedIdx = new Map<string, number>(); // sender -> index into ballots of the counted ballot
  const voters = new Set<string>();
  let validBallots = 0;
  for (const e of inScope.filter((e) => e.type === 'vote')) {
    const seq = e.storedSeq ?? 0;
    const rec: BallotRecord = { id: e.id, sender: e.sender, storedSeq: e.storedSeq, state: 'rejected', reason: null };
    ballots.push(rec);
    const reject = (reason: string) => { rec.state = 'rejected'; rec.reason = reason; };
    const shape = validateVotePayload(e.payload);
    if (!shape.ok) { reject('invalid_payload'); continue; }
    if (e.encrypted) { reject('encrypted_unsupported'); continue; }
    const verr = await verifyStored(e, resolvePublicKey, cache);
    if (verr) { reject(verr); continue; }
    validBallots++;
    const vp = shape.payload;
    rec.choice = vp.choice;
    if (vp.pollHash !== pollHash) { reject('poll_hash_mismatch'); continue; }
    if (closedAtSeq !== null && seq > closedAtSeq) { reject('poll_closed'); continue; }
    if (listSet ? !listSet.has(e.sender) : false) { reject('not_in_electorate'); continue; }
    if (!listSet) {
      const reg = await opts.registeredAt!(e.sender);
      if (reg === null || reg === undefined || reg > pollEnv.timestamp) { reject('not_in_electorate'); continue; }
    }
    if (vp.choice >= poll.options.length) { reject('invalid_choice'); continue; }
    if (revote === 'first' && countedIdx.has(e.sender)) { reject('already_voted'); continue; }
    // accepted
    if (countedIdx.has(e.sender)) { const prev = ballots[countedIdx.get(e.sender)!]; prev.state = 'superseded'; prev.reason = null; }
    rec.state = 'counted';
    countedIdx.set(e.sender, ballots.length - 1);
    voters.add(e.sender);
    // allVoted closes the poll from the record the moment the last listed voter is counted
    if (poll.closes.allVoted && listSet && closedAtSeq === null && [...listSet].every((a) => voters.has(a))) {
      closedAtSeq = seq; closedBy = 'allVoted';
    }
  }

  const counted = ballots.filter((b) => b.state === 'counted');
  const counts = poll.options.map(() => 0);
  for (const b of counted) counts[b.choice!]++;
  const distinctVoters = counted.length;
  const quorumMet = !poll.quorum || distinctVoters >= poll.quorum.minVoters;

  // outcome
  let winner: number | null = null;
  let reason = '';
  const max = Math.max(...counts);
  const leaders = counts.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0);
  if (counted.length === 0) { reason = 'no counted ballots'; }
  else if (poll.rule.method === 'plurality') {
    if (leaders.length === 1) { winner = leaders[0]; reason = `plurality: ${max} of ${counted.length} ballots`; } else reason = `tie between options ${leaders.join(', ')}`;
  } else if (poll.rule.method === 'absolute_majority') {
    if (leaders.length === 1 && max * 2 > counted.length) { winner = leaders[0]; reason = `absolute majority: ${max} of ${counted.length} ballots`; } else reason = `no option holds more than half of ${counted.length} ballots`;
  } else {
    const base = poll.rule.of === 'electorate' && listSet ? listSet.size : counted.length;
    const need = Math.ceil((poll.rule.numerator! * base) / poll.rule.denominator!);
    if (leaders.length === 1 && max >= need) { winner = leaders[0]; reason = `threshold ${poll.rule.numerator}/${poll.rule.denominator} of ${poll.rule.of ?? 'ballots'} (${need} of ${base}) reached with ${max}`; }
    else reason = `no option reaches ${need} of ${base} ${poll.rule.of ?? 'ballots'}`;
  }
  const outcome = { valid: quorumMet && winner !== null, winner, reason: quorumMet ? reason : `quorum not met: ${distinctVoters} of ${poll.quorum!.minVoters} voters (${reason})` };

  // status: closed by record (creator/allVoted), or by deadline as reported by the relay clock (not re-applied to ballots)
  let status: 'open' | 'closed' = closedAtSeq !== null ? 'closed' : 'open';
  if (status === 'open' && poll.closes.at !== undefined && opts.now !== undefined && opts.now > poll.closes.at) { status = 'closed'; closedBy = 'deadline'; }

  // merkle over counted ballots in storedSeq order
  const countedEnvs = inScope.filter((e) => e.type === 'vote' && counted.some((b) => b.id === e.id));
  const leaves = await Promise.all(countedEnvs.map((e) => merkleLeafHash(pollLeafBytes(pollHash, e))));
  const root = bytesToHex(await merkleRoot(leaves));
  const maxStoredSeq = Math.min(cutoff, Math.max(pollEnv.storedSeq ?? 0, ...inScope.map((e) => e.storedSeq ?? 0)));
  const ledgerHub = normalizeHub(poll.ledger.hub);
  const tallyId = await sha256Hex(`oaf-poll-tally-v1|${pollHash}|${ledgerHub}|${maxStoredSeq}|${leaves.length}|${root}`);

  return {
    pollId, pollHash, channel, creator: pollEnv.sender, title: poll.title, options: poll.options,
    ledger: { hub: ledgerHub }, computedFrom: { channel, maxStoredSeq },
    status, closedBy, closedAtSeq, deadline: 'ingest-enforced', deadlineAt: poll.closes.at ?? null,
    electorateBasis: listSet ? 'list' : 'registry-trusted',
    counts, validBallots, countedBallots: counted.length, distinctVoters, quorumMet, outcome,
    ballots, rejectedCloses, root, leafCount: leaves.length, tallyId,
  };
}

/** Inclusion proof for a counted ballot at the same cutoff the tally used. */
export async function pollProof(tally: PollTally, candidates: StoredEnvelope[], ballotId: string): Promise<{ state: BallotState | 'unknown'; proof?: MerkleProof; leafBytes?: string }> {
  const rec = tally.ballots.find((b) => b.id === ballotId);
  if (!rec) return { state: 'unknown' };
  if (rec.state !== 'counted') return { state: rec.state };
  const countedIds = tally.ballots.filter((b) => b.state === 'counted').map((b) => b.id);
  const envs = countedIds.map((id) => candidates.find((e) => e.id === id)!).filter(Boolean);
  const leaves = await Promise.all(envs.map((e) => merkleLeafHash(pollLeafBytes(tally.pollHash, e))));
  const idx = countedIds.indexOf(ballotId);
  const proof = await merkleProof(idx, leaves);
  return { state: 'counted', proof, leafBytes: pollLeafBytes(tally.pollHash, envs[idx]) };
}

export async function verifyPollProof(leafBytes: string, proof: MerkleProof, root: string): Promise<boolean> {
  return verifyMerkleProof(await merkleLeafHash(leafBytes), proof, root);
}

// ── ingest checks (relay side) ───────────────────────────────────────

export interface IngestContext {
  /** this relay's origin, compared against poll.ledger.hub */
  hub: string;
  now: number;
  /** (#80) the voter's registry time on this relay; required to admit an open-electorate ballot */
  voterRegisteredAt?: number | null;
}

/**
 * Decide whether a relay may store a new `vote`. `tally` is the current
 * tally of the poll from this relay's record; `pollEnv` its open envelope.
 * Returns null to accept, or the refusal reason.
 */
export function checkVoteIngest(vote: MessageEnvelope<any>, pollEnv: StoredEnvelope | null, tally: PollTally | null, ctx: IngestContext): PollRefusal | null {
  if (vote.encrypted) return 'encrypted_unsupported';
  const shape = validateVotePayload(vote.payload);
  if (!shape.ok) return 'invalid_payload';
  if (!pollEnv || !tally || pollEnv.channel !== vote.channel) return 'poll_not_found';
  const poll = pollEnv.payload as PollOpenPayload;
  if (normalizeHub(poll.ledger.hub) !== normalizeHub(ctx.hub)) return 'wrong_ledger';
  if (shape.payload.pollHash !== pollEnv.checksum) return 'poll_hash_mismatch';
  if (tally.closedAtSeq !== null) return 'poll_closed';
  if (poll.closes.at !== undefined && ctx.now > poll.closes.at) return 'poll_closed';
  if (poll.electorate.type === 'list' && !poll.electorate.agentIds.includes(vote.sender)) return 'not_in_electorate';
  if (poll.electorate.type === 'open' && (ctx.voterRegisteredAt === null || ctx.voterRegisteredAt === undefined || ctx.voterRegisteredAt > pollEnv.timestamp)) return 'not_in_electorate';
  if (shape.payload.choice >= poll.options.length) return 'invalid_choice';
  if ((poll.revote ?? 'first') === 'first' && tally.ballots.some((b) => b.sender === vote.sender && b.state === 'counted')) return 'already_voted';
  return null;
}

/** Decide whether a relay may store a `poll` envelope (open or close). */
export function checkPollIngest(env: MessageEnvelope<any>, pollEnv: StoredEnvelope | null, tally: PollTally | null, ctx?: { hub: string }): { refusal: PollRefusal | null; error?: string } {
  if (env.encrypted) return { refusal: 'encrypted_unsupported' };
  const p: any = env.payload;
  if (p?.kind === 'open') {
    const v = validatePollOpen(p);
    if (!v.ok) return { refusal: 'invalid_payload', error: v.error };
    // a relay stores only polls that name it as the ledger; otherwise ballots could never be counted here
    if (ctx && normalizeHub(v.payload.ledger.hub) !== normalizeHub(ctx.hub)) return { refusal: 'wrong_ledger', error: `poll names ${v.payload.ledger.hub} as its ledger, not this relay` };
    return { refusal: null };
  }
  if (p?.kind === 'close') {
    const c = validateClosePayload(p);
    if (!c.ok) return { refusal: 'invalid_payload', error: c.error };
    if (!pollEnv || !tally || pollEnv.channel !== env.channel) return { refusal: 'poll_not_found' };
    const poll = pollEnv.payload as PollOpenPayload;
    if (!poll.closePolicy?.creator) return { refusal: 'invalid_close', error: 'poll does not allow creator close' };
    if (env.sender !== pollEnv.sender) return { refusal: 'invalid_close', error: 'only the creator may close' };
    if (c.payload.pollHash !== pollEnv.checksum) return { refusal: 'poll_hash_mismatch' };
    if (tally.closedAtSeq !== null) return { refusal: 'poll_closed' };
    return { refusal: null };
  }
  return { refusal: 'invalid_payload', error: 'poll.kind must be open or close' };
}

/** Which stored envelopes a relay should hand to tallyPoll: cheap prefilter by type. */
export function isPollCandidate(env: StoredEnvelope): boolean {
  return env.type === 'vote' || env.type === 'poll';
}
