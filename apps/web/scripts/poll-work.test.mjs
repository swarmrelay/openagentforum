import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';
import { generateAgentKeyPair, signEnvelope, tallyPoll, verifyPollProof } from '@openagentforum/protocol';
import { POLL_WORK_LIMITS as limits } from '@openagentforum/server/polls';

let mf, worker, scratch;
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
const origin = 'https://relay.test';
const request = (path, body, adapter = 'Pages') => worker.fetch(origin + path, {
  headers: { 'content-type': 'application/json', 'x-fixture-adapter': adapter },
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
});
async function sql(statements) {
  const response = await request('/fixture/sql', statements);
  assert.equal(response.status, 200); const rows = await response.json(); assert.ok(rows.every(r => r.success)); return rows;
}
before(async () => {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  scratch = await mkdtemp(join(tmpdir(), 'oaf-poll-work-'));
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/poll-work-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  mf = new Miniflare({ host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
    telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'),
    workers: [{ config: { name: 'poll-work-test', compatibilityDate: config.compatibility_date, compatibilityFlags: [],
      workersDev: false, previewUrls: false, domains: [], triggers: [],
      env: { DB: { type: 'd1', id: 'poll-work-local', dev: { remote: false } } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { throw new Error('Outbound network denied'); } } } }],
  });
  await mf.ready; worker = await mf.getWorker('poll-work-test');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    const schema = (await readFile(new URL(file, migrations), 'utf8')).replace(/^\s*--.*$/gm, '');
    const trigger = schema.indexOf('CREATE TRIGGER ');
    await sql((trigger < 0 ? schema : schema.slice(0, trigger)).split(';').filter(s => s.trim()).map(sql => ({ sql })));
    if (trigger >= 0) await sql([{ sql: schema.slice(trigger) }]);
  }
});
after(async () => {
  await mf?.dispose(); if (scratch) await rm(scratch, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
  else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
});

async function history(channel) {
  const creator = await generateAgentKeyPair(), voter = await generateAgentKeyPair();
  for (const key of [creator, voter]) assert.equal((await request('/v1/agents/register', { publicKey: key.signingPublicKey })).status, 200);
  const poll = { ...await signEnvelope({ channel, sender: creator.agentId, type: 'poll', sequence: 700,
    payload: { kind: 'open', title: 'Native bounded poll', options: ['yes', 'no'], ledger: { hub: origin },
      electorate: { type: 'list', agentIds: [creator.agentId, voter.agentId] }, closes: { allVoted: true },
      closePolicy: { creator: true }, rule: { method: 'plurality' }, revote: 'latest' } }, creator.signingPrivateKey), storedSeq: 1 };
  assert.equal((await request(`/v1/channels/${channel}/messages`, poll)).status, 200);
  const vote = (choice, sequence) => signEnvelope({ channel, sender: voter.agentId, type: 'vote', sequence,
    payload: { pollId: poll.id, pollHash: poll.checksum, choice } }, voter.signingPrivateKey);
  return { creator, voter, poll, vote };
}
function insert(h, n, padding) {
  return { sql: `INSERT INTO messages (id,channel,sender,type,sequence,stored_seq,timestamp,payload_json,signature,checksum)
    VALUES (?,?,?,'vote',?,?,?,?,?,?)`, args: [`${h.poll.id}-fixture-${n}`, h.poll.channel, 'unregistered', n,
      n + 2, h.poll.timestamp, JSON.stringify({ pollId: h.poll.id, pollHash: h.poll.checksum, choice: 0, ...(padding === undefined ? {} : { padding }) }), '0'.repeat(128), '0'.repeat(64)] };
}

test('native Pages and Worker preserve reference tally, proofs, primary reads and indexed seeks', async () => {
  const h = await history('native-poll-valid'), votes = [];
  for (const [choice, sequence] of [[0, 31], [1, 32]]) {
    const e = await h.vote(choice, sequence); assert.equal((await request(`/v1/channels/${h.poll.channel}/messages`, e)).status, 200);
    votes.push({ ...e, storedSeq: votes.length + 2 });
  }
  const keys = new Map([[h.creator.agentId, h.creator.signingPublicKey], [h.voter.agentId, h.voter.signingPublicKey]]);
  const expected = await tallyPoll(h.poll, votes, async id => keys.get(id));
  let baseline;
  for (const adapter of ['Pages', 'Worker']) {
    const response = await request(`/v1/polls/${h.poll.id}`, undefined, adapter);
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-fixture-primary-sessions'), '2');
    baseline = Number(response.headers.get('x-fixture-rows-read'));
    const body = await response.json(); assert.deepEqual(body.tally, expected); assert.equal(body.poll.sequence, 700);
    const proof = await (await request(`/v1/polls/${h.poll.id}/proof/${votes[1].id}`, undefined, adapter)).json();
    assert.equal(await verifyPollProof(proof.leafBytes, proof.proof, proof.root), true);
    const invalid = await request(`/v1/polls/${h.poll.id}?atSeq=2junk`, undefined, adapter);
    assert.equal(invalid.status, 400); assert.equal(invalid.headers.get('x-fixture-primary-sessions'), '0');
  }
  // Thousands of unrelated candidate-shaped rows must not expand a poll seek.
  await sql([{ sql: `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<5000)
    INSERT INTO messages (id,channel,sender,type,sequence,stored_seq,timestamp,payload_json,signature,checksum)
    SELECT 'unrelated-'||i, ?, 'fixture', 'vote', i+100, i+100, 1, '{"pollId":"elsewhere"}', '', '' FROM n`, args: [h.poll.channel] }]);
  const response = await request(`/v1/polls/${h.poll.id}`);
  assert.equal(response.status, 200);
  // A populated index can inspect the first key beyond the selected range.
  assert.ok(Number(response.headers.get('x-fixture-rows-read')) <= baseline + 1);
});

test('native complete record boundary, overflow sentinel, cutoff and no-write refusal', async () => {
  const h = await history('native-poll-records');
  const statements = Array.from({ length: limits.records - 1 }, (_, n) => insert(h, n));
  for (let i = 0; i < statements.length; i += 100) await sql(statements.slice(i, i + 100));
  const route = `/v1/polls/${h.poll.id}`;
  const accepted = await request(route); assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).tally.ballots.length, limits.records - 1);
  await sql([insert(h, limits.records)]);
  const before = (await sql([{ sql: 'SELECT count(*) AS n FROM messages' }]))[0].results[0].n;
  for (const adapter of ['Pages', 'Worker']) {
    for (const path of [route, route + '/audit', route + '/proof/missing', `/v1/polls?channel=${h.poll.channel}`]) {
      const r = await request(path, undefined, adapter); assert.equal(r.status, 503);
      assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-fixture-last-payloads'), '0');
      assert.ok(Number(r.headers.get('x-fixture-rows-read')) <= 8 * limits.records + 256);
      assert.deepEqual(await r.json(), { error: 'poll_work_limit', code: 'poll_work_limit' });
    }
    assert.equal((await request(route + '?atSeq=2', undefined, adapter)).status, 200);
    const close = await signEnvelope({ channel: h.poll.channel, sender: h.creator.agentId, type: 'poll', sequence: 701,
      payload: { kind: 'close', pollId: h.poll.id, pollHash: h.poll.checksum } }, h.creator.signingPrivateKey);
    for (const envelope of [await h.vote(1, 9999), close]) {
      const r = await request(`/v1/channels/${h.poll.channel}/messages`, envelope, adapter);
      assert.equal(r.status, 503); assert.equal((await r.json()).code, 'poll_work_limit');
    }
  }
  assert.equal((await sql([{ sql: 'SELECT count(*) AS n FROM messages' }]))[0].results[0].n, before);
});

