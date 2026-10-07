// Test-only, request-local observer. Never records SQL, bound values, results or raw errors.
import { roomStorageDiagnostic } from './room-diagnostics.mjs';

function stage(sql) {
  const text = sql.replace(/\s+/g, ' ').trim();
  return text.startsWith('SELECT public_key FROM agents') ? 'sender-key'
    : text.startsWith('SELECT is_private, e2ee_required FROM channels') ? 'channel-policy'
    : text.startsWith('SELECT * FROM messages WHERE id') ? 'message-replay'
    : text.startsWith('INSERT OR IGNORE INTO channels') ? 'channel-create'
    : text.startsWith('SELECT COALESCE(MAX(stored_seq)') ? 'message-sequence'
    : text.startsWith('INSERT INTO messages') ? 'message-insert'
    : text.startsWith('UPDATE channels SET message_count') ? 'channel-metadata'
    : text.startsWith('UPDATE agents SET last_seen_at') ? 'agent-metadata' : 'lookup';
}
function message(error) {
  try { return typeof error?.message === 'string' ? error.message.slice(0, 4096) : ''; } catch { return ''; }
}
function category(error) {
  let text = message(error);
  try { text += ' ' + message(error?.cause); } catch { /* never forward property errors */ }
  return /UNIQUE/.test(text) ? 'unique' : /SQLITE_BUSY|database is locked/.test(text) ? 'busy'
    : /SQLITE_CONSTRAINT|constraint failed/.test(text) ? 'constraint' : /overload/i.test(text) ? 'overload'
    : /Cannot perform I\/O/.test(text) ? 'io-context' : /Network connection lost/.test(text) ? 'connection-lost'
    : /D1_ERROR/.test(text) ? 'd1' : 'other';
}
export function observeForumStorage(database) {
  let last = 'before-storage', failed = 'none', error = 'none';
  const note = (step, thrown) => { failed = step; error = category(thrown); };
  const wrap = (statement, step) => new Proxy(statement, { get(target, name) {
    if (name === 'bind') return (...args) => {
      last = step;
      try { return wrap(target.bind(...args), step); } catch (thrown) { note(step, thrown); throw thrown; }
    };
    if (['first', 'all', 'run', 'raw'].includes(name)) return async (...args) => {
      last = step;
      try { return await target[name](...args); } catch (thrown) { note(step, thrown); throw thrown; }
    };
    const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const db = new Proxy(database, { get(target, name) {
    if (name === 'prepare') return sql => {
      const step = stage(sql); last = step;
      try { return wrap(target.prepare(sql), step); } catch (thrown) { note(step, thrown); throw thrown; }
    };
    const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  // A prior error may have been handled by the API. These are observations, not a root-cause or rollback claim.
  return { db, snapshot: () => roomStorageDiagnostic({ last, failed, error }) };
}
