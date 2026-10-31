import test from 'node:test';
import assert from 'node:assert/strict';
import { native, invariant, ballot, closing, signed } from './d1-helpers.mjs';
import { PollHttpClient, JournaledPollClient } from '../dist/http-client.js';

function client(f, actor, inject = () => ({})) {
  let calls = 0;
  const transport = new PollHttpClient({ ...f.options, actorKey: actor.signingPublicKey, async fetch(url, init) {
    calls++;
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    const result = await f.call('http', { path: new URL(url).pathname, body: init.body, ...inject() });
    return new Response(result.body, { status: result.status, headers: result.headers });
  } });
  return { transport, calls: () => calls };
}

test('native HTTP clients open, vote, close and recover after a lost commit and full D1 restart', async t => {
  const f = await native(t), creator = client(f, f.actors[0]), voter = client(f, f.actors[1]);
  const root = await f.open(), vote = await ballot(root, f.actors[1]);
  assert.equal((await creator.transport.write(JSON.stringify(root))).receipt.storedSeq, 1);
  let lose = true;
  const uncertain = client(f, f.actors[1], () => lose ? { fault: 'batch-after' } : {});
  await assert.rejects(uncertain.transport.write(JSON.stringify(vote)), e => e.code === 'poll_outcome_unknown' && e.permitsReplacementMutation === false);
  assert.equal(uncertain.calls(), 1);
  let state = invariant(await f.inspect(), f.options);
  assert.equal(state.messages.length, 2); assert.equal(state.poll_admission_receipts.length, 2);
  await f.restart(); lose = false;
  const recovered = await voter.transport.recover(JSON.stringify(vote));
  assert.equal(recovered.receipt.storedSeq, 2); assert.equal(recovered.historical, true);
  const close = await closing(root, f.actors[0]);
  const result = await creator.transport.write(JSON.stringify(close));
  assert.equal(result.receipt.storedSeq, 3);
  assert.deepEqual((await creator.transport.recover(JSON.stringify(close))).receipt, result.receipt);
  state = invariant(await f.inspect(), f.options);
  assert.equal(state.messages.length, 3); assert.equal(state.poll_admission_controls[0].close_recorded, 1);
  assert.equal(state.messages[1].sequence, vote.sequence);
});

test('HTTP ordinary exhaustion refuses before body pulls while close and recovery remain bounded separately', async t => {
  const f = await native(t, { attempts: { ordinary: 1, completion: 1, recovery: 1 } });
  const root = await f.open(), creator = client(f, f.actors[0]);
  await creator.transport.write(JSON.stringify(root));
  const refused = await f.call('http', { body: '{', stream: 'observed' });
  assert.equal(refused.status, 429); assert.equal(refused.pulls, 0); assert.equal(refused.cancelled, true);
  assert.equal(refused.headers['retry-after'], '86400');
  const close = await closing(root, f.actors[0]);
  await creator.transport.write(JSON.stringify(close));
  assert.equal((await creator.transport.recover(JSON.stringify(close))).outcome, 'found');
  await assert.rejects(creator.transport.recover(JSON.stringify(close)), e => e.status === 429);
  await assert.rejects(creator.transport.write(JSON.stringify(close)), e => e.status === 429);
  invariant(await f.inspect(), f.options);
});

test('native HTTP charges malformed/slow bodies, binds route to signed channel and poll ID, preserves anonymous GET/HEAD', async t => {
  const f = await native(t), root = await f.open();
  const before = await f.inspect();
  for (const method of ['GET', 'HEAD']) {
    const response = await f.call('http', { method }); assert.equal(response.status, 405);
  }
  assert.deepEqual(await f.inspect(), before);
  for (const input of [{ body: '{' }, { stream: 'invalid-utf8' }, { stream: 'chunks' }, { stream: 'stalled', bodyTimeoutMs: 20 }]) {
    const response = await f.call('http', input);
    assert([400, 408, 413].includes(response.status)); assert.equal(response.trace.charges, 1);
    assert.equal(response.trace.batches, 0);
  }
  let response = await f.call('http', { path: '/v1/channels/different/messages', body: JSON.stringify(root) });
  assert.equal(response.status, 409);
  const close = await closing(root, f.actors[0]);
  response = await f.call('http', { path: '/v1/channels/general/polls/another/close', body: JSON.stringify(close) });
  assert.equal(response.status, 409);
  response = await f.call('http', { path: `/v1/channels/general/polls/${root.id}/close`, body: JSON.stringify(root) });
  assert.equal(response.status, 409);
  response = await f.call('http', { path: '/v1/channels/different/messages/recovery', body: JSON.stringify(root) });
  assert.equal(response.status, 409);
  assert.equal((await f.inspect()).messages.length, 0);
});

