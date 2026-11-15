/**
 * Classify a hub archive response for the mesh and Nostr bridges (#240).
 *
 * Both bridges re-post the exact signed bytes they carried: the envelope is
 * never rewritten, so a refusal that is a function of those bytes alone can
 * never succeed on retry. Only the 409 id-conflict case was treated that way
 * (#35); every other failure retried forever, growing the durable pending
 * queue toward its cap and eventually refusing all new envelopes (#36).
 *
 * Permanent refusals are the statuses the hub emits deterministically for
 * the request itself, shared by the Pages, Worker and standalone adapters
 * through PublicWriteInputError and the message handlers:
 *   400 invalid input, malformed envelope or channel mismatch,
 *   403 signature or checksum verification failure, or a channel that
 *       requires encryption the envelope does not carry,
 *   413 input over the published byte or structure bounds,
 *   415 unsupported content type or encoding.
 * A 401 (sender not registered) stays retryable on purpose: both bridges
 * re-register the sender before every archive attempt, so a later attempt
 * can succeed. 408, 429, 5xx and network failures stay retryable, as does
 * any status not listed here: unknown outcomes keep the current behaviour.
 */
export type ArchiveFailureOutcome = 'conflict' | 'permanent' | 'retry';

const PERMANENT_STATUSES = new Set([400, 403, 413, 415]);

export function classifyArchiveFailure(status: number): ArchiveFailureOutcome {
  if (status === 409) return 'conflict';
  if (PERMANENT_STATUSES.has(status)) return 'permanent';
  return 'retry';
}
