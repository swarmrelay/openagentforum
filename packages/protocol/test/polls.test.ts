import { describe, it, expect } from 'vitest';
import {
  generateAgentKeyPair, signEnvelope, tallyPoll, pollProof, verifyPollProof, checkVoteIngest, checkPollIngest,
  validatePollOpen, normalizePollText, merkleRoot, merkleLeafHash, merkleProof, verifyMerkleProof, bytesToHex, sha256Hex,
} from '../src/index.js';

const HUB = 'https://hub.test';
let seq = 0;
const stored = (env: any) => ({ ...env, storedSeq: ++seq });
const mk = (k: any, type: 'poll' | 'vote' | 'intel', payload: any, sequence = 0) =>
  signEnvelope({ channel: 'general', sender: k.agentId, type, sequence, payload }, k.signingPrivateKey);

async function setup(n = 4) {
  const keys = await Promise.all(Array.from({ length: n }, () => generateAgentKeyPair()));
  const resolve = async (id: string) => keys.find((k) => k.agentId === id)?.signingPublicKey ?? null;
  return { keys, resolve };
}

describe('RFC 6962 Merkle tree', () => {
  it('matches the RFC 6962 empty and single-leaf roots and verifies audit paths for every leaf', async () => {
    expect(bytesToHex(await merkleRoot([]))).toBe(await sha256Hex(''));
    const leaves = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => merkleLeafHash(s)));
    const one = await merkleLeafHash('a');
    expect(bytesToHex(await merkleRoot([one]))).toBe(bytesToHex(one));
    for (let n = 1; n <= leaves.length; n++) {
      const set = leaves.slice(0, n);
      const root = bytesToHex(await merkleRoot(set));
      for (let i = 0; i < n; i++) {
        const proof = await merkleProof(i, set);
        expect(await verifyMerkleProof(set[i], proof, root)).toBe(true);
        // a tampered sibling fails; leaf count is bound by the tallyId, not by the path alone
        if (proof.path.length) expect(await verifyMerkleProof(set[i], { ...proof, path: [proof.path[0].replace(/^./, (c) => (c === '0' ? '1' : '0')), ...proof.path.slice(1)] }, root)).toBe(false);
        expect(await verifyMerkleProof(set[i], { ...proof, leafIndex: (i + 1) % n }, root)).toBe(n === 1);
      }
    }
  });
});

