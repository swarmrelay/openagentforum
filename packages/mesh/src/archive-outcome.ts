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
 * hub's own JSON error body AND carries a signal that is final for these
 * exact bytes:
 *   409 stays the id conflict (#35), whatever the body.
 *   Non-JSON, empty and non-object bodies retry: an edge response, a
 *     truncated body, or a body we cannot parse is never a drop.
 *   A `reason` of `encryption_required` retries: channel encryption
 *     policy is state, and a channel can stop requiring encryption.
 *     Reasons `invalid_encryption_metadata` / `invalid_envelope_metadata`
 *     are permanent: malformed metadata is a property of the bytes.
 *     An unknown reason retries: never drop on evidence we do not
 *     understand.
 *   400 is permanent when the hub JSON error carries no unknown `code`:
 *     `invalid_public_input`, the malformed-envelope strings, the
 *     sequence/timestamp type error and the channel-mismatch error are
 *     all functions of the bytes. (The input-policy catch-all also
 *     covers rare non-byte causes such as a stream read error; the
 *     maintainer accepted that edge in review.)
 *   403 is permanent only for the verification signals: the Pages
 *     adapter's exact checksum/signature strings, and the Worker /
 *     standalone `Cryptographic validation failed: ` /
 *     `Validation failed: ` prefixes wrapping verifyEnvelope. Every
 *     other 403 retries, including policy refusals.
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
 * what distinguishes a hub refusal from an edge response.
 */
export type ArchiveFailureOutcome = 'conflict' | 'permanent' | 'retry';

/** The only input-policy code that is final for the exact bytes. */
const BYTE_FINAL_CODES = new Set(['invalid_public_input']);
/** Channel policy state: a channel can stop requiring encryption. */
const POLICY_REASONS = new Set(['encryption_required']);
/** Malformed metadata is a property of the bytes and can never heal. */
const BYTE_FINAL_REASONS = new Set(['invalid_encryption_metadata', 'invalid_envelope_metadata']);
/** Pages adapter verification failures (exact fixed strings). */
const VERIFICATION_ERRORS = new Set([
  'Payload checksum mismatch (payload does not match signed checksum)',
  'Invalid Ed25519 signature',
]);
/** Worker / standalone verifyEnvelope wraps (fixed prefixes). */
const VERIFICATION_PREFIXES = ['Cryptographic validation failed: ', 'Validation failed: '];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function classifyArchiveFailure(status: number, body?: unknown): ArchiveFailureOutcome {
  if (status === 409) return 'conflict';
  if (!isRecord(body)) return 'retry';
  const error = typeof body.error === 'string' ? body.error : undefined;
  const code = typeof body.code === 'string' ? body.code : undefined;
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  if (reason !== undefined) {
    if (POLICY_REASONS.has(reason)) return 'retry';
    if (BYTE_FINAL_REASONS.has(reason)) return 'permanent';
    return 'retry';
  }
  if (error === undefined) return 'retry';
  if (status === 400) {
    if (code !== undefined && !BYTE_FINAL_CODES.has(code)) return 'retry';
    return 'permanent';
  }
  if (status === 403) {
    if (code !== undefined) return 'retry';
    if (VERIFICATION_ERRORS.has(error)) return 'permanent';
    if (VERIFICATION_PREFIXES.some((prefix) => error.startsWith(prefix))) return 'permanent';
    return 'retry';
  }
  return 'retry';
}
