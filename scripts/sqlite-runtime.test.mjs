import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { assertSqliteWalRuntime as server } from '../packages/server/dist/sqlite-runtime.js';
import { assertSqliteWalRuntime as wake } from '../packages/wake-service/dist/sqlite-runtime.js';
import { assertSqliteWalRuntime as rooms } from '../packages/room-admission/dist/sqlite-runtime.js';
import { createStandaloneServer } from '../packages/server/dist/standalone.js';
import { AttemptLedger } from '../packages/wake-service/dist/ledger.js';
import { RoomAdmissionStore } from '../packages/room-admission/dist/sqlite.js';

const guards = { server, wake, rooms };
const query = 'SELECT sqlite_version() AS version';
const diagnostic = 'Unsupported SQLite runtime: use a maintained Node build with SQLite 3.51.3+ or a documented fixed backport';
const accepted = ['3.44.6', '3.44.7', '3.50.7', '3.50.8', '3.51.3', '3.51.4', '3.52.0', '3.53.0', '3.100.0'];
const rejected = ['3.7.0', '3.44.5', '3.45.6', '3.47.2', '3.49.99', '3.50.6', '3.51.2', '4.0.0',
  '3.051.3', '3.51.03', '3.51.3-custom', '3.51.3\n', '3.51', '3.51.3.1', '', null, 3051003, {}, '3.' + '9'.repeat(10000) + '.3'];

test('independent package guards stay byte-identical without new runtime dependencies', () => {
  const sources = ['server', 'wake-service', 'room-admission'].map(pkg =>
    readFileSync(new URL(`../packages/${pkg}/src/sqlite-runtime.ts`, import.meta.url), 'utf8'));
  assert.equal(sources[0], sources[1]); assert.equal(sources[0], sources[2]);
});
for (const [name, guard] of Object.entries(guards)) {
  test(`${name}: fixed branches accept; affected, malformed and unknown engines fail closed with no writes`, () => {
    for (const version of [...accepted, ...rejected]) {
      const calls = [];
      const db = { prepare(sql) { calls.push(sql); return { get: () => ({ version }) }; } };
      if (accepted.includes(version)) assert.equal(guard(db), version);
      else assert.throws(() => guard(db), { message: diagnostic });
      assert.deepEqual(calls, [query]);
    }
    for (const value of [undefined, null, {}, { version: undefined }]) {
      assert.throws(() => guard({ prepare: () => ({ get: () => value }) }), { message: diagnostic });
    }
    assert.throws(() => guard({ prepare() { throw new Error('PRIVATE driver path'); } }), { message: diagnostic });
  });
}

test('the actual test runtime has a patched engine (never bypassed by an environment flag)', () => {
  const db = new DatabaseSync(':memory:');
  try { for (const guard of Object.values(guards)) assert.equal(guard(db), process.versions.sqlite); }
  finally { db.close(); }
});

test('standalone and wake refuse an affected engine before creating a target file or listener', t => {
  const directory = mkdtempSync(join(tmpdir(), 'oaf-sqlite-refusal-'));
  const prepare = DatabaseSync.prototype.prepare;
  const calls = [];
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    calls.push(sql);
    return sql === query ? { get: () => ({ version: '3.47.2' }) } : prepare.call(this, sql);
  });
  try {
    assert.throws(() => createStandaloneServer({ dbPath: join(directory, 'relay.sqlite') }), { message: diagnostic });
    assert.throws(() => new AttemptLedger(join(directory, 'attempts.sqlite')), { message: diagnostic });
    assert.deepEqual(readdirSync(directory), []);
    assert.deepEqual(calls, [query, query]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('room admission checks the caller connection before any journal, schema or authority mutation', t => {
  const db = new DatabaseSync(':memory:');
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    return sql === query ? { get: () => ({ version: '3.51.2' }) } : prepare.call(this, sql);
  });
  const writes = t.mock.method(db, 'exec', () => { throw new Error('Must not write'); });
  try {
    assert.throws(() => new RoomAdmissionStore(db, {}), { message: diagnostic });
    assert.equal(writes.mock.callCount(), 0);
    assert.deepEqual(prepare.call(db, 'SELECT name FROM sqlite_schema').all(), []);
  } finally { db.close(); }
});

for (const entrypoint of ['main', 'pull-main']) {
  test(`wake ${entrypoint} refuses before credential reads, state creation or listener startup`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'oaf-sqlite-startup-'));
    try {
      const child = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/unpatched-sqlite.mjs', import.meta.url)),
        fileURLToPath(new URL(`../packages/wake-service/dist/${entrypoint}.js`, import.meta.url))], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
        env: { PATH: process.env.PATH, OAF_WAKE_STATE_DIR: join(directory, 'state'), OAF_WAKE_TOKEN_FILE: join(directory, 'missing-token') },
      });
      assert.equal(child.status, 1); assert.equal(child.signal, null);
      assert.equal(child.stdout, ''); assert.match(child.stderr, /check patched SQLite runtime/);
      assert(!child.stderr.includes(directory)); assert.deepEqual(readdirSync(directory), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
