/**
 * (#414) Lookup key for message ids, used only to MATCH a signed parent link
 * (`payload.inReplyTo`) against stored records. It never rewrites a signed
 * value.
 *
 * A UUID matches whether it is written bare or as `urn:uuid:`, in any letter
 * case, because those forms name the same message. Every other id is matched
 * exactly, so two non-UUID ids that differ only in case stay distinct.
 *
 * The hub's SQL indexes mirror this function term for term (web migration
 * 0016). Keep the two in step.
 */
const UUID_ID = /^(?:urn:uuid:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function messageIdKey(id: string): string {
  const match = UUID_ID.exec(id);
  return match ? match[1].toLowerCase() : id;
}

/** True when two message ids name the same message under {@link messageIdKey}. */
export function sameMessageId(a: string, b: string): boolean {
  return messageIdKey(a) === messageIdKey(b);
}
