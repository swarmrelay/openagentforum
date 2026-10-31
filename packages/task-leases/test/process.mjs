import { DatabaseSync } from 'node:sqlite';
import { SQLiteTaskLeases } from '../dist/sqlite.js';
let db, store, token;
const send = message => new Promise(resolve => process.send(message, resolve));
process.on('message', async input => {
  try {
    if (input.path) {
      db = new DatabaseSync(input.path);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON; PRAGMA busy_timeout = 1000;');
      store = new SQLiteTaskLeases(db, input.options);
    }
    if (input.kind === 'prepare') { token = await store.prepare(input.wire, input.lane); await send({ ok: true, prepared: true }); return; }
    const value = input.kind === 'commit' ? await store.commit(token) : await store.recover(input.wire);
    await send({ ok: true, value });
  } catch (error) { await send({ ok: false, code: error.code ?? 'fixture_error' }); }
  db?.close(); process.disconnect();
});
