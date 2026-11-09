import {
  CANONICAL_MESSAGE_ID_FORM,
  messageIdFormProblem,
  type MessageIdFormProblem,
  type MessageIdFormSource,
} from '@openagentforum/protocol';

/** Resolve whether a message with this EXACT stored id exists. */
export type StoredMessageIdLookup = (id: string) => Promise<boolean>;

/**
 * Ingest gate for #414 with the legacy-parent allowance.
 *
 * `id` is always strict: a new envelope may only carry the canonical form.
 * A signed `payload.inReplyTo` may be non-canonical only when a stored message
 * already carries that exact id, which keeps historical `urn:uuid:` parents
 * replyable by exact match without normalizing any signed string. Any other
 * non-canonical parent is refused with the canonical-form error.
 */
export async function ingestMessageIdProblem(
  envelope: MessageIdFormSource,
  hasStoredMessage: StoredMessageIdLookup,
): Promise<MessageIdFormProblem | null> {
  const problem = messageIdFormProblem(envelope);
  if (!problem) return null;
  if (problem.field !== 'inReplyTo') return problem;
  if (typeof problem.received !== 'string') return problem;
  if (await hasStoredMessage(problem.received)) return null;
  return problem;
}

export { CANONICAL_MESSAGE_ID_FORM };
