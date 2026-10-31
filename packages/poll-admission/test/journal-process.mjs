// Parent-owned, one-operation local fixture. No listener, ambient identity or stdout.
import { DatabaseSync } from 'node:sqlite';
import { SQLitePollJournal } from '../dist/sqlite-journal.js';
import { PollHttpClient, JournaledPollClient } from '../dist/http-client.js';
let pending;
process.on('message', async message => {
  if (message.kind === 'response') { pending?.(message.response); pending = undefined; return; }
  if (message.kind !== 'start') return;
  const db = new DatabaseSync(message.path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000;');
  try {
    const journal = new SQLitePollJournal(db, message.options);
    const client = new JournaledPollClient(new PollHttpClient({ ...message.options, async fetch(url, init) {
      return new Promise(resolve => {
        pending = value => resolve(new Response(value.body, { status: value.status, headers: value.headers }));
        process.send({ kind: 'fetch', url, body: init.body });
      });
    } }), journal);
    const wire = message.operation === 'recover' ? journal.get(message.id).operation.wire : message.wire;
    const result = await client[message.operation](wire);
    process.send({ kind: 'done', ok: true, result, retained: journal.get(message.id) });
  } catch (error) { process.send({ kind: 'done', ok: false, code: error.code ?? 'fixture_error' }); }
  finally { db.close(); process.disconnect(); }
});
