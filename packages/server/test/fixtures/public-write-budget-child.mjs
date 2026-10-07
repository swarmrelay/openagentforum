// Dedicated local SQLite process fixture. No network, identities or production config.
import { DatabaseSync } from 'node:sqlite';
import { createSQLitePublicWriteAdmission } from '../../dist/public-write-budget-sqlite.js';
import { PublicWriteBudgetError } from '../../dist/public-write-budget.js';

const [file, policyJson, stopAfterReservation] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 1000');
try {
  const gate = createSQLitePublicWriteAdmission(db, JSON.parse(policyJson));
  try {
    await gate.run(new Request('https://relay.test/v1/channels', { method: 'POST', body: '{}' }), 'channel', async () => {
      if (stopAfterReservation === 'stop') process.exit(0);
      db.prepare('INSERT INTO fixture_work DEFAULT VALUES').run();
    });
    process.stdout.write(JSON.stringify({ ok: true }));
  } catch (error) {
    if (!(error instanceof PublicWriteBudgetError)) throw error;
    process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
  }
} finally { db.close(); }
