import { describe, expect, it } from 'vitest';
import { observeForumStorage } from './fixtures/forum-storage-observer.mjs';

function fixture(fault, thrown = new Error('PRIVATE_DRIVER_MARKER')) {
  const calls = [], result = { private: 'PRIVATE_RESULT_MARKER' };
  const statement = {
    bind(...values) { expect(this).toBe(statement); calls.push(['bind', values]); if (fault === 'bind') throw thrown; return statement; },
    async first(...values) { expect(this).toBe(statement); calls.push(['first', values]); if (fault === 'first') throw thrown; return result; },
    async run() { expect(this).toBe(statement); calls.push(['run']); if (fault === 'run') throw thrown; return result; },
  };
  const db = {
    prepare(sql) { expect(this).toBe(db); calls.push(['prepare', sql]); if (fault === 'prepare') throw thrown; return statement; },
    withSession(value) { expect(this).toBe(db); calls.push(['withSession', value]); return result; },
  };
  return { ...observeForumStorage(db), calls, result, thrown };
}
describe('request-local forum storage observer', () => {
  it('forwards unchanged SQL, bindings, return values and receiver identity without another operation', async () => {
    const s = fixture(), sql = 'SELECT public_key FROM agents WHERE agent_id = ?';
    expect(s.snapshot()).toEqual({ last: 'before-storage', failed: 'none', error: 'none' });
    expect(await s.db.prepare(sql).bind('PRIVATE_BIND_MARKER').first('public_key')).toBe(s.result);
    expect(s.calls).toEqual([['prepare', sql], ['bind', ['PRIVATE_BIND_MARKER']], ['first', ['public_key']]]);
    expect(s.snapshot()).toEqual({ last: 'sender-key', failed: 'none', error: 'none' });
    expect(JSON.stringify(s.snapshot())).not.toContain('PRIVATE');
    expect(s.db.withSession('first-primary')).toBe(s.result);
  });
  it.each(['prepare', 'bind', 'first', 'run'])('observes a %s failure once and rethrows the same error', async fault => {
    const s = fixture(fault);
    const run = async () => s.db.prepare('INSERT INTO messages VALUES (?)').bind('PRIVATE_BIND_MARKER')[fault === 'run' ? 'run' : 'first']();
    await expect(run()).rejects.toBe(s.thrown);
    expect(s.calls.filter(([method]) => method === fault)).toHaveLength(1);
    expect(s.snapshot()).toEqual({ last: 'message-insert', failed: 'message-insert', error: 'other' });
  });
  it.each([
    ['UNIQUE constraint failed', 'unique'], ['SQLITE_BUSY', 'busy'], ['database is locked', 'busy'],
    ['SQLITE_CONSTRAINT', 'constraint'], ['overloaded', 'overload'], ['Cannot perform I/O', 'io-context'],
    ['Network connection lost', 'connection-lost'], ['D1_ERROR', 'd1'],
  ])('maps %s to a fixed category without forwarding prose', async (text, error) => {
    const s = fixture('first', new Error('PRIVATE_DRIVER_MARKER', { cause: new Error(text + ': PRIVATE_CAUSE_MARKER') }));
    await expect(s.db.prepare('INSERT INTO messages VALUES (?)').first()).rejects.toBe(s.thrown);
    expect(s.snapshot()).toEqual({ last: 'message-insert', failed: 'message-insert', error });
  });
  it('separates concurrent requests and does not mislabel later progress as the earlier failing step', async () => {
    const a = fixture('first'), b = fixture();
    await expect(a.db.prepare('INSERT INTO messages VALUES (?)').first()).rejects.toBe(a.thrown);
    await Promise.all([a.db.prepare('UPDATE agents SET last_seen_at = ?').run(),
      b.db.prepare('UPDATE channels SET message_count = message_count + 1').run()]);
    expect(a.snapshot()).toEqual({ last: 'agent-metadata', failed: 'message-insert', error: 'other' });
    expect(b.snapshot()).toEqual({ last: 'channel-metadata', failed: 'none', error: 'none' });
  });
});
