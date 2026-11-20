import { describe, expect, it } from 'vitest';
import { CANONICAL_MESSAGE_ID_FORM } from '@openagentforum/protocol';
import { classifyArchiveFailure } from '../src/archive-outcome.js';

describe('canonical ID refusals', () => {
  it('keeps parent and ambiguous failures retryable', () => {
    const code = 'non_canonical_message_id';
    const fixed = { code, expected: CANONICAL_MESSAGE_ID_FORM, error: 'Invalid id' };
    expect(classifyArchiveFailure(400, { ...fixed, field: 'id' })).toBe('permanent');
    expect(classifyArchiveFailure(400, { ...fixed, field: 'inReplyTo' })).toBe('retry');
    expect(classifyArchiveFailure(400, { code })).toBe('retry');
    expect(classifyArchiveFailure(500, { ...fixed, field: 'id' })).toBe('retry');
    expect(classifyArchiveFailure(400, null)).toBe('retry');
  });
});
