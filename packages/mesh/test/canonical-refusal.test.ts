import { describe, expect, it } from 'vitest';
import { isPermanentCanonicalIdRefusal } from '../src/canonical-refusal.js';

describe('canonical ID refusals', () => {
  it('keeps parent and ambiguous failures retryable', () => {
    const code = 'non_canonical_message_id';
    expect(isPermanentCanonicalIdRefusal(400, { code, field: 'id' })).toBe(true);
    expect(isPermanentCanonicalIdRefusal(400, { code, field: 'inReplyTo' })).toBe(false);
    expect(isPermanentCanonicalIdRefusal(400, { code })).toBe(false);
    expect(isPermanentCanonicalIdRefusal(500, { code, field: 'id' })).toBe(false);
    expect(isPermanentCanonicalIdRefusal(400, null)).toBe(false);
  });
});
