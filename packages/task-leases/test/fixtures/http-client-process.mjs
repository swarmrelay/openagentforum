// Independent local consumer of the concrete journal; no public network or key custody.
import assert from 'node:assert/strict';
import { open, lstat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { TaskLeaseHttpClient, JournaledTaskLeaseClient } from '../../dist/http-client.js';
import { SQLiteTaskLeaseJournal, provisionTaskLeaseJournal } from '../../dist/sqlite-journal.js';
import { verifyWire } from '../../dist/contract.js';

const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const url = new URL(input.fixtureUrl);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
const { origin, audience, generation, policyRevision } = input.options;
const config = { origin, audience, generation, policyRevision, actorKey: input.actorKey, maxOperations: 10, maxBytes: 1048576 };
const initialize = input.mode === 'lose' || input.mode === 'retain-exit';
if (initialize) { const file = await open(input.journalPath, 'wx', 0o600); await file.close(); }
const stat = await lstat(input.journalPath); assert(stat.isFile()); assert.equal(stat.mode & 0o777, 0o600);
const db = new DatabaseSync(input.journalPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
if (initialize) provisionTaskLeaseJournal(db, config);
const journal = new SQLiteTaskLeaseJournal(db, config), operationId = (await verifyWire(input.originalWire)).command.operationId;
if (input.mode === 'retain-exit') {
  await journal.retain(await new TaskLeaseHttpClient({ ...input.options, actorKey: input.actorKey }).describe(input.originalWire));
  process.exit(23); // Deliberate crash boundary: no db.close, POST or acknowledgment.
}
let sends = 0;
const transport = new TaskLeaseHttpClient({ ...input.options, actorKey: input.actorKey,
  async fetch(target, init) {
    assert.equal((await journal.get(operationId)).operation.wire, input.originalWire); sends++;
    const outer = await fetch(new URL('/test-only/http', url), { method: 'POST', signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ options: input.options, requests: [{ url: target, method: init.method, headers: init.headers, body: init.body }] }) });
    const result = await outer.json(), response = result.replies[0];
    if (input.mode === 'lose') throw new Error('Fixture lost successful HTTP response');
    return new Response(response.body, { status: response.status, headers: response.headers });
  } });
const client = new JournaledTaskLeaseClient(transport, journal);
if (input.mode === 'lose') {
  await assert.rejects(client.write(input.originalWire), { code: 'task_transport_unknown', permitsReplacementMutation: false });
  assert.equal((await journal.get(operationId)).receipt, null);
} else {
  const result = await client.recover((await journal.get(operationId)).operation.wire, input.queryWire);
  assert.equal(result.outcome, input.mode === 'recover-unavailable' ? 'unavailable' : 'found');
  assert.deepEqual((await journal.get(operationId)).receipt, result.outcome === 'found' ? result.receipt : null);
}
assert.equal(sends, 1); const acknowledged = (await journal.get(operationId)).receipt !== null; db.close();
process.stdout.write(JSON.stringify({ ok: true, sends, acknowledged }));
