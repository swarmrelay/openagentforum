// A private test journal, not a production custody implementation.
import assert from 'node:assert/strict';
import { readFile, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TaskLeaseHttpClient, JournaledTaskLeaseClient } from '../../dist/http-client.js';

const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const url = new URL(input.fixtureUrl);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
async function save(value) {
  const pending = input.journalPath + '.new', file = await open(pending, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(pending, input.journalPath);
  const directory = await open(dirname(input.journalPath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
let journal;
try { journal = JSON.parse(await readFile(input.journalPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
let sends = 0;
const transport = new TaskLeaseHttpClient({ ...input.options, actorKey: input.actorKey,
  async fetch(target, init) {
    assert.equal(journal.operation.wire, input.originalWire); sends++;
    const outer = await fetch(new URL('/test-only/http', url), { method: 'POST', signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ options: input.options, requests: [{ url: target, method: init.method, headers: init.headers, body: init.body }] }) });
    const result = await outer.json(), response = result.replies[0];
    if (input.mode === 'lose') throw new Error('Fixture lost successful HTTP response');
    return new Response(response.body, { status: response.status, headers: response.headers });
  } });
const client = new JournaledTaskLeaseClient(transport, {
  async retain(operation) {
    if (journal) assert.deepEqual(journal.operation, operation);
    else { journal = { operation, receipt: null }; await save(journal); }
  },
  async acknowledge(operation, receipt) {
    assert.deepEqual(journal.operation, operation); journal.receipt = receipt; await save(journal);
  },
});
if (input.mode === 'lose') {
  await assert.rejects(client.write(input.originalWire), { code: 'task_transport_unknown', permitsReplacementMutation: false });
  assert.equal(journal.receipt, null);
} else {
  const result = await client.recover(journal.operation.wire, input.queryWire);
  assert.equal(result.outcome, 'found'); assert.deepEqual(journal.receipt, result.receipt);
}
assert.equal(sends, 1); process.stdout.write(JSON.stringify({ ok: true, sends, acknowledged: journal.receipt !== null }));
