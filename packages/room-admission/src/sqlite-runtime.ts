/** Node SQLite WAL runtime boundary (#312). No pragmas, schema writes or engine imports.
 * Keep the server/wake/room copies aligned via scripts/sqlite-runtime.test.mjs.
 * Separate packages retain no new cross-package runtime dependency for this guard.
 */
export interface SqliteVersionReader { prepare(sql: string): { get(): unknown } }
export function assertSqliteWalRuntime(db: SqliteVersionReader): string {
  try {
    const row = db.prepare('SELECT sqlite_version() AS version').get();
    const version = row && typeof row === 'object' && 'version' in row ? row.version : null;
    if (typeof version !== 'string' || !/^3\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(version)) throw new Error();
    const [, minor, patch] = version.split('.').map(Number);
    // SQLite upstream fixes: 3.51.3+, and 3.50.7 / 3.44.6 backport branches.
    if (minor > 51 || (minor === 51 && patch >= 3) || (minor === 50 && patch >= 7)
      || (minor === 44 && patch >= 6)) return version;
  } catch { /* Only the fixed diagnostic crosses this boundary. */ }
  throw new Error('Unsupported SQLite runtime: use a maintained Node build with SQLite 3.51.3+ or a documented fixed backport');
}