test('native byte and tree limits fail without partial lists or oversized SQL responses', async () => {
  for (const mode of ['single', 'aggregate', 'depth', 'nodes']) {
    const h = await history('native-poll-' + mode);
    let statements;
    if (mode === 'single') statements = [insert(h, 0, 'x'.repeat(limits.recordBytes))];
    if (mode === 'aggregate') statements = Array.from({ length: 18 }, (_, n) => insert(h, n, 'x'.repeat(240000)));
    if (mode === 'depth') { let value = 0; for (let i = 0; i < 18; i++) value = [value]; statements = [insert(h, 0, value)]; }
    if (mode === 'nodes') statements = Array.from({ length: 9 }, (_, n) => insert(h, n, Array.from({ length: 8 }, () => Array(1000).fill(0))));
    for (const statement of statements) await sql([statement]);
    for (const adapter of ['Pages', 'Worker']) {
      const r = await request(`/v1/polls/${h.poll.id}`, undefined, adapter); assert.equal(r.status, 503, mode);
      assert.equal((await r.json()).code, 'poll_work_limit');
      if (mode === 'single' || mode === 'aggregate') assert.equal(r.headers.get('x-fixture-last-payloads'), '0');
      assert.equal((await request(`/v1/polls/${h.poll.id}?atSeq=1`, undefined, adapter)).status, 200);
      assert.equal((await request(`/v1/polls?channel=${h.poll.channel}`, undefined, adapter)).status, 503);
    }
  }
});

test('native missing required index returns a generic unavailable response', async () => {
  const h = await history('native-poll-missing-index');
  await sql([{ sql: 'DROP INDEX idx_messages_poll_reference' }]);
  for (const adapter of ['Pages', 'Worker']) {
    const r = await request(`/v1/polls/${h.poll.id}`, undefined, adapter);
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'poll_work_unavailable', code: 'poll_work_unavailable' });
  }
});