describe('polls on the ledger (RFC 0001 v2)', () => {
  it('validates poll payloads: normalization, distinct options, exact-ratio thresholds, list-only rules', async () => {
    const base: any = { kind: 'open', title: 'Pick one', options: ['a', 'b'], ledger: { hub: HUB }, electorate: { type: 'open' }, closes: { at: 1 }, rule: { method: 'plurality' } };
    expect(validatePollOpen(base).ok).toBe(true);
    expect(validatePollOpen({ ...base, title: ' Pick one ' }).ok).toBe(false);
    expect(validatePollOpen({ ...base, options: ['a', 'a'] }).ok).toBe(false);
    expect(validatePollOpen({ ...base, options: ['Ａ', 'a'] }).ok).toBe(false); // fullwidth A is not normalized
    expect(normalizePollText('Ａ')).toBe('A');
    expect(validatePollOpen({ ...base, rule: { method: 'threshold', threshold: 0.67 } }).ok).toBe(false);
    expect(validatePollOpen({ ...base, rule: { method: 'threshold', numerator: 2, denominator: 3, of: 'electorate' } }).ok).toBe(false); // open electorate
    expect(validatePollOpen({ ...base, closes: { allVoted: true } }).ok).toBe(false); // open electorate
    expect(validatePollOpen({ ...base, ledger: { hub: 'http://x' } }).ok).toBe(false);
  });

  it('tallies a decision poll: first-vote wins, allVoted closes from the record, threshold of electorate, proofs verify', async () => {
    const { keys, resolve } = await setup(4);
    const [creator, a, b, c] = keys;
    const electorate = [a.agentId, b.agentId, c.agentId];
    const pollEnv = stored(await mk(creator, 'poll', {
      kind: 'open', title: 'Ship it?', options: ['yes', 'no'], ledger: { hub: HUB },
      electorate: { type: 'list', agentIds: electorate }, quorum: { minVoters: 2 },
      closes: { allVoted: true }, rule: { method: 'threshold', numerator: 2, denominator: 3, of: 'electorate' }, revote: 'first',
    }));
    const vote = (k: any, choice: number, extra: any = {}) => mk(k, 'vote', { pollId: pollEnv.id, pollHash: pollEnv.checksum, choice, ...extra }, 1);
    const cands: any[] = [];
    cands.push(stored(await vote(a, 0)));
    cands.push(stored(await vote(creator, 0)));           // not in electorate
    cands.push(stored(await vote(a, 1)));                 // revote under first: refused
    cands.push(stored(await vote(b, 0)));
    let t = await tallyPoll(pollEnv, cands, resolve);
    expect(t.status).toBe('open');
    expect(t.counts).toEqual([2, 0]);
    expect(t.ballots.map((x) => x.state)).toEqual(['counted', 'rejected', 'rejected', 'counted']);
    expect(t.ballots[1].reason).toBe('not_in_electorate');
    expect(t.ballots[2].reason).toBe('already_voted');
    expect(t.quorumMet).toBe(true);
    expect(t.outcome.valid).toBe(true); // 2 of 3 electorate reached
    expect(t.outcome.winner).toBe(0);
    // ingest: c may still vote; a may not (already voted); after c votes the poll is closed by allVoted
    const cv = await vote(c, 1);
    expect(checkVoteIngest(cv, pollEnv, t, { hub: HUB, now: 0 })).toBe(null);
    expect(checkVoteIngest(await vote(a, 1), pollEnv, t, { hub: HUB, now: 0 })).toBe('already_voted');
    expect(checkVoteIngest(cv, pollEnv, t, { hub: 'https://other.test', now: 0 })).toBe('wrong_ledger');
    cands.push(stored(cv));
    const late = stored(await vote(b, 1)); // stored after allVoted: every honest tally drops it
    cands.push(late);
    t = await tallyPoll(pollEnv, cands, resolve);
    expect(t.status).toBe('closed');
    expect(t.closedBy).toBe('allVoted');
    expect(t.counts).toEqual([2, 1]);
    expect(t.ballots.find((x) => x.id === late.id)!.reason).toBe('poll_closed');
    expect(t.leafCount).toBe(3);
    // inclusion proof for a counted ballot verifies against the root; a superseded/rejected one has no proof
    const pr = await pollProof(t, cands, cands[0].id);
    expect(pr.state).toBe('counted');
    expect(await verifyPollProof(pr.leafBytes!, pr.proof!, t.root)).toBe(true);
    expect((await pollProof(t, cands, late.id)).state).toBe('rejected');
    // deterministic: same record, same tallyId
    const again = await tallyPoll(pollEnv, [...cands].reverse(), resolve);
    expect(again.tallyId).toBe(t.tallyId);
    // a cutoff before the last two ballots changes the identity
    const early = await tallyPoll(pollEnv, cands, resolve, { atSeq: cands[3].storedSeq });
    expect(early.tallyId).not.toBe(t.tallyId);
    expect(early.status).toBe('open');
  });

  it('advisory poll: revote latest supersedes, plurality ties yield no winner, quorum gates validity', async () => {
    const { keys, resolve } = await setup(3);
    const [creator, a, b] = keys;
    const pollEnv = stored(await mk(creator, 'poll', {
      kind: 'open', title: 'Lunch?', options: ['x', 'y', 'z'], ledger: { hub: HUB }, electorate: { type: 'open' },
      quorum: { minVoters: 3 }, closes: { at: Date.now() + 60_000 }, rule: { method: 'plurality' }, revote: 'latest',
    }));
    const vote = (k: any, choice: number) => mk(k, 'vote', { pollId: pollEnv.id, pollHash: pollEnv.checksum, choice }, 1);
    const cands = [stored(await vote(a, 0)), stored(await vote(a, 1)), stored(await vote(b, 0)), stored(await vote(creator, 7))];
    const t = await tallyPoll(pollEnv, cands, resolve, { now: Date.now() });
    expect(t.ballots.map((x) => x.state)).toEqual(['superseded', 'counted', 'counted', 'rejected']);
    expect(t.ballots[3].reason).toBe('invalid_choice');
    expect(t.counts).toEqual([1, 1, 0]);
    expect(t.outcome.winner).toBe(null);
    expect(t.quorumMet).toBe(false);
    expect(t.outcome.valid).toBe(false);
    expect(t.deadline).toBe('ingest-enforced');
    // past the deadline the relay refuses at ingest, and the tally reports closed by deadline without dropping stored ballots
    expect(checkVoteIngest(await vote(b, 2), pollEnv, t, { hub: HUB, now: Date.now() + 120_000 })).toBe('poll_closed');
    const later = await tallyPoll(pollEnv, cands, resolve, { now: Date.now() + 120_000 });
    expect(later.status).toBe('closed');
    expect(later.closedBy).toBe('deadline');
    expect(later.countedBallots).toBe(2);
  });

  it('creator close is honored only when declared, only from the creator, and re-validated in the tally (#73)', async () => {
    const { keys, resolve } = await setup(3);
    const [creator, a, stranger] = keys;
    const open = (closePolicy: any) => mk(creator, 'poll', {
      kind: 'open', title: 'Close me', options: ['p', 'q'], ledger: { hub: HUB }, electorate: { type: 'open' },
      closes: { at: Date.now() + 60_000 }, rule: { method: 'plurality' }, ...(closePolicy ? { closePolicy } : {}),
    });
    const noClose = stored(await open(undefined));
    const withClose = stored(await open({ creator: true }));
    const closeBy = (k: any, p: any) => mk(k, 'poll', { kind: 'close', pollId: p.id, pollHash: p.checksum }, 2);
    // ingest refuses closes the poll did not allow, or from a non-creator
    const t0 = await tallyPoll(noClose, [], resolve);
    expect(checkPollIngest(await closeBy(creator, noClose), noClose, t0).refusal).toBe('invalid_close');
    const t1 = await tallyPoll(withClose, [], resolve);
    expect(checkPollIngest(await closeBy(stranger, withClose), withClose, t1).refusal).toBe('invalid_close');
    expect(checkPollIngest(await closeBy(creator, withClose), withClose, t1).refusal).toBe(null);
    // a dishonest relay stored a stranger's close and a creator close on the no-close poll: every tally ignores both
    const vote = (k: any, p: any, choice: number) => mk(k, 'vote', { pollId: p.id, pollHash: p.checksum, choice }, 1);
    const cands = [stored(await closeBy(stranger, withClose)), stored(await closeBy(creator, noClose)), stored(await vote(a, withClose, 0)), stored(await vote(a, noClose, 1))];
    const tw = await tallyPoll(withClose, cands, resolve);
    expect(tw.status).toBe('open');
    expect(tw.rejectedCloses.length).toBe(1);
    expect(tw.countedBallots).toBe(1);
    const tn = await tallyPoll(noClose, cands, resolve);
    expect(tn.status).toBe('open');
    expect(tn.rejectedCloses[0].reason).toMatch(/does not allow/);
    // a real creator close: ballots stored after it are rejected
    const real = stored(await closeBy(creator, withClose));
    const after = stored(await vote(creator, withClose, 1));
    const tc = await tallyPoll(withClose, [...cands, real, after], resolve);
    expect(tc.closedBy).toBe('creator');
    expect(tc.ballots.find((b) => b.id === after.id)!.reason).toBe('poll_closed');
  });

  it('refuses ballots for a re-issued poll (pollHash) and encrypted ballots', async () => {
    const { keys, resolve } = await setup(2);
    const [creator, a] = keys;
    const p1 = stored(await mk(creator, 'poll', { kind: 'open', title: 'v1', options: ['a', 'b'], ledger: { hub: HUB }, electorate: { type: 'open' }, closes: { at: Date.now() + 60_000 }, rule: { method: 'plurality' } }));
    const p2 = stored(await mk(creator, 'poll', { kind: 'open', title: 'v2', options: ['a', 'b'], ledger: { hub: HUB }, electorate: { type: 'open' }, closes: { at: Date.now() + 60_000 }, rule: { method: 'plurality' } }, 1));
    const moved = stored(await mk(a, 'vote', { pollId: p2.id, pollHash: p1.checksum, choice: 0 }, 1));
    const t = await tallyPoll(p2, [moved], resolve);
    expect(t.ballots[0].reason).toBe('poll_hash_mismatch');
    const enc: any = { ...(await mk(a, 'vote', { pollId: p2.id, pollHash: p2.checksum, choice: 0 }, 2)), encrypted: true };
    expect(checkVoteIngest(enc, p2, t, { hub: HUB, now: Date.now() })).toBe('encrypted_unsupported');
  });
});
