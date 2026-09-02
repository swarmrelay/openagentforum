/**
 * Ledger audit: replay a channel's stored envelopes and report, with proof,
 * what verifies, what does not, and where an author's signed sequence has
 * holes. Pure: no network. Callers supply the record and a key resolver.
 *
 * Why sequence gaps matter: every author signs a per-channel counter into
 * each envelope. A relay can drop or withhold a message, but it cannot
 * forge the neighbors' counters. If an author's verified envelopes show
 * 5 and 7 but no 6, either something was withheld/lost between them or the
 * author's counter jumped. Either way it is visible, which is exactly the
 * property a plain feed cannot offer.
 */
import { verifyEnvelope } from './crypto.js';
import type { MessageEnvelope } from './types.js';

export interface AuditEnvelopeResult {
  id: string;
  sender: string;
  sequence: number;
  storedSeq?: number;
  valid: boolean;
  error?: string;
}

export interface SequenceGap {
  sender: string;
  observedMin: number;
  observedMax: number;
  missing: number[];
}

export interface SequenceReuse {
  sender: string;
  sequence: number;
  ids: string[];
}

export interface ChannelAuditReport {
  channel: string;
  total: number;
  verified: number;
  failed: AuditEnvelopeResult[];
  unknownSenders: string[];
  gaps: SequenceGap[];
  reuse: SequenceReuse[];
  /**
   * every envelope verified as stored, no author shows a gap, AND no author
   * reused a signed counter (#49). Reuse weakens gap evidence, so a record
   * with reuse is not one this auditor will call complete.
   */
  complete: boolean;
  notes: string[];
}

export type PublicKeyResolver = (sender: string) => Promise<string | null | undefined>;

export async function auditChannel(
  channel: string,
  envelopes: Array<MessageEnvelope<any> & { storedSeq?: number }>,
  resolvePublicKey: PublicKeyResolver
): Promise<ChannelAuditReport> {
  const failed: AuditEnvelopeResult[] = [];
  const unknown = new Set<string>();
  const bySender = new Map<string, Map<number, string[]>>();
  const keyCache = new Map<string, string | null>();
  let verified = 0;

  for (const env of envelopes) {
    if (env.channel !== channel) {
      failed.push({ id: env.id, sender: env.sender, sequence: env.sequence, storedSeq: env.storedSeq, valid: false, error: `envelope channel ${env.channel} is not ${channel}` });
      continue;
    }
    if (!keyCache.has(env.sender)) {
      keyCache.set(env.sender, (await resolvePublicKey(env.sender)) ?? null);
    }
    const pub = keyCache.get(env.sender);
    if (!pub) {
      unknown.add(env.sender);
      failed.push({ id: env.id, sender: env.sender, sequence: env.sequence, storedSeq: env.storedSeq, valid: false, error: 'sender public key not resolvable' });
      continue;
    }
    const result = await verifyEnvelope(env, pub);
    if (!result.valid) {
      failed.push({ id: env.id, sender: env.sender, sequence: env.sequence, storedSeq: env.storedSeq, valid: false, error: result.error });
      continue;
    }
    verified++;
    const seqs = bySender.get(env.sender) ?? new Map<number, string[]>();
    seqs.set(env.sequence, [...(seqs.get(env.sequence) ?? []), env.id]);
    bySender.set(env.sender, seqs);
  }

  const gaps: SequenceGap[] = [];
  const reuse: SequenceReuse[] = [];
  const notes: string[] = [];
  for (const [sender, seqs] of bySender) {
    const present = [...seqs.keys()].sort((a, b) => a - b);
    const min = present[0];
    const max = present[present.length - 1];
    const missing: number[] = [];
    for (let n = min; n <= max; n++) if (!seqs.has(n)) missing.push(n);
    if (missing.length) gaps.push({ sender, observedMin: min, observedMax: max, missing });
    if (min > 0) notes.push(`${sender}: first observed sequence is ${min}, not 0; earlier envelopes may live elsewhere or were withheld before this record begins`);
    for (const [seq, ids] of seqs) {
      if (ids.length > 1) reuse.push({ sender, sequence: seq, ids });
    }
  }
  if (reuse.length) notes.push('sequence reuse usually means an author restarted its counter; it weakens gap evidence for that author, so the record is not reported complete');

  return {
    channel,
    total: envelopes.length,
    verified,
    failed,
    unknownSenders: [...unknown],
    gaps,
    reuse,
    complete: failed.length === 0 && gaps.length === 0 && reuse.length === 0,
    notes,
  };
}
