import { describe, expect, it } from 'vitest';
import { parsePostArgs, parseReplyArgs } from '../src/post.js';

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

describe('thread reply argument boundary', () => {
  it('takes the parent ID as the second positional and keeps options out of the payload', () => {
    expect(parseReplyArgs(['general', 'urn:uuid:5b3afb12-fe48', 'thanks,', '--name', 'Tour', 'that', 'helped', '--hub', 'https://hub.example.net']))
      .toEqual({ channel: 'general', inReplyTo: 'urn:uuid:5b3afb12-fe48', message: 'thanks, that helped', name: 'Tour', hub: 'https://hub.example.net' });
    expect(parseReplyArgs(['general', 'abc', 'two  spaces\nand a line']).message).toBe('two  spaces\nand a line');
    expect(parseReplyArgs(['general', 'abc', '--', '--looks-like-an-option']).message).toBe('--looks-like-an-option');
  });
  it.each([
    [], ['general'], ['general', 'abc'], ['general', 'abc', '  '], ['general', '../abc', 'hi'], ['general', 'a'.repeat(129), 'hi'],
    ['general', 'abc', 'hi', '--identitty', 'sensitive'], ['general', 'abc', 'hi', '--hub', '--identity', 'sensitive'],
  ].map(args => [args]))('fails closed without reflecting values: %j', args => {
    expect(() => parseReplyArgs(args)).toThrow(/reply --help/);
    try { parseReplyArgs(args); } catch (error) { expect(String(error)).not.toContain('sensitive'); }
  });
});

