/**
 * Canonical message-id form (#414).
 *
 * A message id is part of the signed envelope, so its literal form is signed
 * too. The protocol stores exactly what the author signed and reply lookup is
 * exact-match, which only works when every writer uses one form. That form is a
 * bare lowercase hyphenated UUID: no `urn:uuid:` prefix and no uppercase hex.
 *
 * This is a form rule, not a version rule: legacy UUIDv1 ids are still UUIDs,
 * and the point here is that a reader must not rewrite the signed string.
 */
export const CANONICAL_MESSAGE_ID_FORM = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';

const CANONICAL_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Any form the protocol has seen in the wild, including non-canonical ones. */
const UUID_IN_ANY_FORM = /^(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MessageIdField = 'id' | 'inReplyTo';

export interface MessageIdFormProblem {
  field: MessageIdField;
  received: unknown;
  expected: typeof CANONICAL_MESSAGE_ID_FORM;
  code: 'non_canonical_message_id';
  error: string;
}

/** The signed fields the gate reads; structurally satisfied by MessageEnvelope. */
export interface MessageIdFormSource {
  id: string;
  type: string;
  payload: unknown;
  encrypted?: boolean;
}

export function isCanonicalMessageId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_MESSAGE_ID.test(value);
}

/**
 * The write-time error for one id field, or null when the value is canonical.
 * The message names the expected form and, for prefix/case variants, says how
 * the received value differs from it.
 */
export function messageIdFormError(field: MessageIdField, value: unknown): string | null {
  if (isCanonicalMessageId(value)) return null;
  const received = typeof value === 'string' ? JSON.stringify(value) : `a value of type ${value === null ? 'null' : typeof value}`;
  const variant = typeof value === 'string' && UUID_IN_ANY_FORM.test(value)
    ? ' The received value is a UUID in a non-canonical form: remove the urn:uuid: prefix and use lowercase hex.'
    : '';
  return `Invalid ${field} ${received}: expected the canonical message-id form ${CANONICAL_MESSAGE_ID_FORM} `
    + `(a bare lowercase hyphenated UUID, with no urn:uuid: prefix and no uppercase hex).${variant}`;
}

/**
 * Ingest gate for #414. Only the SIGNED `payload.inReplyTo` is checked: the
 * unsigned top-level `replyToId` is never used for reply lookup, so rejecting
 * it here would add a rule without closing the mismatch. Encrypted payloads
 * cannot be inspected and are governed by their own contract.
 *
 * Returns null when the envelope may be stored. The caller must reject before
 * any write when a problem is returned; nothing is normalized.
 */
export function messageIdFormProblem(envelope: MessageIdFormSource): MessageIdFormProblem | null {
  const idError = messageIdFormError('id', envelope.id);
  if (idError) {
    return {
      field: 'id', received: envelope.id, expected: CANONICAL_MESSAGE_ID_FORM,
      code: 'non_canonical_message_id', error: idError,
    };
  }

  if (envelope.encrypted || envelope.type === 'e2ee_blob') return null;
  const payload: unknown = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Object.hasOwn(payload, 'inReplyTo')) return null;

  const parent = (payload as Record<string, unknown>).inReplyTo;
  const parentError = messageIdFormError('inReplyTo', parent);
  if (parentError) {
    return {
      field: 'inReplyTo', received: parent, expected: CANONICAL_MESSAGE_ID_FORM,
      code: 'non_canonical_message_id', error: parentError,
    };
  }
  return null;
}
