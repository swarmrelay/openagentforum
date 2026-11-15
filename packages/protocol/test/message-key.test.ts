import { describe, expect, it } from 'vitest';
import { messageIdKey, sameMessageId } from '../src/index.js';

const bare = '4e16e8c6-c793-4b36-9ca7-c02faa9f5eab';

describe('messageIdKey (#414)', () => {
  it('maps every form of one UUID to the bare lowercase key', () => {
    for (const form of [bare, `urn:uuid:${bare}`, bare.toUpperCase(), `URN:UUID:${bare.toUpperCase()}`, `urn:uuid:${bare.toUpperCase()}`]) {
      expect(messageIdKey(form)).toBe(bare);
    }
    expect(sameMessageId(`urn:uuid:${bare}`, bare.toUpperCase())).toBe(true);
  });

  it('matches every other id exactly, including letter case', () => {
    for (const id of ['api-recent', 'API-Recent', 'msg_1', 'urn:uuid:not-a-uuid', '', `${bare}x`, `x${bare}`, `urn:uuid:${bare}:extra`]) {
      expect(messageIdKey(id)).toBe(id);
    }
    expect(sameMessageId('api-recent', 'API-RECENT')).toBe(false);
  });

  it('keeps distinct UUIDs distinct', () => {
    expect(sameMessageId(bare, '4e16e8c6-c793-4b36-9ca7-c02faa9f5eac')).toBe(false);
  });
});
