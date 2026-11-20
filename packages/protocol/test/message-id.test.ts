import { describe, expect, it } from 'vitest';
import {
  CANONICAL_MESSAGE_ID_FORM,
  isCanonicalMessageId,
  messageIdFormError,
  messageIdFormProblem,
  type MessageIdFormSource,
} from '../src/message-id.js';

const CANONICAL = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const UPPERCASE = 'F47AC10B-58CC-4372-A567-0E02B2C3D479';

function source(overrides: Partial<MessageIdFormSource> = {}): MessageIdFormSource {
  return { id: CANONICAL, type: 'intel', payload: { message: 'hello' }, ...overrides };
}

describe('canonical message-id form (#414)', () => {
  it('accepts a bare lowercase hyphenated UUID', () => {
    expect(isCanonicalMessageId(CANONICAL)).toBe(true);
    expect(messageIdFormError('id', CANONICAL)).toBeNull();
    expect(messageIdFormProblem(source())).toBeNull();
  });

  it('rejects prefixed, uppercase and non-string ids', () => {
    for (const id of [`urn:uuid:${CANONICAL}`, UPPERCASE, '', 42, null]) {
      expect(isCanonicalMessageId(id)).toBe(false);
      const problem = messageIdFormProblem(source({ id: id as string }));
      expect(problem).toMatchObject({ field: 'id', code: 'non_canonical_message_id', expected: CANONICAL_MESSAGE_ID_FORM });
      expect(problem?.error).toContain(CANONICAL_MESSAGE_ID_FORM);
    }
  });

  it('names the prefix and case variants in the error', () => {
    expect(messageIdFormError('inReplyTo', `urn:uuid:${CANONICAL}`)).toContain('remove the urn:uuid: prefix');
    expect(messageIdFormError('inReplyTo', UPPERCASE)).toContain('lowercase hex');
    expect(messageIdFormError('inReplyTo', 42)).toContain('a value of type number');
  });

  it('rejects a non-canonical signed inReplyTo', () => {
    for (const parent of [`urn:uuid:${CANONICAL}`, UPPERCASE, null, 42]) {
      const problem = messageIdFormProblem(source({ payload: { message: 'reply', inReplyTo: parent } }));
      expect(problem).toMatchObject({ field: 'inReplyTo', code: 'non_canonical_message_id' });
      expect(problem?.error).toContain(CANONICAL_MESSAGE_ID_FORM);
    }
  });

  it('accepts a canonical signed inReplyTo and ignores the unsigned replyToId', () => {
    expect(messageIdFormProblem(source({ payload: { message: 'reply', inReplyTo: CANONICAL } }))).toBeNull();
    const withUnsignedLegacy: MessageIdFormSource & { replyToId: string } = {
      ...source({ payload: { message: 'reply', inReplyTo: CANONICAL } }),
      replyToId: `urn:uuid:${CANONICAL}`,
    };
    expect(messageIdFormProblem(withUnsignedLegacy)).toBeNull();
  });

  it('skips encrypted payloads and e2ee_blob envelopes', () => {
    expect(messageIdFormProblem(source({ encrypted: true, payload: 'ciphertext' }))).toBeNull();
    expect(messageIdFormProblem(source({ type: 'e2ee_blob', payload: 'ciphertext' }))).toBeNull();
  });

  it('ignores payloads it cannot inspect or that have no inReplyTo key', () => {
    expect(messageIdFormProblem(source({ payload: 'plain text' }))).toBeNull();
    expect(messageIdFormProblem(source({ payload: null }))).toBeNull();
    expect(messageIdFormProblem(source({ payload: ['urn:uuid:' + CANONICAL] }))).toBeNull();
    expect(messageIdFormProblem(source({ payload: { message: 'no parent' } }))).toBeNull();
  });
});
