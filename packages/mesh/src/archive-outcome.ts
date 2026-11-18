/**
 * Classify a hub archive response for the mesh and Nostr bridges (#240).
 *
 * Both bridges re-post the exact signed bytes they carried: the envelope is
 * never rewritten, so a refusal that is a function of those bytes alone can
 * never succeed on retry. Only the 409 id-conflict case was treated that way
 * (#35); every other failure retried forever, growing the durable pending
 * queue toward its cap and eventually refusing all new envelopes (#36).
 *
 * Dropping is irreversible, so the status alone is not enough evidence:
 * both bridges post through Cloudflare, and an edge/WAF refusal (a 403
 * with an HTML body the hub never saw) looks exactly like a hub refusal
 * from the status. A failure is permanent only when the response is the
 * JSON error body carries a recognized signal that is final for these exact
 * bytes. This does not authenticate the origin of a response; an intermediary
 * that imitates the hub's exact errors could still cause a drop:
 *   A 409 is an id conflict only when the body names that conflict. Poll
 *     refusals and unknown or intermediary responses remain retryable.
 *   Non-JSON, empty and non-object bodies retry: an edge response, a
 *     truncated body, or a body we cannot parse is never a drop.
 *   A `reason` of `encryption_required` retries: channel encryption
 *     policy is state, and a channel can stop requiring encryption.
 *     Reasons `invalid_encryption_metadata` / `invalid_envelope_metadata`
 *     are permanent: malformed metadata is a property of the bytes.
 *     An unknown reason retries: never drop on evidence we do not
 *     understand.
 *   400 is permanent only for recognized malformed-envelope and sequence
 *     errors. `invalid_public_input` can also mean an aborted input stream,
 *     so it and all unknown error bodies remain retryable.
 *   403 is permanent only for known exact checksum/signature strings,
 *     including those wrapped by the Worker or standalone adapter.
 *     Arbitrary verification exceptions and other refusals retry.
 *   Everything else retries, including 413 and 415: the published byte
 *     bounds and the request framing are state that can change, and a
 *     401 stays retryable because both bridges re-register the sender
 *     before every archive attempt.
 *
 * Note on the reviewed error contract: no error path on the message POST
 * emits `success: false` — success appears only on 2xx responses, and
 * errors are `{ error }`, `{ error, code }` (shared input policy) or
 * `{ error, reason }` (encryption policy). The gate therefore keys on
 * the parsed body shape plus the byte-final signals above, which is
 * what distinguishes recognized errors from unrelated responses, subject to
 * the intermediary limitation above.
 */
export type ArchiveFailureOutcome = 'conflict' | 'permanent' | 'retry';

const ID_CONFLICT = 'Envelope id is already bound to a different envelope';
const ID_KEY_CONFLICT = 'Envelope id names an existing message in another form';
const INVALID_ENVELOPES = new Set([
  'Malformed MessageEnvelope. Required fields: id, sender, type, payload, signature, checksum',
  'Malformed MessageEnvelope. Required: id, sender, type, payload, signature, checksum',
  'sequence and timestamp must be numbers and are part of the sign string',
]);
/** Channel policy state: a channel can stop requiring encryption. */
const POLICY_REASONS = new Set(['encryption_required']);
/** Malformed metadata is a property of the bytes and can never heal. */
const BYTE_FINAL_REASONS = new Set(['invalid_encryption_metadata', 'invalid_envelope_metadata']);
/** Pages adapter verification failures (exact fixed strings). */
const VERIFICATION_ERRORS = new Set([
  'Payload checksum mismatch (payload does not match signed checksum)',
  'Invalid Ed25519 signature',
]);
/** Worker / standalone verifyEnvelope wraps, limited to fixed failures. */
const VERIFICATION_SUFFIXES = ['Payload checksum mismatch (data was modified in transit)', 'Invalid Ed25519 signature'];
const VERIFICATION_PREFIXES = ['Cryptographic validation failed: ', 'Validation failed: '];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function classifyArchiveFailure(status: number, body?: unknown): ArchiveFailureOutcome {
  if (!isRecord(body)) return 'retry';
  const error = typeof body.error === 'string' ? body.error : undefined;
  const code = typeof body.code === 'string' ? body.code : undefined;
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  if (status === 409) {
    if (error === ID_CONFLICT && reason === undefined && code === undefined) return 'conflict';
    if (error === ID_KEY_CONFLICT && reason === 'id_key_conflict' && code === undefined) return 'conflict';
    return 'retry';
  }
  if (status !== 400 && status !== 403) return 'retry';
  if (reason !== undefined) {
    if (POLICY_REASONS.has(reason)) return 'retry';
    if (status === 400 && code === undefined && BYTE_FINAL_REASONS.has(reason)
        && error === 'Encrypted envelopes require ciphertext and valid encryption metadata') return 'permanent';
    return 'retry';
  }
  if (error === undefined) return 'retry';
  if (status === 400) {
    if (code !== undefined) return 'retry';
    return INVALID_ENVELOPES.has(error) ? 'permanent' : 'retry';
  }
  if (status === 403) {
    if (code !== undefined) return 'retry';
    if (VERIFICATION_ERRORS.has(error)) return 'permanent';
    if (VERIFICATION_PREFIXES.some((prefix) => VERIFICATION_SUFFIXES.some((suffix) => error === prefix + suffix))) return 'permanent';
    return 'retry';
  }
  return 'retry';
}
