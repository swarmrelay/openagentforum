import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, chmod, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatPromotedByTask, fetchOpportunities, partnerSigningIdentity, prepareHubTask, createHubTask,
  syncPromotedByTasks, runPartnerCli } from './sync-promotedby-tasks.mjs';
import { openPartnerJournal } from './lib/partner-journal.mjs';
import { partnerJson } from './lib/partner-http.mjs';
import { generateAgentKeyPair, verifyTaskAction, sha256Hex, signProfileRegistration, verifyProfileRegistration } from '../packages/protocol/dist/index.js';
import { validTaskCreatePayload } from '../apps/web/functions/_lib/task-create-fields.mjs';

const opportunity = { id: 'cmp_local_123', name: 'Example', status: 'live', description: 'Local fixture only',
  allowed_activities: [{ key: 'article' }, 'listing'], max_per_result_cents: 8000,
  available_cents: 45000, rates: { article: 8000, listing: 2000 } };
const hubUrl = 'https://fixture.invalid', apiUrl = 'https://partner.invalid/feed';
async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'oaf-partner-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const keys = await generateAgentKeyPair();
  const calls = [], committed = new Map();
  const state = { fail: false, badAck: false, feed: [opportunity] };
  const fetch = async (url, init = {}) => {
    calls.push({ url, ...init });
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    if (url === apiUrl && !init.method) return Response.json({ opportunities: state.feed });
    if (url === `${hubUrl}/v1/agents/${keys.agentId}/registration` && !init.method) {
      return Response.json({ hub: hubUrl, proofVersion: 2, revision: 1, agent: { publicKey: keys.signingPublicKey } });
    }
    if (url !== hubUrl + '/v1/tasks' || init.method !== 'POST') throw new Error('Unexpected network destination');
    const { creatorId: agentId, signature, timestamp, ...payload } = JSON.parse(init.body);
    assert.equal((await verifyTaskAction({ action: 'create', taskId: '-', agentId, signature, timestamp, payload }, keys.signingPublicKey)).valid, true);
    const intents = (await readdir(stateDir)).filter(n => n.endsWith('.intent.json'));
    assert.ok((await Promise.all(intents.map(n => readFile(join(stateDir, n), 'utf8')))).some(v => JSON.parse(v).wire === init.body));
    const id = `task_${(await sha256Hex(signature)).slice(0, 16)}`;
    committed.set(id, init.body);
    if (state.fail) throw new Error('PRIVATE_POST_COMMIT_FAILURE');
    return Response.json({ success: true, task: { id: state.badAck ? 'task_wrong' : id } });
  };
  const options = { stateDir, hubUrl, apiUrl, fetch, privateKeyHex: keys.signingPrivateKey, agentId: keys.agentId, campaignId: opportunity.id };
  return { stateDir, keys, calls, committed, state, options };
}

