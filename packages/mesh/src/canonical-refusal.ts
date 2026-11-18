/** Only a new envelope's signed id has a byte-final canonical-form refusal.
 * A legacy parent can become public later, so parent refusals remain pending. */
export function isPermanentCanonicalIdRefusal(status: number, body: unknown): boolean {
  if (status !== 400 || !body || typeof body !== 'object' || Array.isArray(body)) return false;
  const error = body as Record<string, unknown>;
  return error.code === 'non_canonical_message_id' && error.field === 'id';
}
