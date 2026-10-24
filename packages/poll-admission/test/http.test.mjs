import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import { fixture, opening, signed, attempts, invariant } from './helpers.mjs';
import { PollHttpClient } from '../dist/http-client.js';
import { createPollHttpHandler } from '../dist/http-server.js';

test('SQLite reserves before reading, releases the transaction, preserves charges and refuses an aborted reader', async t => {
  const actor = await generateAgentKeyPair(), f = fixture(t, [actor]), store = f.client();
  const root = await opening(actor);
  const prepared = await store.prepare({ async read() {
    assert.equal(attempts(f.db).ordinary.requests, 1);
    f.db.exec('BEGIN IMMEDIATE; ROLLBACK;'); // Body awaits never hold a write transaction.
    return JSON.stringify(root);
  } }, { channel: 'general' });
  assert.equal(store.commit(prepared).outcome, 'found');
  const controller = new AbortController();
  await assert.rejects(store.prepare({ signal: controller.signal, async read() {
    controller.abort(); return JSON.stringify(root);
  } }), e => e.code === 'preparation_expired');
  await assert.rejects(store.recover({ async read() { throw new Error('Fixture body failure'); } }), e => e.code === 'invalid_input');
  assert.equal((await store.recover(JSON.stringify(root))).outcome, 'found');
  assert.equal(attempts(f.db).ordinary.requests, 2); assert.equal(attempts(f.db).recovery.requests, 2);
  invariant(f.db, f.config);
});

test('SQLite HTTP uses the same close and recovery contract and rejects a mismatched signed route', async t => {
  const actor = await generateAgentKeyPair(), f = fixture(t, [actor]), store = f.client();
  const handler = createPollHttpHandler(store, { ...f.config, bodyTimeoutMs: 1000 });
  const client = new PollHttpClient({ ...f.config, actorKey: actor.signingPublicKey, fetch(url, init) { return handler(new Request(url, init)); } });
  const root = await opening(actor), wire = JSON.stringify(root), receipt = (await client.write(wire)).receipt;
  assert.deepEqual((await client.recover(wire)).receipt, receipt);
  const response = await handler(new Request(`${f.config.origin}/v1/channels/different/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: wire,
  }));
  assert.equal(response.status, 409); invariant(f.db, f.config);
});

test('client bounds and correlates hostile responses without retry or replacement permission', async t => {
  const actor = await generateAgentKeyPair(), f = fixture(t, [actor]), root = await opening(actor);
  const store = f.client(), wire = JSON.stringify(root);
  const receipt = store.commit(await store.prepare(wire)).receipt;
  const good = { ok: true, outcome: 'found', historical: true, receipt };
  const variants = [
    { ...good, receipt: { ...receipt, id: 'another' } },
    { ...good, receipt: { ...receipt, actorKey: 'cd'.repeat(32) } },
    { ...good, receipt: { ...receipt, generation: 'cd'.repeat(32) } },
    { ...good, receipt: { ...receipt, signature: 'cd'.repeat(64) } },
    { ...good, receipt: { ...receipt, policyRevision: 'another' } },
    { ...good, receipt: { ...receipt, storedSeq: -1 } },
    { ...good, receipt: { ...receipt, pollRevision: null } },
    { ...good, receipt: { ...receipt, extra: 'untrusted' } },
    { ...good, historical: false },
    { ...good, outcome: 'unavailable' },
    { ...good, replayed: true },
  ];
  for (const value of variants) {
    let calls = 0;
    const client = new PollHttpClient({ ...f.config, actorKey: actor.signingPublicKey,
      async fetch() { calls++; return Response.json(value); } });
    await assert.rejects(client.write(wire), e => e.code === 'poll_invalid_response' && e.permitsReplacementMutation === false);
    assert.equal(calls, 1);
  }
  for (const value of ['x'.repeat(5000), new Uint8Array([0xc0, 0xaf]), 'not JSON']) {
    const client = new PollHttpClient({ ...f.config, actorKey: actor.signingPublicKey,
      async fetch() { return new Response(value, { headers: { 'content-type': 'application/json' } }); } });
    await assert.rejects(client.recover(wire), e => e instanceof Error && e.permitsReplacementMutation === false);
  }
  let calls = 0;
  const stalled = new PollHttpClient({ ...f.config, actorKey: actor.signingPublicKey, timeoutMs: 20,
    async fetch() { calls++; return new Response(new ReadableStream({ pull() {} }), { headers: { 'content-type': 'application/json' } }); } });
  await assert.rejects(stalled.write(wire), e => e.code === 'poll_transport_unknown');
  assert.equal(calls, 1);
  const invalid = await signed(actor, 'intel', { fixture: true }, { sender: 'agent_0123456789abcdef' });
  await assert.rejects(stalled.write(JSON.stringify(invalid)), e => e.code === 'invalid_request');
  assert.equal(calls, 1);
});