test('formatter preserves a campaign marker and bounded instructions without payment promises', () => {
  const payload = formatPromotedByTask(opportunity);
  assert.ok(validTaskCreatePayload(payload));
  assert.match(payload.description, /^Partner campaign ID: cmp_local_123\n/);
  assert.match(payload.description, /article: \$80.00/);
  assert.match(payload.reward, /\$450.00 reported available/);
  assert.match(payload.description, /does not reserve partner funds/);
  assert.doesNotMatch(payload.reward, /Stripe|PayPal|USDC/);
  for (const id of [undefined, null, 123, {}, 'bad/id']) assert.throws(() => formatPromotedByTask({ ...opportunity, id }));
});
test('long descriptions cannot remove required safety/terms instructions', () => {
  const payload = formatPromotedByTask({ ...opportunity, name: 'x'.repeat(500), description: 'z'.repeat(20000),
    allowed_activities: ['ARTICLE', 'article', 'bad/token', 'x'.repeat(70)] });
  assert.ok(validTaskCreatePayload(payload));
  assert.deepEqual(payload.requiredCapabilities, ['article']);
  assert.match(payload.description, /does not trigger payment/);
});
test('invalid monetary values are not presented as rates or funds', () => {
  const payload = formatPromotedByTask({ ...opportunity, max_per_result_cents: -1, available_cents: Infinity,
    rates: { article: NaN, listing: -5 } });
  assert.doesNotMatch(payload.reward + payload.description, /NaN|Infinity|\$-/);
});
test('identity is derived from the private key, not an unset public-key property', async () => {
  const keys = await generateAgentKeyPair();
  assert.deepEqual(await partnerSigningIdentity(keys.signingPrivateKey, keys.agentId),
    { agentId: keys.agentId, signingPublicKey: keys.signingPublicKey, signingPrivateKey: keys.signingPrivateKey });
  await assert.rejects(partnerSigningIdentity(keys.signingPrivateKey, 'agent_wrong'), /Invalid partner signing identity/);
  await assert.rejects(partnerSigningIdentity(keys.encryptionPrivateKey), /Invalid partner signing identity/);
});
test('normal publish signs, validates nested acknowledgment and reruns without HTTP', async t => {
  const f = await fixture(t);
  const [created] = await syncPromotedByTasks({ ...f.options, initialize: true });
  assert.equal(created.status, 'created'); assert.match(created.taskId, /^task_[a-f0-9]{16}$/);
  const count = f.calls.length;
  assert.deepEqual(await syncPromotedByTasks(f.options), [{ ...created, status: 'already_synced' }]);
  assert.equal(f.calls.length, count); assert.equal(f.committed.size, 1);
  for (const name of await readdir(f.stateDir)) assert.ok(!(await readFile(join(f.stateDir, name), 'utf8')).includes(f.keys.signingPrivateKey));
});
test('same product name with different campaign IDs creates independent tasks', async t => {
  const f = await fixture(t);
  await syncPromotedByTasks({ ...f.options, initialize: true });
  f.state.feed = [{ ...opportunity, id: 'cmp_another' }];
  await syncPromotedByTasks({ ...f.options, campaignId: 'cmp_another' });
  assert.equal(f.committed.size, 2);
  assert.ok(f.calls.every(c => !c.url.includes('/v1/tasks?')));
});
test('lost response stops default reruns; explicit retry preserves the exact wire and ID', async t => {
  const f = await fixture(t); f.state.fail = true;
  await assert.rejects(syncPromotedByTasks({ ...f.options, initialize: true }));
  const first = f.calls.find(c => c.method === 'POST').body;
  await assert.rejects(syncPromotedByTasks(f.options), /Pending task outcome/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  f.state.fail = false; f.state.feed = [{ ...opportunity, description: 'Changed after uncertain commit' }];
  await syncPromotedByTasks({ ...f.options, retryPending: true });
  assert.equal(f.calls.filter(c => c.method === 'POST')[1].body, first);
  assert.equal(f.committed.size, 1);
});
test('expired pending proof is never replaced or posted', async t => {
  const f = await fixture(t);
  const journal = openPartnerJournal(f.stateDir, { version: 1, hub: hubUrl, source: apiUrl, signingPublicKey: f.keys.signingPublicKey }, true);
  const wire = await prepareHubTask(f.keys, formatPromotedByTask(opportunity), Date.now() - 300001);
  journal.reserve(opportunity.id, { campaignId: opportunity.id, wire }); journal.close();
  await assert.rejects(syncPromotedByTasks({ ...f.options, retryPending: true }), /expired/);
  assert.equal(f.calls.length, 0);
});
test('bad acknowledgment retains pending state and surfaces failure', async t => {
  const f = await fixture(t); f.state.badAck = true;
  await assert.rejects(syncPromotedByTasks({ ...f.options, initialize: true }), /Uncorrelated/);
  await assert.rejects(syncPromotedByTasks(f.options), /Pending/);
  assert.ok(!(await readdir(f.stateDir)).some(n => n.endsWith('.ack.json')));
});
test('partial intent or altered acknowledgment never triggers network recovery', async t => {
  for (const suffix of ['.intent.json', '.ack.json']) {
    const f = await fixture(t);
    await syncPromotedByTasks({ ...f.options, initialize: true });
    const name = (await readdir(f.stateDir)).find(n => n.endsWith(suffix));
    await writeFile(join(f.stateDir, name), suffix === '.intent.json' ? '{' : '{"wireHash":"altered"}');
    const count = f.calls.length;
    await assert.rejects(syncPromotedByTasks({ ...f.options, retryPending: true }));
    assert.equal(f.calls.length, count);
    assert.equal(f.committed.size, 1);
  }
});
test('scope mismatch, repeat initialization, concurrency and unsafe permissions fail closed', async t => {
  const f = await fixture(t);
  await syncPromotedByTasks({ ...f.options, initialize: true });
  await assert.rejects(syncPromotedByTasks({ ...f.options, hubUrl: 'https://other.invalid' }));
  await assert.rejects(syncPromotedByTasks({ ...f.options, initialize: true }));
  const journal = openPartnerJournal(f.stateDir, { version: 1, hub: hubUrl, source: apiUrl, signingPublicKey: f.keys.signingPublicKey });
  try { await assert.rejects(syncPromotedByTasks(f.options)); } finally { journal.close(); }
  await chmod(f.stateDir, 0o755);
  await assert.rejects(syncPromotedByTasks(f.options));
});
test('symlinked journal and journal inside checkout are rejected', async t => {
  const f = await fixture(t);
  const alias = f.stateDir + '-alias'; await symlink(f.stateDir, alias); t.after(() => rm(alias));
  await assert.rejects(syncPromotedByTasks({ ...f.options, stateDir: alias, initialize: true }));
  const checkoutDir = await mkdtemp(fileURLToPath(new URL('../.partner-test-', import.meta.url)));
  t.after(() => rm(checkoutDir, { recursive: true, force: true }));
  await assert.rejects(syncPromotedByTasks({ ...f.options, stateDir: checkoutDir, initialize: true }));
});
test('dry-run needs no identity, does not create state and only fetches the feed', async t => {
  const f = await fixture(t);
  const result = await syncPromotedByTasks({ apiUrl, hubUrl, fetch: f.options.fetch, dryRun: true });
  assert.equal(result[0].status, 'dry_run'); assert.equal(f.calls.length, 1);
  assert.deepEqual(await readdir(f.stateDir), []);
});
test('failed feed or registration reads do not authorize publishing', async t => {
  for (const failAt of ['feed', 'registration']) {
    const f = await fixture(t);
    const fetch = (url, init) => url.endsWith(failAt) ? Response.json({ error: 'PRIVATE' }, { status: 503 }) : f.options.fetch(url, init);
    await assert.rejects(syncPromotedByTasks({ ...f.options, fetch, initialize: true }));
    assert.equal(f.committed.size, 0);
    assert.ok(!(await readdir(f.stateDir)).some(n => n.endsWith('.intent.json')));
  }
});
test('duplicate, missing or excessive feed IDs fail closed', async () => {
  for (const entries of [[opportunity, opportunity], [{ ...opportunity, id: undefined }], Array.from({ length: 101 }, (_, i) => ({ ...opportunity, id: `c${i}` }))]) {
    await assert.rejects(fetchOpportunities(apiUrl, async () => Response.json({ opportunities: entries })));
  }
});
test('transport rejects redirects, oversized, invalid UTF-8 and slow bodies without raw error prose', async () => {
  for (const response of [new Response('', { status: 302, headers: { location: 'https://other.invalid' } }),
    new Response('x'.repeat(17), { headers: { 'content-type': 'application/json' } }),
    new Response(Uint8Array.of(255), { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(partnerJson(apiUrl, {}, { fetch: async () => response, maxBytes: 16 }), /Partner request failed/);
  }
  let cancelled = false;
  await assert.rejects(partnerJson(apiUrl, {}, { timeoutMs: 10, fetch: async () => new Response(new ReadableStream({
    pull() {}, cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { 'content-type': 'application/json' } }) }), /Partner request failed/);
  assert.equal(cancelled, true);
});
test('CLI returns nonzero for per-item errors and never echoes secrets', async () => {
  assert.equal((await runPartnerCli([], async () => [{ status: 'error' }])).code, 1);
  assert.equal((await runPartnerCli([], async () => { throw new Error('PRIVATE_KEY_SENTINEL'); })).code, 1);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./sync-promotedby-tasks.mjs', import.meta.url)), '--key', 'PRIVATE_KEY_SENTINEL'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_KEY_SENTINEL/);
});
test('documented registration example produces a valid v2 proof; CI includes this suite', async () => {
  const doc = await readFile(new URL('../docs/partner-bounty-ingestion.md', import.meta.url), 'utf8');
  const snippet = doc.match(/<!-- partner-registration-example -->\s*```js\n([\s\S]*?)\n```/)[1];
  const identity = await generateAgentKeyPair();
  const run = new Function('signProfileRegistration', 'identity', 'hub', 'registrationState', 'now', `return (async () => { ${snippet}; return proof; })();`);
  const proof = await run(signProfileRegistration, identity, hubUrl, { revision: 0 }, Date.now());
  assert.ok(await verifyProfileRegistration(proof, hubUrl));
  assert.equal(proof.profile.metadata.website, 'https://partner.example');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /pnpm test:partner-ingestion/);
  assert.match(pkg.scripts['test:partner-ingestion'], /sync-promotedby-tasks.test.mjs/);
});
