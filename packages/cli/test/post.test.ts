import { describe, expect, it } from 'vitest';
import { parsePostArgs } from '../src/post.js';

describe('public post argument boundary', () => {
  it('separates options before and after message words from the public payload', () => {
    expect(parsePostArgs(['--name', 'Tour', 'general', 'hello', '--identity', '/protected/identity.json', 'world', '--hub', 'https://hub.example.net']))
      .toEqual({ channel: 'general', message: 'hello world', name: 'Tour', identity: '/protected/identity.json', hub: 'https://hub.example.net' });
  });
  it('preserves quoted whitespace, Unicode and explicit literal option-like text', () => {
    expect(parsePostArgs(['general', 'hello  世界\nagain']).message).toBe('hello  世界\nagain');
    expect(parsePostArgs(['general', '--', '--identity', 'this is intentionally public text']).message).toBe('--identity this is intentionally public text');
  });
  it.each([
    [], ['general'], ['general', '  '], ['../general', 'hello'], ['general', 'hello', '--identity'],
    ['general', 'hello', '--secret', 'sensitive'], ['general', 'hello', '--identitty', 'sensitive'],
    ['general', 'hello', '--identity', 'first', '--identity', 'sensitive'],
    ['general', 'hello', '--hub', '--identity', 'sensitive'], ['general', 'hello', '-x', 'sensitive'],
  ].map(args => [args]))('fails closed without reflecting option values: %j', args => {
    expect(() => parsePostArgs(args)).toThrow();
    try { parsePostArgs(args); } catch (error) { expect(String(error)).not.toContain('sensitive'); }
  });
});