test('native HTTP rejects request authority spoofing and malformed length without exposing private errors', async t => {
  const f = await native(t);
  for (const [input, status] of [
    [{ path: '/v1/channels/general/messages?lane=completion' }, 404],
    [{ headers: { origin: 'https://other.invalid' } }, 403],
    [{ headers: { 'content-type': 'text/plain' } }, 415],
    [{ headers: { 'content-encoding': 'gzip' } }, 415],
    [{ body: '{', headers: { 'content-length': '300000' } }, 413],
  ]) {
    const response = await f.call('http', input);
    assert.equal(response.status, status); assert.equal(response.trace.charges, 0);
    assert.equal(response.headers['cache-control'], 'no-store, no-transform');
    assert.deepEqual(Object.keys(JSON.parse(response.body)).sort(), ['error', 'ok']);
  }
  await f.sql('DELETE FROM poll_admission_authority');
  const response = await f.call('http', { body: '{', stream: 'observed' });
  assert.equal(response.status, 503); assert.equal(response.pulls, 0);
  assert.equal(response.body.includes('SQL'), false);
});

test('late native charge cannot pull a body, and a late commit reply cannot produce an acknowledgment', async t => {
  // Allow the normal operation deadline for D1 to reach the injected fault even
  // on a busy runner. The fixture delays the selected response beyond that
  // deadline; a short setup deadline can instead expire before any commit.
  const f = await native(t), root = await f.open();
  let response = await f.call('http', { body: JSON.stringify(root), stream: 'observed', fault: 'charge-late' });
  assert([408, 503].includes(response.status)); assert.equal(response.pulls, 0);
  // The HTTP deadline may return before the deliberately delayed storage settles.
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await f.inspect()).messages.length, 0);
  response = await f.call('http', { body: JSON.stringify(root), fault: 'batch-late-after' });
  assert.equal(response.status, 503); assert.equal(JSON.parse(response.body).error, 'poll_outcome_unknown');
  assert.equal(response.trace.batches, 1); assert.equal(response.trace.failedBatch, undefined);
  await new Promise(resolve => setTimeout(resolve, 150));
  const current = invariant(await f.inspect(), f.options);
  assert.equal(current.messages.length, 1);
  response = await f.call('http', { path: '/v1/channels/general/messages/recovery', body: JSON.stringify(root) });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).outcome, 'found');
});

test('client journal failure prevents a POST; lost response retains the exact operation until explicit recovery', async t => {
  const f = await native(t), root = await f.open();
  let lose = true;
  const c = client(f, f.actors[0], () => lose ? { fault: 'batch-after' } : {}), retained = new Map(), acknowledged = new Map();
  const failing = new JournaledPollClient(c.transport, { async retain() { throw new Error('Fixture durable failure'); }, async acknowledge() {} });
  await assert.rejects(failing.write(JSON.stringify(root)), /Fixture durable failure/); assert.equal(c.calls(), 0);
  const journal = { async retain(operation) {
    const previous = retained.get(operation.id);
    if (previous) assert.deepEqual(operation, previous);
    retained.set(operation.id, structuredClone(operation));
  }, async acknowledge(operation, receipt) {
    assert.deepEqual(retained.get(operation.id), operation); acknowledged.set(operation.id, receipt);
  } };
  const durable = new JournaledPollClient(c.transport, journal);
  await assert.rejects(durable.write(JSON.stringify(root)), e => e.code === 'poll_outcome_unknown');
  assert.equal(c.calls(), 1); assert.equal(retained.get(root.id).wire, JSON.stringify(root)); assert.equal(acknowledged.size, 0);
  lose = false; await f.restart();
  const restarted = new JournaledPollClient(client(f, f.actors[0]).transport, journal);
  assert.equal((await restarted.recover(retained.get(root.id).wire)).outcome, 'found');
  assert.equal(acknowledged.size, 1); assert.equal((await f.inspect()).messages.length, 1);
  const missing = await signed(f.actors[0], 'intel', { fixture: 'not posted' });
  assert.equal((await restarted.recover(JSON.stringify(missing))).outcome, 'unavailable');
  assert(retained.has(missing.id)); assert.equal(acknowledged.has(missing.id), false);
});
