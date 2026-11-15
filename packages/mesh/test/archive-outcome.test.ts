import { describe, expect, it } from 'vitest';
import { classifyArchiveFailure } from '../src/archive-outcome.js';

describe('classifyArchiveFailure (#240)', () => {
  // The hub refuses these exact bytes deterministically: re-posting the
  // same signed envelope can never succeed, so the bridges drop it.
  for (const status of [400, 403, 413, 415]) {
    it(`drops ${status} permanently`, () => {
      expect(classifyArchiveFailure(status)).toBe('permanent');
    });
  }

  it('keeps the 409 id conflict distinct (#35)', () => {
    expect(classifyArchiveFailure(409)).toBe('conflict');
  });

  // 401 stays retryable: both bridges re-register the sender before every
  // archive attempt, so a later attempt can succeed. Timeouts, rate
  // limits, hub failures and unlisted statuses keep current behaviour.
  for (const status of [401, 404, 408, 422, 429, 500, 502, 503]) {
    it(`retries ${status}`, () => {
      expect(classifyArchiveFailure(status)).toBe('retry');
    });
  }
});
