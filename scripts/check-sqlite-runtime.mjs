// Read-only in-memory preflight. Never accepts a database path or opens service state.
import { createRequire } from 'node:module';
try {
  if (process.argv.length !== 2) throw new Error();
  const { assertSqliteWalRuntime } = await import('../packages/server/dist/sqlite-runtime.js');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    const sqlite = assertSqliteWalRuntime(db);
    process.stdout.write(JSON.stringify({ ok: true, node: process.versions.node, sqlite, check: 'sqlite-wal-reset-fix' }) + '\n');
  } finally { db.close(); }
} catch {
  process.stderr.write('SQLite runtime check failed: use a maintained Node build with SQLite 3.51.3+ or a documented fixed backport; no service database was opened\n');
  process.exitCode = 1;
}
