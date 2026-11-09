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
import { canonicalizeJson, deriveAgentId, getEnvelopeSignString, importEdPublicKey, sha256Hex, verifyEnvelope } from './crypto.js';
import type { MessageEnvelope } from './types.js';

export interface AuditEnvelopeResult {
  id: string;
  sender: string;
  sequence: number;
  storedSeq?: number;
  valid: boolean;
  error?: string;
}

/**
 * Checksum encodings some early clients used before the canonical form was
 * pinned (#153, 2026-09-12). A closed set: anything else is a failure.
 * - `ascii-escaped`: sorted keys, but non-ASCII escaped as lowercase \uXXXX
 *   (Python's default `ensure_ascii`).
 * - `unsorted-keys`: compact JSON in the stored key order instead of sorted.
 */
export type LegacyChecksumEncoding = 'ascii-escaped' | 'unsorted-keys';

export interface LegacyEncodedEnvelope extends AuditEnvelopeResult {
  encoding: LegacyChecksumEncoding;
}

const LEGACY_ENCODINGS: Array<[LegacyChecksumEncoding, (payload: unknown) => string]> = [
  ['ascii-escaped', (payload) => canonicalizeJson(payload).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))],
  ['unsorted-keys', (payload) => JSON.stringify(payload)],
];

/**
 * The legacy encoding under which this envelope is authentic, or null. Every
 * condition must hold: the key derives to the sender, the Ed25519 signature
 * verifies over the stored fields (which include the checksum), and the payload
 * hashes to that signed checksum under one of the closed set of encodings. So
 * the payload shown is the value the author hashed and signed; only the byte
 * encoding differs from the pinned canonical form.
 */
export async function legacyChecksumEncoding(env: MessageEnvelope<any>, signingPublicKeyHex: string): Promise<LegacyChecksumEncoding | null> {
  try {
    if (typeof env.checksum !== 'string' || !/^[0-9a-f]{64}$/i.test(env.checksum)) return null;
    if (typeof env.signature !== 'string' || !/^[0-9a-f]{128}$/i.test(env.signature)) return null;
    if (env.sender.toLowerCase() !== (await deriveAgentId(signingPublicKeyHex)).toLowerCase()) return null;
    const signature = Uint8Array.from(env.signature.match(/../g)!.map((b) => parseInt(b, 16)));
    const signed = await crypto.subtle.verify('Ed25519', await importEdPublicKey(signingPublicKeyHex), signature,
      new TextEncoder().encode(getEnvelopeSignString(env)));
    if (!signed) return null;
    for (const [name, encode] of LEGACY_ENCODINGS) {
      if ((await sha256Hex(encode(env.payload))) === env.checksum.toLowerCase()) return name;
    }
  } catch { /* unparseable input is a failure, not a legacy encoding */ }
  return null;
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
  /**
   * Authentic envelopes whose checksum uses a documented pre-#153 encoding.
   * Counted neither as verified (they do not verify under the pinned canonical
   * form) nor as failed, and included in sequence accounting because their
   * signatures cover their counters.
   */
  legacyEncoded: LegacyEncodedEnvelope[];
  unknownSenders: string[];
  gaps: SequenceGap[];
  reuse: SequenceReuse[];
  /**
   * no envelope failed (every one verified as stored, or is authentic under a
   * listed legacy encoding), no author shows a gap, AND no author reused a
   * signed counter (#49). Reuse weakens gap evidence, so a record with reuse is
   * not one this auditor will call complete.
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
  const legacyEncoded: LegacyEncodedEnvelope[] = [];
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
      const encoding = await legacyChecksumEncoding(env, pub);
      if (!encoding) {
        failed.push({ id: env.id, sender: env.sender, sequence: env.sequence, storedSeq: env.storedSeq, valid: false, error: result.error });
        continue;
      }
      legacyEncoded.push({ id: env.id, sender: env.sender, sequence: env.sequence, storedSeq: env.storedSeq, valid: false, encoding,
        error: `checksum uses the legacy ${encoding} encoding; signature and payload are authentic` });
    } else verified++;
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
  if (legacyEncoded.length) notes.push(`${legacyEncoded.length} envelope(s) are authentic but checksummed with a pre-#153 encoding (${[...new Set(legacyEncoded.map((e) => e.encoding))].join(', ')}); they are listed separately, not counted as verified as stored`);
  if (reuse.length) notes.push('sequence reuse usually means an author restarted its counter; it weakens gap evidence for that author, so the record is not reported complete');

  return {
    channel,
    total: envelopes.length,
    verified,
    failed,
    legacyEncoded,
    unknownSenders: [...unknown],
    gaps,
    reuse,
    complete: failed.length === 0 && gaps.length === 0 && reuse.length === 0,
    notes,
  };
}
