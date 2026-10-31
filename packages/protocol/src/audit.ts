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
  /**
   * The first `MAX_MISSING_REPORTED` missing counters. Bounded on purpose: the
   * span between an author's lowest and highest counter is attacker-chosen, so
   * enumerating it without a cap is how a single envelope turns an audit into a
   * multi-gigabyte allocation. Use `missingCount` when the size matters.
   */
  missing: number[];
  /** Exact number of counters absent between `observedMin` and `observedMax`. */
  missingCount: number;
  /** True when `missing` was cut short and `missingCount` is larger than it. */
  missingTruncated?: boolean;
}

/**
 * How many missing counters an audit will list per author before it stops
 * enumerating and reports only the count. An author's `sequence` is signed by the
 * author, so the span is not bounded by anything the auditor controls: without a
 * cap, an envelope claiming `sequence: 4000000000` makes the gap loop push until
 * V8 throws `RangeError: Invalid array length`. That is a remote crash of
 * `swarmrelay verify <channel>` on any channel the author can post to.
 */
export const MAX_MISSING_REPORTED = 1000;

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
    // A counter is a non-negative integer. Anything else cannot define a span, so
    // it is excluded from the gap arithmetic and named in a note instead of being
    // allowed to poison min/max.
    const numeric = [...seqs.keys()].filter((n) => Number.isSafeInteger(n) && n >= 0).sort((a, b) => a - b);
    const nonNumeric = [...seqs.keys()].filter((n) => !(Number.isSafeInteger(n) && n >= 0));
    if (nonNumeric.length) {
      notes.push(`${sender}: ${nonNumeric.length} verified envelope(s) carry a sequence that is not a non-negative safe integer (${nonNumeric.slice(0, 3).join(', ')}); they are excluded from gap arithmetic`);
    }
    if (!numeric.length) continue;
    const min = numeric[0];
    const max = numeric[numeric.length - 1];
    const span = max - min + 1;
    const presentInRange = numeric.length;
    const missingCount = span - presentInRange;
    if (missingCount > 0) {
      const missing: number[] = [];
      for (let n = min; n <= max && missing.length < MAX_MISSING_REPORTED; n++) {
        if (!seqs.has(n)) missing.push(n);
      }
      gaps.push({
        sender,
        observedMin: min,
        observedMax: max,
        missing,
        missingCount,
        ...(missingCount > missing.length ? { missingTruncated: true } : {}),
      });
    }
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
