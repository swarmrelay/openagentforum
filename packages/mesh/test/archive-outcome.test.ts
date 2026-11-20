import { describe, expect, it } from 'vitest';
import { classifyArchiveFailure } from '../src/archive-outcome.js';

describe('classifyArchiveFailure (#240)', () => {
  it('drops only identified 409 id conflicts (#35)', () => {
    expect(classifyArchiveFailure(409)).toBe('retry');
    expect(classifyArchiveFailure(409, { error: 'Envelope id is already bound to a different envelope' })).toBe('conflict');
    expect(classifyArchiveFailure(409, { error: 'Envelope id names an existing message in another form', reason: 'id_key_conflict' })).toBe('conflict');
    expect(classifyArchiveFailure(409, '<html>edge</html>')).toBe('retry');
    expect(classifyArchiveFailure(409, { error: 'Ballot refused: poll_not_found', reason: 'poll_not_found' })).toBe('retry');
  });

  // 400: every hub error on this route is a function of the bytes —
  // invalid input, malformed envelope, sequence/timestamp types,
  // channel mismatch, malformed encryption metadata.
  it.each([
    ['malformed envelope (Worker wording)', { error: 'Malformed MessageEnvelope. Required fields: id, sender, type, payload, signature, checksum' }],
    ['malformed envelope (Pages wording)', { error: 'Malformed MessageEnvelope. Required: id, sender, type, payload, signature, checksum' }],
    ['sequence/timestamp types', { error: 'sequence and timestamp must be numbers and are part of the sign string' }],
    ['invalid encryption metadata', { error: 'Encrypted envelopes require ciphertext and valid encryption metadata', reason: 'invalid_encryption_metadata' }],
    ['invalid envelope metadata', { error: 'Encrypted envelopes require ciphertext and valid encryption metadata', reason: 'invalid_envelope_metadata' }],
  ])('drops a 400 permanently: %s', (_name, body) => {
    expect(classifyArchiveFailure(400, body)).toBe('permanent');
  });

  // 403: only the verification signals are permanent — the Pages exact
  // strings and the Worker / standalone verifyEnvelope wraps.
  it.each([
    ['Pages checksum mismatch', { error: 'Payload checksum mismatch (payload does not match signed checksum)' }],
    ['Pages invalid signature', { error: 'Invalid Ed25519 signature' }],
    ['Worker verification wrap', { error: 'Cryptographic validation failed: Payload checksum mismatch (data was modified in transit)' }],
    ['standalone verification wrap', { error: 'Validation failed: Payload checksum mismatch (data was modified in transit)' }],
  ])('drops a 403 permanently: %s', (_name, body) => {
    expect(classifyArchiveFailure(403, body)).toBe('permanent');
  });

  // The blocking review cases: an edge/WAF 403 (HTML body), an empty
  // body, and a hub JSON policy 403 must all retry — dropping on any
  // of them would silently lose valid signed envelopes.
  it('retries a 403 with an HTML body (edge/WAF refusal)', () => {
    expect(classifyArchiveFailure(403, '<html><body>Error 1010</body></html>')).toBe('retry');
  });
  it('retries a 403 with an empty body', () => {
    expect(classifyArchiveFailure(403, undefined)).toBe('retry');
    expect(classifyArchiveFailure(403, '')).toBe('retry');
  });
  it('retries a hub JSON policy 403', () => {
    expect(classifyArchiveFailure(403, { error: 'Channel now requires encryption', reason: 'encryption_required' })).toBe('retry');
    expect(classifyArchiveFailure(403, { error: 'Encrypted envelopes require ciphertext and valid encryption metadata', reason: 'encryption_required' })).toBe('retry');
  });

  // Unknown or state-dependent evidence never drops.
  it.each([
    ['403 with an empty JSON object', 403, {}],
    ['403 with an unknown error string', 403, { error: 'Forbidden' }],
    ['403 with an unknown code', 403, { error: 'Forbidden', code: 'something_else' }],
    ['403 with an unknown reason', 403, { error: 'Forbidden', reason: 'something_else' }],
    ['403 with a JSON array body', 403, []],
    ['400 with an unknown code', 400, { error: 'Bad input', code: 'unknown_code' }],
    ['400 with an unknown reason', 400, { error: 'Bad input', reason: 'unknown_reason' }],
    ['400 with no parsed body', 400, undefined],
    ['400 with a non-object body', 400, 'bad request'],
    ['400 input policy can include an aborted stream', 400, { error: 'invalid_public_input', code: 'invalid_public_input' }],
    ['400 unknown JSON edge response', 400, { error: 'Bad Request' }],
    ['500 cannot become permanent because of its reason', 500, { error: 'error', reason: 'invalid_encryption_metadata' }],
    ['400 unknown error with a known reason', 400, { error: 'upstream error', reason: 'invalid_encryption_metadata' }],
    ['403 verification exception is not a known invalid signature', 403, { error: 'Cryptographic validation failed: transient crypto failure' }],
    ['413 bounds refusal (bounds can change)', 413, { error: 'public_input_too_large', code: 'public_input_too_large' }],
    ['415 framing refusal (request framing, not bytes)', 415, { error: 'unsupported_public_input', code: 'unsupported_public_input' }],
    ['408 input timeout', 408, { error: 'public_input_timeout', code: 'public_input_timeout' }],
  ])('retries: %s', (_name, status, body) => {
    expect(classifyArchiveFailure(status, body)).toBe('retry');
  });

  // 401 stays retryable: both bridges re-register the sender before every
  // archive attempt, so a later attempt can succeed. Timeouts, rate
  // limits, hub failures and unlisted statuses keep current behaviour.
  for (const status of [401, 404, 422, 429, 500, 502, 503]) {
    it(`retries ${status}`, () => {
      expect(classifyArchiveFailure(status)).toBe('retry');
      expect(classifyArchiveFailure(status, { error: 'hub error' })).toBe('retry');
    });
  }
});
