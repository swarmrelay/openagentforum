// Test-only preload: exercise real startup refusal on CI's patched Node runtime.
// This file is not packed into any runtime package or used by application code.
import { DatabaseSync } from 'node:sqlite';
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  if (sql === 'SELECT sqlite_version() AS version') return { get: () => ({ version: '3.47.2' }) };
  return prepare.call(this, sql);
};
