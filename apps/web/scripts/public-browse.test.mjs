import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';
import { parse } from 'parse5';
import { micromark } from 'micromark';
import { generateAgentKeyPair, signEnvelope, canonicalizeJson, signTaskAction } from '@openagentforum/protocol';
import { inspectPage } from './check-seo.mjs';
import { taskClaimExample } from '../src/data/task-signing.mjs';

let mf, worker, scratch, author, runtimeOptions;
let outbound = 0;
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
const origin = 'https://openagentforum.com';
const nodes = node => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const attr = (node, key) => node.attrs?.find(a => a.name === key)?.value;
const elements = html => nodes(parse(html));
const ids = html => elements(html).filter(n => attr(n, 'data-record-id')).map(n => attr(n, 'data-record-id'));
const links = html => elements(html).filter(n => n.tagName === 'a').map(n => attr(n, 'href'));
const markdownPath = path => { const [pathname, query] = path.split('?'); return pathname + 'index.md' + (query ? '?' + query : ''); };
const representations = path => [path, markdownPath(path)];
const markdownHtml = text => micromark(text, { allowDangerousHtml: true });
const nodeText = node => (node.value ?? '') + (node.childNodes ?? []).map(nodeText).join('');
const markdownIds = text => elements(markdownHtml(text)).filter(n => n.tagName === 'h2' && nodeText(n).startsWith('Message ')).map(n => nodeText(n).slice(8));
const sql = async statements => {
  const response = await worker.fetch('https://fixture.invalid/sql', { method: 'POST', body: JSON.stringify(statements), signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const results = await response.json();
  assert.ok(results.every(r => r.success));
  return results;
};
const channel = (name = 'general', policy = {}) => sql([{ sql: 'INSERT INTO channels (name,title,topic,creator_id,created_at,is_private,e2ee_required,allowed_agents_json) VALUES (?,?,?,?,?,?,?,?)',
  args: [name, policy.title ?? 'Public discussion', policy.topic ?? 'A place to ask questions', 'fixture', 1, policy.private ?? 0, policy.encrypted ?? 0, Object.hasOwn(policy, 'members') ? policy.members : '[]'] }]);
async function message(position, { channel: name = 'general', id = `${name}-${position}`, payload = { message: `Public message ${position}` }, sequence = 900 - position, ...options } = {}) {
  const signed = await signEnvelope({ id, channel: name, sender: author.agentId, type: options.type ?? 'intel', sequence, timestamp: options.timestamp, payload }, author.signingPrivateKey);
  await sql([{ sql: 'INSERT INTO messages (id,channel,sender,type,sequence,stored_seq,timestamp,payload_json,signature,checksum,reply_to_id,encrypted,nonce,ephemeral_public_key,recipient_keys_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    args: [signed.id, name, author.agentId, options.type ?? 'intel', sequence, position, options.timestamp ?? signed.timestamp,
      options.rawPayload ?? canonicalizeJson(payload), options.signature ?? signed.signature, signed.checksum, options.replyToId ?? null, options.encrypted ?? 0, options.nonce ?? null, options.ephemeral ?? null, options.recipients ?? null] }]);
  return signed;
}
async function get(path, options = {}) {
  const response = await worker.fetch(origin + path, { ...options, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  assert.equal(outbound, 0, 'public reader must never make outbound requests');
  assert.ok(Buffer.byteLength(text) < (path.startsWith('/sitemap-public') ? 4 * 1024 * 1024 : 512 * 1024));
  return { response, text };
}

before(async () => {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  scratch = await mkdtemp(join(tmpdir(), 'oaf-public-browse-'));
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const shell = await readFile(new URL('../dist/channels/index.html', import.meta.url), 'utf8');
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/public-browse-worker.mjs', import.meta.url))], bundle: true,
    write: false, format: 'esm', platform: 'neutral', metafile: true, external: ['node:*', 'cloudflare:*'] });
  assert.ok(Object.values(bundle.metafile.outputs).every(o => o.imports.length === 0));
  runtimeOptions = { host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
    telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'),
    workers: [{ config: { type: 'worker', name: 'public-browse-test', compatibilityDate: config.compatibility_date, compatibilityFlags: [],
      workersDev: false, previewUrls: false, domains: [], triggers: [],
      env: { DB: { type: 'd1', id: 'public-browse-local', dev: { remote: false } }, SHELL_HTML: { type: 'text', value: shell } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { outbound++; throw new Error('No outbound requests allowed'); } } } }],
  };
  mf = new Miniflare(runtimeOptions);
  await mf.ready; worker = await mf.getWorker('public-browse-test');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    const schema = (await readFile(new URL(file, migrations), 'utf8')).replace(/^\s*--.*$/gm, '');
    const trigger = schema.indexOf('CREATE TRIGGER ');
    const ordinary = trigger < 0 ? schema : schema.slice(0, trigger);
    await sql(ordinary.split(';').filter(s => s.trim()).map(statement => ({ sql: statement })));
    if (trigger >= 0) await sql([{ sql: schema.slice(trigger) }]);
  }
  author = await generateAgentKeyPair();
});
after(async () => {
  await mf?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
  else process.env.MINIFLARE_WORKERD_PATH = previousRuntime;
});
beforeEach(async () => {
  await sql(['DELETE FROM tasks', 'DELETE FROM messages', 'DELETE FROM channels', 'DELETE FROM agents', 'DELETE FROM public_message_arrivals',
    'UPDATE public_recent_state SET high_seq=0', "DELETE FROM sqlite_sequence WHERE name='public_message_arrivals'"].map(statement => ({ sql: statement })));
  await sql([{ sql: 'INSERT INTO agents (agent_id,name,public_key,registered_at,last_seen_at) VALUES (?,?,?,?,?)', args: [author.agentId, 'Fixture author', author.signingPublicKey, 1, 1] }]);
  await channel();
});

test('native Pages/D1 renders linked public channels inside the actual built shell', async () => {
  const { response, text } = await get('/channels/');
  assert.equal(response.status, 200);
  assert.ok(links(text).includes('/channels/general/'));
  assert.match(text, /Public discussion/);
  assert.match(text, /data-participation-invite/);
  assert.doesNotMatch(text, /static preview has no public record|skeleton/);
  assert.equal(response.headers.get('x-fixture-queries'), '1');
});

test('native record rendering preserves author sequence and verifies as stored', async () => {
  const signed = await message(7);
  const { response, text } = await get('/channels/general/');
  assert.equal(response.status, 200);
  assert.deepEqual(ids(text), [signed.id]);
  assert.match(text, /fingerprint and signature verified as stored/);
  assert.match(text, /Author sequence: 893/);
  assert.match(text, /Unsigned relay position: 7/);
  assert.ok(links(text).includes(`/channels/general/messages/${signed.id}/`));
  assert.equal(response.headers.get('x-fixture-queries'), '2');
});

test('records written through the actual Pages API are readable and verified, including URN IDs', async () => {
  const peer = await generateAgentKeyPair();
  const post = (path, body) => worker.fetch(`https://fixture.invalid/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const registered = await post('agents/register', { name: 'Browse journey fixture', publicKey: peer.signingPublicKey });
  assert.equal(registered.status, 200);
  const signed = await signEnvelope({ id: 'urn:uuid:6ba7b810-9dad-11d1-80b4-00c04fd430c8', channel: 'general', sender: peer.agentId, type: 'intel', sequence: 37, payload: { message: 'Hello from the local Pages journey' } }, peer.signingPrivateKey);
  const written = await post('channels/general/messages', signed);
  assert.equal(written.status, 200);
  const saved = (await written.json()).envelope;
  const { response, text } = await get(`/channels/general/messages/${encodeURIComponent(saved.id)}/`);
  assert.equal(response.status, 200);
  assert.deepEqual(ids(text), [signed.id]);
  assert.match(text, /fingerprint and signature verified as stored/);
  assert.match(text, /Author sequence: 37/);
  assert.ok(elements(text).some(n => attr(n, 'id') === `message-${signed.id}`));
});

test('documented claim example and signed task lifecycle work on native Pages/D1 without outbound requests', async () => {
  const peer = await generateAgentKeyPair();
  const post = (path, body) => worker.fetch(`https://fixture.invalid/v1/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const readTasks = async () => {
    const response = await worker.fetch('https://fixture.invalid/v1/tasks?status=all', { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    return (await response.json()).tasks;
  };
  assert.deepEqual(await readTasks(), []);
  const counts = await sql([{ sql: 'SELECT COUNT(*) AS count FROM agents' }]);
  assert.equal(counts[0].results[0].count, 1, 'Anonymous task reading must not register an agent');
  assert.equal((await post('agents/register', { name: 'Task guide fixture', publicKey: peer.signingPublicKey })).status, 200);

  const createPayload = { title: 'Review local documentation', description: 'Local task-signing fixture only', requiredCapabilities: [], timeoutMs: 3600000, reward: null };
  const timestamp = Date.now();
  const createBody = { creatorId: author.agentId, ...createPayload, timestamp,
    signature: await signTaskAction({ action: 'create', taskId: '-', agentId: author.agentId, timestamp, payload: createPayload }, author.signingPrivateKey) };
  assert.equal((await post('tasks', { ...createBody, signature: undefined })).status, 401);
  assert.equal((await post('tasks', { ...createBody, title: 'Tampered title' })).status, 403);
  assert.deepEqual(await readTasks(), []);
  const created = await post('tasks', createBody);
  assert.equal(created.status, 200);
  const taskId = (await created.json()).task.id;
  assert.equal((await (await post('tasks', createBody)).json()).alreadyCreated, true);

  // Execute only our trusted static documentation excerpt, copied from the real
  // built HTML. No downloaded/community code, network client or persistent key.
  const html = await readFile(new URL('../dist/tasks/index.html', import.meta.url), 'utf8');
  const example = elements(html).find(n => n.tagName === 'pre' && attr(n, 'data-task-claim-example') !== undefined);
  assert.ok(example);
  const code = nodeText(example);
  assert.equal(code, taskClaimExample);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const makeClaim = new AsyncFunction('signTaskAction', 'identity', 'taskId', `${code}\nreturn body;`);
  const claimBody = await makeClaim(signTaskAction, peer, taskId);
  assert.deepEqual(Object.keys(claimBody).sort(), ['agentId', 'signature', 'timestamp']);
  assert.equal((await post(`tasks/${taskId}/claim`, { ...claimBody, signature: undefined })).status, 401);
  assert.equal((await post(`tasks/${taskId}/claim`, { ...claimBody, agentId: author.agentId })).status, 403);
  for (const offset of [-6 * 60_000, 6 * 60_000]) {
    const stale = Date.now() + offset;
    const signature = await signTaskAction({ action: 'claim', taskId, agentId: peer.agentId, timestamp: stale, payload: {} }, peer.signingPrivateKey);
    assert.equal((await post(`tasks/${taskId}/claim`, { agentId: peer.agentId, timestamp: stale, signature })).status, 403);
  }
  const claimed = await post(`tasks/${taskId}/claim`, claimBody);
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).claimedBy, peer.agentId);

  const resultPayload = { message: 'Documentation fixture complete', evidence: 'Local only' };
  const submission = { agentId: peer.agentId, resultPayload, timestamp: Date.now() };
  submission.signature = await signTaskAction({ action: 'submit', taskId, agentId: peer.agentId,
    timestamp: submission.timestamp, payload: { resultPayload } }, peer.signingPrivateKey);
  assert.equal((await post(`tasks/${taskId}/submit`, { ...submission, signature: undefined })).status, 401);
  assert.equal((await post(`tasks/${taskId}/submit`, { ...submission, resultPayload: { message: 'Tampered result' } })).status, 403);
  const outsider = { ...submission, agentId: author.agentId, signature: await signTaskAction({ action: 'submit', taskId,
    agentId: author.agentId, timestamp: submission.timestamp, payload: { resultPayload } }, author.signingPrivateKey) };
  assert.equal((await post(`tasks/${taskId}/submit`, outsider)).status, 400);
  assert.equal((await post(`tasks/${taskId}/submit`, submission)).status, 200);
  const replacement = { message: 'Cannot rewrite the accepted result' };
  const replacementSignature = await signTaskAction({ action: 'submit', taskId, agentId: peer.agentId,
    timestamp: submission.timestamp, payload: { resultPayload: replacement } }, peer.signingPrivateKey);
  assert.equal((await post(`tasks/${taskId}/submit`, { ...submission, resultPayload: replacement, signature: replacementSignature })).status, 409);
  const tasks = await readTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'completed');
  assert.deepEqual(tasks[0].resultPayload, resultPayload);
  assert.equal(outbound, 0, 'The task journey must remain inside the local fixture');
});

test('stable permalinks keep the same record after later arrivals', async () => {
  const signed = await message(1);
  const path = `/channels/general/messages/${signed.id}/`;
  assert.deepEqual(ids((await get(path)).text), [signed.id]);
  await message(2);
  assert.deepEqual(ids((await get(path)).text), [signed.id]);
});

test('channel pagination uses bounded relay order, not author sequence or timestamp', async () => {
  const signed = [];
  for (let n = 1; n <= 23; n++) signed.push(await message(n, { timestamp: 1 }));
  const latest = await get('/channels/general/');
  assert.deepEqual(ids(latest.text), signed.slice(3).map(m => m.id));
  assert.ok(links(latest.text).includes('/channels/general/?before=4'));
  await message(24);
  const older = await get('/channels/general/?before=4');
  assert.deepEqual(ids(older.text), signed.slice(0, 3).map(m => m.id));
  assert.equal(older.response.headers.get('x-robots-tag'), 'noindex, follow');
});

test('safe-integer cursor edge, gaps and empty pages keep honest continuation', async () => {
  const signed = await message(Number.MAX_SAFE_INTEGER, { sequence: 42 });
  assert.deepEqual(ids((await get('/channels/general/')).text), [signed.id]);
  for (const before of ['1', '50', String(Number.MAX_SAFE_INTEGER)]) {
    const { response, text } = await get(`/channels/general/?before=${before}`);
    assert.equal(response.status, 200); assert.deepEqual(ids(text), []);
    assert.match(text, /No eligible public messages on this page/);
    assert.ok(!links(text).some(href => href.startsWith('/channels/general/?before=')));
    assert.ok(links(text).includes('/channels/general/'));
  }
});

test('privacy is rechecked on every read; a once-public page is not cached as public', async () => {
  const signed = await message(1, { payload: { message: 'Previously public fixture' } });
  const path = `/channels/general/messages/${signed.id}/`;
  assert.equal((await get(path)).response.status, 200);
  await sql([{ sql: 'UPDATE channels SET is_private=1 WHERE name=?', args: ['general'] }]);
  for (const target of [path, '/channels/general/']) {
    const { response, text } = await get(target);
    assert.equal(response.status, 404);
    assert.doesNotMatch(text, /Previously public fixture/);
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  }
  assert.ok(!links((await get('/channels/')).text).includes('/channels/general/'));
});

test('directory pagination omits private names and has stable alphabetical continuation', async () => {
  for (let n = 0; n < 27; n++) await channel(`topic-${String(n).padStart(2, '0')}`);
  await channel('hidden-title', { private: 1 });
  const first = await get('/channels/');
  assert.ok(links(first.text).includes('/channels/?after=topic-23'));
  assert.doesNotMatch(first.text, /hidden-title/);
  await channel('earlier');
  const next = await get('/channels/?after=topic-23');
  assert.ok(links(next.text).includes('/channels/topic-26/'));
  assert.ok(!links(next.text).includes('/channels/earlier/'));
});

test('privacy flags, memberships and legacy protected names fail closed with indistinguishable 404s', async () => {
  for (const [name, policy] of [['secret-room', { private: 1 }], ['cipher-room', { encrypted: 1 }], ['members-room', { members: '["private-member"]' }], ['ambiguous-room', { members: null }], ['dm-legacy', {}], ['vault-legacy', {}]]) {
    await channel(name, { ...policy, title: 'PRIVATE_TITLE', topic: 'PRIVATE_TOPIC' });
    const signed = await message(1, { channel: name, payload: { message: 'PRIVATE_BODY' } });
    for (const path of [`/channels/${name}/`, `/channels/${name}/messages/${signed.id}/`].flatMap(representations)) {
      const result = await get(path);
      assert.equal(result.response.status, 404);
      assert.doesNotMatch(result.text, /PRIVATE_|private-member/);
    }
  }
  for (const path of representations('/channels/')) assert.doesNotMatch((await get(path)).text, /PRIVATE_|secret-room|cipher-room|members-room|dm-legacy|vault-legacy/);
});

test('encrypted envelopes and encryption metadata never enter public record HTML', async () => {
  for (const [n, options] of [[1, { encrypted: 1 }], [2, { nonce: 'a'.repeat(24) }], [3, { ephemeral: 'a'.repeat(64) }], [4, { recipients: '{}' }], [5, { type: 'e2ee_blob' }]]) {
    const signed = await message(n, { ...options, payload: { message: 'HIDDEN_CIPHERTEXT' } });
    for (const path of representations(`/channels/general/messages/${signed.id}/`)) assert.equal((await get(path)).response.status, 404);
  }
  for (const path of representations('/channels/general/')) assert.doesNotMatch((await get(path)).text, /HIDDEN_CIPHERTEXT/);
});

test('malicious payloads and channel metadata remain inert text without external links or embeds', async () => {
  const attack = '</pre></section><script>alert(1)</script><img src="https://evil.invalid/track" onerror="alert(2)">';
  await sql([{ sql: 'UPDATE channels SET title=?,topic=? WHERE name=?', args: [attack, attack, 'general'] }]);
  await message(1, { payload: { message: attack } });
  const { text } = await get('/channels/general/');
  assert.match(text, /&lt;script&gt;alert/);
  assert.ok(!elements(text).some(n => attr(n, 'src')?.includes('evil.invalid') || attr(n, 'onerror')));
  assert.equal(elements(text).filter(n => attr(n, 'data-public-record') !== undefined).length, 1);
});

test('signed reply references differ from unsigned legacy replyToId', async () => {
  const parent = await message(1);
  await message(2, { payload: { message: 'Reply', inReplyTo: parent.id }, replyToId: 'forged-parent' });
  const { text } = await get('/channels/general/');
  assert.match(text, /Verified signed reply reference/);
  assert.match(text, /Unsigned legacy replyToId: forged-parent/);
  assert.ok(!links(text).some(href => href?.includes('forged-parent')));
});

test('invalid signatures, changed payloads and mismatched registry keys never authenticate replies', async () => {
  await message(1, { payload: { message: 'Forgery', inReplyTo: 'parent' }, signature: '00'.repeat(64) });
  await message(2, { rawPayload: '{"message":"Changed","inReplyTo":"parent"}' });
  const { text } = await get('/channels/general/');
  assert.doesNotMatch(text, /Verified signed reply reference|fingerprint and signature verified as stored/);
  assert.match(text, /Unverified payload reply reference/);
  const valid = await message(3, { payload: { message: 'Valid at first', inReplyTo: 'parent' } });
  const path = `/channels/general/messages/${valid.id}/`;
  assert.match((await get(path)).text, /Verified signed reply reference/);
  await sql([{ sql: 'UPDATE agents SET public_key=?', args: ['11'.repeat(32)] }]);
  assert.doesNotMatch((await get(path)).text, /Verified signed reply reference|fingerprint and signature verified as stored/);
  await sql([{ sql: 'DELETE FROM agents' }]);
  assert.doesNotMatch((await get(path)).text, /Verified signed reply reference|fingerprint and signature verified as stored/);
});

test('oversized and malformed payloads are omitted honestly without verifying a truncated envelope', async () => {
  await message(1, { rawPayload: 'x'.repeat(17_000) });
  await message(2, { rawPayload: '{malformed' });
  const { text } = await get('/channels/general/');
  assert.match(text, /Payload omitted from this bounded view/);
  assert.doesNotMatch(text, /fingerprint and signature verified as stored/);
});

test('a truncated signed type cannot masquerade as verification of the stored envelope', async () => {
  const signed = await message(1, { type: 't'.repeat(65) });
  await sql([{ sql: 'UPDATE messages SET type=? WHERE id=?', args: ['t'.repeat(66), signed.id] }]);
  assert.doesNotMatch((await get('/channels/general/')).text, /fingerprint and signature verified as stored/);
});

test('SQLite NUL truncation cannot make malformed legacy signed fields appear complete', async () => {
  for (const [n, field] of [[1, 'type'], [2, 'signature'], [3, 'checksum']]) {
    const signed = await message(n);
    await sql([{ sql: `UPDATE messages SET ${field}=? WHERE id=?`, args: [signed[field] + '\0suffix', signed.id] }]);
    assert.doesNotMatch((await get(`/channels/general/messages/${signed.id}/`)).text, /fingerprint and signature verified as stored/);
  }
  const payload = { message: 'Prefix is not the complete stored JSON' };
  const broken = await message(4, { payload, rawPayload: canonicalizeJson(payload) + '\0suffix' });
  const brokenPage = (await get(`/channels/general/messages/${broken.id}/`)).text;
  assert.match(brokenPage, /Payload omitted/);
  assert.doesNotMatch(brokenPage, /Prefix is not|fingerprint and signature verified as stored/);
  const valid = await message(5);
  await sql([{ sql: 'UPDATE agents SET public_key=?', args: [author.signingPublicKey + '\0suffix'] }]);
  assert.doesNotMatch((await get(`/channels/general/messages/${valid.id}/`)).text, /fingerprint and signature verified as stored/);
});

test('browse indexes exclude embedded NUL identifiers and noninteger relay positions', async () => {
  await channel('nul-channel\0suffix');
  await message(1, { id: 'nul-id\0suffix' });
  await message(1.5, { id: 'fractional-position' });
  assert.doesNotMatch((await get('/channels/')).text, /nul-channel/);
  const { response, text } = await get('/channels/general/');
  assert.equal(response.status, 200); assert.deepEqual(ids(text), []);
  assert.doesNotMatch(text, /nul-id|fractional-position/);
});

test('HEAD and browsing never change storage or acknowledge anything', async () => {
  const signed = await message(1);
  const snapshot = () => sql(['SELECT * FROM messages', 'SELECT * FROM agents', 'SELECT * FROM channels', 'SELECT * FROM wake_message_outbox'].map(statement => ({ sql: statement })));
  const before = (await snapshot()).map(r => r.results);
  for (const path of ['/channels/', '/channels/general/', `/channels/general/messages/${signed.id}/`].flatMap(representations)) {
    const head = await get(path, { method: 'HEAD' });
    assert.equal(head.response.status, 200); assert.equal(head.text, '');
    assert.equal((await get(path)).response.status, 200);
  }
  assert.deepEqual((await snapshot()).map(r => r.results), before);
});

test('write methods fail before database reads and are not GET-write aliases', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) for (const path of representations('/channels/')) {
    const { response } = await get(path, { method });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(response.headers.get('x-fixture-queries'), '0');
  }
});

test('invalid cursors, duplicate/unknown queries and encoded separators are rejected without reflection', async () => {
  for (const path of ['/channels/?action=register', '/channels/?after=a&after=b', '/channels/general/?before=-1', '/channels/general/?before=0', '/channels/general/?before=1e2', '/channels/general/?before=9007199254740992', '/channels/general/?before=', '/channels/general/?token=PRIVATE_QUERY', '/channels/general%2fmessages%2fguess/']) {
    const { response, text } = await get(path);
    assert.equal(response.status, 400, path); assert.equal(response.headers.get('x-fixture-queries'), '0');
    assert.doesNotMatch(text, /PRIVATE_QUERY|action=register/);
  }
});

test('canonical redirects are read-only and missing records have useful noindex responses', async () => {
  const { response } = await get('/channels/general', { redirect: 'manual' });
  assert.equal(response.status, 308); assert.equal(response.headers.get('location'), '/channels/general/');
  assert.equal(response.headers.get('x-fixture-queries'), '0');
  for (const path of ['/channels/missing/', '/channels/general/messages/missing/', '/channels/general/extra/']) {
    const result = await get(path); assert.equal(result.response.status, 404);
    assert.equal(result.response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.ok(links(result.text).includes('/start/'));
  }
});

test('missing D1, storage failures and missing migration return 503 without stale fallback', async () => {
  for (const mode of ['missing', 'failure']) {
    const { response, text } = await get('/channels/', { headers: { 'x-fixture-db': mode } });
    assert.equal(response.status, 503); assert.doesNotMatch(text, /PRIVATE_STORAGE_ERROR|Public discussion/);
  }
  await sql([{ sql: 'DROP INDEX idx_channels_public_browse' }]);
  assert.equal((await get('/channels/')).response.status, 503);
  const migration = (await readFile(new URL('../migrations/0006_public_browse.sql', import.meta.url), 'utf8')).replace(/^\s*--.*$/gm, '');
  await sql(migration.split(';').filter(s => s.trim()).map(statement => ({ sql: statement })));
});

test('template failures and response bounds fail closed without leaking infrastructure details', async () => {
  for (const mode of ['failure', 'oversize', 'missing', 'type']) {
    const { response, text } = await get('/channels/', { headers: { 'x-fixture-assets': mode } });
    assert.equal(response.status, 503); assert.doesNotMatch(text, /PRIVATE_ASSET_ERROR/); assert.ok(links(text).includes('/start/'));
  }
});

test('template outages do not turn invalid requests into successes or lose method restrictions', async () => {
  for (const [path, method, expected] of [['/channels/', 'POST', 405], ['/channels/?write=1', 'GET', 400], ['/channels/missing/', 'GET', 404]]) {
    const { response } = await get(path, { method, headers: { 'x-fixture-assets': 'failure' } });
    assert.equal(response.status, expected);
    if (expected === 405) assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(response.headers.get('retry-after'), null);
  }
});

test('preview origins and paged HTML remain noindex with production canonical links', async () => {
  const preview = await worker.fetch('https://preview.example/channels/');
  assert.equal(preview.headers.get('x-robots-tag'), 'noindex, follow');
  for (const path of ['/channels/?after=general', '/channels/general/?before=5']) {
    const { response, text } = await get(path);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, follow');
    assert.ok(elements(text).some(n => attr(n, 'rel') === 'canonical' && attr(n, 'href') === origin + path));
    assert.ok(elements(text).some(n => attr(n, 'name') === 'robots' && attr(n, 'content') === 'noindex, follow'));
  }
});

test('bounded projections and escaped text keep a maximum-sized page small', async () => {
  await sql([{ sql: 'UPDATE channels SET title=?,topic=?', args: ['x'.repeat(30_000), 'y'.repeat(30_000)] }]);
  for (let n = 1; n <= 21; n++) await message(n, { payload: { message: '&'.repeat(12_000) } });
  const { response, text } = await get('/channels/general/');
  assert.equal(response.status, 200); assert.equal(ids(text).length, 20);
  assert.ok(Buffer.byteLength(text) < 256 * 1024);
  assert.doesNotMatch(text, /x{161}|y{1001}/);
  assert.equal((text.match(/Display is truncated or omitted/g) ?? []).length, 20);
});

test('HTML responses set their own security, freshness and SEO headers and strip template cookies', async () => {
  const { response, text } = await get('/channels/general/', { headers: { cookie: 'private=1', authorization: 'Bearer fixture-only', 'if-none-match': 'anything' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('etag'), null);
  assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
  assert.ok(elements(text).some(n => n.tagName === 'link' && attr(n, 'rel') === 'canonical' && attr(n, 'href') === origin + '/channels/general/'));
});

test('query plans use partial browse indexes instead of full history scans', async () => {
  const signed = await message(1);
  for (const [path, index] of [['/channels/', 'idx_channels_public_browse'], ['/channels/general/', 'idx_messages_public_browse'], [`/channels/general/messages/${signed.id}/`, 'sqlite_autoindex_messages_1']]) {
    const { response } = await get(path, { headers: { 'x-fixture-plans': '1' } });
    const details = JSON.parse(response.headers.get('x-fixture-plans')).flat().join('\n');
    assert.ok(details.includes(index), details);
    assert.doesNotMatch(details, /USE TEMP B-TREE|SCAN messages|SCAN m\b|SCAN channels/);
  }
});

test('Markdown shares HTML records, attribution, ordering, verification and bounded text', async () => {
  const signed = [];
  for (let n = 1; n <= 22; n++) signed.push(await message(n, { timestamp: 1 }));
  const html = await get('/channels/general/');
  const markdown = await get('/channels/general/index.md');
  assert.equal(markdown.response.status, 200);
  assert.deepEqual(markdownIds(markdown.text), ids(html.text));
  assert.equal(markdown.response.headers.get('x-fixture-queries'), '2');
  assert.equal(markdown.response.headers.get('x-fixture-assets'), '0');
  assert.match(markdown.text, /Author sequence: 897\. Unsigned relay position: 3/);
  assert.match(markdown.text, /Author timestamp: 1970-01-01T00:00:00\.001Z/);
  assert.match(markdown.text, /checksum, signing-key fingerprint and signature verified as stored/);
  assert.match(markdown.text, /"sender":"agent_[a-f0-9]{16}","type":"intel"/);
  assert.match(markdown.text, /original envelope JSON|not the signed envelope/);
  assert.ok(links(markdownHtml(markdown.text)).includes(origin + '/channels/general/index.md?before=3'));
  await message(23);
  const older = await get('/channels/general/index.md?before=3');
  assert.deepEqual(markdownIds(older.text), signed.slice(0, 2).map(m => m.id));
  assert.deepEqual(markdownIds(older.text), ids((await get('/channels/general/?before=3')).text));
});

test('Markdown directory shares alphabetical continuation and channel metadata with HTML', async () => {
  for (let n = 0; n < 26; n++) await channel(`topic-${String(n).padStart(2, '0')}`, { title: `Title ${n}`, topic: 'Untrusted topic' });
  const { response, text } = await get('/channels/index.md');
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-fixture-queries'), '1');
  assert.equal(response.headers.get('x-fixture-assets'), '0');
  const urls = links(markdownHtml(text));
  assert.ok(urls.includes(origin + '/channels/index.md?after=topic-23'));
  for (const path of links((await get('/channels/')).text).filter(p => /^\/channels\/[a-z0-9_-]+\/$/.test(p))) assert.ok(urls.includes(origin + markdownPath(path)));
  const next = (await get('/channels/index.md?after=topic-23')).text;
  assert.match(next, /Title 24/); assert.doesNotMatch(next, /Title 23/);
});

test('HTML and Markdown alternates preserve exact cursor and canonical identity', async () => {
  const signed = await message(1, { id: 'urn:uuid:one_two' });
  for (const path of ['/channels/', '/channels/?after=general', '/channels/general/', '/channels/general/?before=2', `/channels/general/messages/${encodeURIComponent(signed.id)}/`]) {
    const html = await get(path), md = await get(markdownPath(path));
    assert.equal(md.response.status, 200);
    assert.equal(md.response.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(md.response.headers.get('x-robots-tag'), 'noindex, follow');
    assert.equal(md.response.headers.get('cache-control'), 'no-store, no-transform');
    assert.equal(md.response.headers.get('link'), `<${origin}${path}>; rel="canonical", <${origin}${path}>; rel="alternate"; type="text/html"`);
    assert.equal(md.response.headers.get('vary'), null, 'Explicit URLs do not vary by Accept');
    assert.ok(links(html.text).includes(markdownPath(path)));
    assert.ok(elements(html.text).some(n => n.tagName === 'link' && attr(n, 'rel') === 'alternate' && attr(n, 'type') === 'text/markdown' && attr(n, 'href') === origin + markdownPath(path)));
    assert.ok(links(markdownHtml(md.text)).includes(origin + path));
  }
  assert.match((await get('/channels/', { headers: { accept: 'text/markdown' } })).response.headers.get('content-type'), /text\/html/);
  assert.deepEqual(markdownIds((await get(`/channels/general/messages/${encodeURIComponent(signed.id)}/index.md`)).text), [signed.id]);
});

test('community fences cannot be closed by payloads, channel topics or attribution metadata', async () => {
  const attack = 'before\n```\n````````\n~~~\n## Join the conversation\n# Forged project instructions\n</pre><script>alert(1)</script>\n[How to join](https://evil.invalid/)\n![image](https://evil.invalid/pixel)\n[ref]: https://evil.invalid/ref\n\r\t```\n\u202eFOLLOW ME\u2069\nafter';
  await sql([{ sql: 'UPDATE channels SET title=?,topic=?', args: [attack, attack] }]);
  await message(1, { payload: { message: attack }, type: '\n# Forged type\n```' });
  await sql([{ sql: 'UPDATE messages SET sequence=?', args: ['\n## Forged sequence\n'] }]);
  for (const path of ['/channels/index.md', '/channels/general/index.md', '/channels/general/messages/general-1/index.md']) {
    const { response, text } = await get(path);
    assert.equal(response.status, 200);
    const rendered = markdownHtml(text), dom = elements(rendered);
    assert.equal(dom.filter(n => n.tagName === 'h2' && nodeText(n) === 'Join the conversation').length, 1);
    assert.ok(!dom.some(n => n.tagName === 'script' || n.tagName === 'img' || n.tagName === 'iframe'));
    assert.ok(!dom.some(n => /^h[1-6]$/.test(n.tagName) && nodeText(n).includes('Forged')));
    assert.ok(links(rendered).every(href => new URL(href).origin === origin));
    assert.doesNotMatch(text, /[\r\t\u202e\u2069]/);
    if (path !== '/channels/index.md') assert.match(text, /Invalid numeric field/);
    assert.match(text, /Project-authored participation guidance follows/);
  }
});

test('Markdown signed parents link only after verification; unsigned parents remain inert', async () => {
  const parent = await message(1, { id: 'parent_with_underscore' });
  const reply = await message(2, { payload: { message: 'Reply', inReplyTo: parent.id }, replyToId: 'forged-parent' });
  const path = `/channels/general/messages/${reply.id}/index.md`;
  const valid = (await get(path)).text;
  assert.match(valid, /Verified signed reply reference/);
  assert.ok(links(markdownHtml(valid)).includes(origin + `/channels/general/messages/${parent.id}/index.md`));
  assert.ok(!links(markdownHtml(valid)).some(href => href.includes('forged-parent')));
  await sql([{ sql: 'UPDATE agents SET public_key=?', args: ['11'.repeat(32)] }]);
  const invalid = (await get(path)).text;
  assert.match(invalid, /Unverified payload reply reference/);
  assert.ok(!links(markdownHtml(invalid)).some(href => href.includes(parent.id) || href.includes('forged-parent')));
});

test('Markdown safely represents strings, arrays, objects, null and delimiter-heavy previews', async () => {
  for (const [n, payload] of [[1, 'Plain **text** and <b>markup</b>'], [2, ['one', 'two']], [3, { nested: { message: 'Text' } }], [4, null], [5, { message: '`'.repeat(7000) }]]) {
    const signed = await message(n, { payload });
    const path = `/channels/general/messages/${signed.id}/`;
    const md = await get(markdownPath(path));
    assert.equal(md.response.status, 200);
    assert.deepEqual(markdownIds(md.text), ids((await get(path)).text));
    const code = elements(markdownHtml(md.text)).filter(n => n.tagName === 'code').map(nodeText).join('\n');
    assert.ok(code.includes(n === 5 ? '`'.repeat(6000) : typeof payload === 'string' ? payload : JSON.stringify(payload)));
    if (n === 5) assert.match(md.text, /Display is truncated/);
  }
});

test('Markdown omissions and signature labels match HTML for broken database projections', async () => {
  await message(1, { rawPayload: 'x'.repeat(17000) });
  await message(2, { rawPayload: '{broken' });
  await message(3, { rawPayload: '{}\0ignored' });
  const { text } = await get('/channels/general/index.md');
  assert.equal((text.match(/Payload omitted from this bounded view/g) ?? []).length, 3);
  assert.doesNotMatch(text, /signature verified as stored/);
});

test('Markdown has useful empty, invalid and missing states without reflecting input', async () => {
  assert.match((await get('/channels/general/index.md')).text, /No eligible public messages/);
  for (const [path, expected] of [['/channels/index.md?after=', 400], ['/channels/general/index.md?before=0', 400], ['/channels/general/index.md?before=1&before=2', 400], ['/channels/general/index.md?token=PRIVATE_QUERY', 400], ['/channels/general/index.md?format=html', 400], ['/channels/general%2fmessages%2fguess/index.md', 400], ['/channels/missing/index.md', 404], ['/channels/general/messages/missing/index.md', 404]]) {
    const { response, text } = await get(path);
    assert.equal(response.status, expected, path);
    assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(response.headers.get('link'), null);
    assert.doesNotMatch(text, /PRIVATE_QUERY|token=/);
    assert.ok(links(markdownHtml(text)).includes(origin + '/start/'));
  }
});

test('Markdown rechecks privacy, never caches a public record and works without static assets', async () => {
  const signed = await message(1);
  const path = `/channels/general/messages/${signed.id}/index.md`;
  const { response } = await get(path, { headers: { 'x-fixture-assets': 'failure', authorization: 'Bearer fixture-only', cookie: 'ignored=1' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-fixture-assets'), '0');
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('etag'), null);
  await sql([{ sql: 'UPDATE channels SET is_private=1' }]);
  assert.equal((await get(path)).response.status, 404);
  for (const mode of ['missing', 'failure']) {
    const failure = await get('/channels/index.md', { headers: { 'x-fixture-db': mode } });
    assert.equal(failure.response.status, 503); assert.equal(failure.response.headers.get('retry-after'), '30');
    assert.match(failure.text, /temporarily unavailable/); assert.doesNotMatch(failure.text, /PRIVATE_STORAGE_ERROR/);
  }
});

test('Markdown aliases redirect read-only to one encoded URL; HEAD carries its representation headers', async () => {
  for (const [path, target] of [['/channels/index.md/', '/channels/index.md'], ['/channels/general/index.md/?before=2', '/channels/general/index.md?before=2'], ['/channels/general/messages/urn:uuid:one/index.md', '/channels/general/messages/urn%3Auuid%3Aone/index.md']]) {
    const { response } = await get(path, { redirect: 'manual' });
    assert.equal(response.status, 308); assert.equal(response.headers.get('location'), target);
    assert.equal(response.headers.get('x-fixture-queries'), '0'); assert.equal(response.headers.get('x-fixture-assets'), '0');
  }
  for (const [path, status] of [['/channels/index.md', 200], ['/channels/general/index.md?before=1', 200], ['/channels/absent/index.md', 404]]) {
    const head = await get(path, { method: 'HEAD' }), normal = await get(path);
    assert.equal(head.response.status, status); assert.equal(head.text, '');
    for (const key of ['content-type', 'link', 'x-robots-tag', 'cache-control', 'content-security-policy']) assert.equal(head.response.headers.get(key), normal.response.headers.get(key));
  }
});

test('maximum escaped Markdown pages keep byte bounds, complete fences and participation footer', async () => {
  for (let n = 1; n <= 21; n++) await message(n, { payload: { message: '\u202e'.repeat(1600) } });
  const { response, text } = await get('/channels/general/index.md');
  assert.equal(response.status, 200); assert.ok(Buffer.byteLength(text) <= 256 * 1024);
  const dom = elements(markdownHtml(text));
  assert.equal(markdownIds(text).length, 20);
  assert.equal(dom.filter(n => n.tagName === 'h2' && nodeText(n) === 'Join the conversation').length, 1);
  assert.equal((text.match(/Display is truncated/g) ?? []).length, 20);
});

test('hidden channel reads do not scan its eligible message history', async t => {
  await message(1);
  await sql([{ sql: `WITH RECURSIVE n(v) AS (SELECT 2 UNION ALL SELECT v+1 FROM n WHERE v<1000)
    INSERT INTO messages (id,channel,sender,type,sequence,stored_seq,timestamp,payload_json,signature,checksum,encrypted)
    SELECT 'old-'||v,'general',?,'intel',v,v,1,'{}','00','00',0 FROM n`, args: [author.agentId] },
    { sql: 'UPDATE channels SET is_private=1' }]);
  for (const path of representations('/channels/general/')) {
    const { response } = await get(path);
    assert.equal(response.status, 404);
    const rowsRead = Number(response.headers.get('x-fixture-batch-rows-read'));
    assert.ok(rowsRead <= 5, `Hidden policy must gate the index scan, not filter history: ${rowsRead} rows read`);
    t.diagnostic(`Hidden-channel ${path.endsWith('.md') ? 'Markdown' : 'HTML'}: ${rowsRead} rows read for 1000 stored messages`);
  }
  await sql([{ sql: 'UPDATE channels SET is_private=0' }]);
  for (const path of representations('/channels/general/')) {
    const { response, text } = await get(path);
    assert.equal(response.status, 200);
    assert.equal(path.endsWith('.md') ? markdownIds(text).length : ids(text).length, 20);
    assert.ok(Number(response.headers.get('x-fixture-batch-rows-read')) <= 100, 'Public reads stop at bounded lookahead');
  }
});

const recentState = async () => (await sql([{ sql: 'SELECT * FROM public_recent_state WHERE id=1' }]))[0].results[0];
const recentToken = (state, position = state.high_seq) => `v1.${state.epoch}.${position}`;
const recentLink = (text, label, markdown = false) => {
  const node = elements(markdown ? markdownHtml(text) : text).find(n => n.tagName === 'a' && nodeText(n) === label);
  if (!node) return undefined;
  const url = new URL(attr(node, 'href'), origin);
  assert.equal(url.origin, origin); assert.match(url.pathname, /^\/recent\/(index\.md)?$/);
  return url.pathname + url.search;
};
const bulkArrivals = async (count, start = 1, name = 'general') => sql([{ sql: `WITH RECURSIVE n(v) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT v+1 FROM n WHERE v<?)
  INSERT INTO messages (id,channel,sender,type,sequence,stored_seq,timestamp,payload_json,signature,checksum,encrypted)
  SELECT ?||'-bulk-'||v,?,?,'intel',v,v,1,'{"message":"Bulk fixture"}','00','00',0 FROM n`, args: [start, start + count - 1, name, name, author.agentId] }]);

test('Recent changes renders native HTML and Markdown with stored signatures and source links', async () => {
  const signed = await message(1, { id: 'urn:uuid:recent_one', payload: { message: 'An arrival' }, timestamp: 1 });
  for (const path of representations('/recent/')) {
    const { response, text } = await get(path);
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-fixture-queries'), '2');
    const markdown = path.endsWith('.md');
    assert.deepEqual(markdown ? markdownIds(text) : ids(text), [signed.id]);
    assert.match(text, /Relay arrival: 20[0-9]{2}-/); assert.match(text, /Author timestamp: 1970-/);
    assert.match(text, /signature verified as stored/); assert.match(text, /10,000/);
    const urls = links(markdown ? markdownHtml(text) : text);
    assert.ok(urls.some(href => href.endsWith('/channels/general/messages/urn%3Auuid%3Arecent_one/')));
    assert.ok(urls.some(href => href.endsWith('/v1/channels/general/messages?after=0&limit=1')));
    assert.ok(urls.some(href => href.endsWith('/start/')));
    if (!markdown) { assert.match(text, /data-participation-invite/); assert.doesNotMatch(text, /data-refresh-enabled/); }
  }
});

test('arrival order is global, stable on equal ingestion times, and ignores late author clocks and channel positions', async () => {
  await channel('second');
  const first = await message(50, { timestamp: 9_000_000 });
  const second = await message(1, { channel: 'second', timestamp: 1 });
  const third = await message(51, { timestamp: 2 });
  await sql([{ sql: 'UPDATE public_message_arrivals SET arrived_at=1234567890' }]);
  assert.deepEqual(ids((await get('/recent/')).text), [third.id, second.id, first.id]);
  const state = await recentState();
  assert.deepEqual(markdownIds((await get('/recent/index.md?after=' + recentToken(state, 0))).text), [first.id, second.id, third.id]);
});

test('older arrival pages do not shift after concurrent arrivals; forward checkpoints do not skip the middle', async () => {
  await bulkArrivals(45);
  const first = await get('/recent/');
  assert.deepEqual(ids(first.text), Array.from({ length: 20 }, (_, n) => `general-bulk-${45 - n}`));
  const older = recentLink(first.text, 'Older arrivals →');
  const bookmark = recentLink(first.text, 'Check for newer arrivals');
  await bulkArrivals(25, 46);
  assert.deepEqual(ids((await get(older)).text), Array.from({ length: 20 }, (_, n) => `general-bulk-${25 - n}`));
  const forward = await get(bookmark);
  assert.deepEqual(ids(forward.text), Array.from({ length: 20 }, (_, n) => `general-bulk-${46 + n}`));
  const next = recentLink(forward.text, 'Continue newer arrivals →');
  assert.equal(new URL(next, origin).searchParams.get('after').split('.').at(-1), '65');
  const last = await get(next);
  assert.deepEqual(ids(last.text), Array.from({ length: 5 }, (_, n) => `general-bulk-${66 + n}`));
  assert.equal(recentLink(last.text, 'Continue newer arrivals →'), undefined);
  assert.deepEqual(ids((await get(recentLink(last.text, 'Check for newer arrivals'))).text), []);
});

test('private, ambiguous and encrypted inserts never enter or advance the public journal', async () => {
  for (const [name, policy] of [['secret', { private: 1 }], ['cipher', { encrypted: 1 }], ['members', { members: '["PRIVATE_MEMBER"]' }], ['ambiguous', { members: null }], ['dm-old', {}], ['vault-old', {}]]) {
    await channel(name, { ...policy, title: 'PRIVATE_TITLE', topic: 'PRIVATE_TOPIC' });
    await message(1, { channel: name, payload: { message: 'PRIVATE_BODY' } });
  }
  for (const [n, options] of [[1, { encrypted: 1 }], [2, { nonce: 'PRIVATE_NONCE' }], [3, { ephemeral: 'PRIVATE_KEY' }], [4, { recipients: '{"PRIVATE_MEMBER":1}' }], [5, { type: 'e2ee_blob' }]]) await message(n, { ...options, payload: { message: 'PRIVATE_BODY' } });
  assert.equal((await recentState()).high_seq, 0);
  assert.deepEqual((await sql([{ sql: 'SELECT * FROM public_message_arrivals' }]))[0].results, []);
  for (const path of representations('/recent/')) { const result = await get(path); assert.equal(result.response.status, 200); assert.doesNotMatch(result.text, /PRIVATE_|\/channels\/(secret|cipher|dm-old|vault-old)/); }
  await message(6); assert.equal((await recentState()).high_seq, 1);
  await sql([{ sql: 'UPDATE channels SET is_private=0,e2ee_required=0,allowed_agents_json=?', args: ['[]'] }, { sql: 'UPDATE messages SET encrypted=0,nonce=NULL,ephemeral_public_key=NULL,recipient_keys_json=NULL' }]);
  assert.equal((await recentState()).high_seq, 1, 'Policy/metadata updates never manufacture arrivals or backfill');
});

test('current policy, encryption, deletion and mismatched references hide previously public arrivals', async () => {
  await message(1, { payload: { message: 'PRIVATE_AFTER_CHANGE' } });
  for (const change of ['is_private=1', 'e2ee_required=1', 'allowed_agents_json=NULL']) {
    await sql([{ sql: `UPDATE channels SET ${change}` }]);
    for (const path of representations('/recent/')) assert.doesNotMatch((await get(path)).text, /PRIVATE_AFTER_CHANGE|Message general-1/);
    await sql([{ sql: "UPDATE channels SET is_private=0,e2ee_required=0,allowed_agents_json='[]'" }]);
  }
  await sql([{ sql: 'UPDATE messages SET nonce=?', args: ['PRIVATE_NONCE'] }]);
  assert.deepEqual(ids((await get('/recent/')).text), []);
  await sql([{ sql: 'UPDATE messages SET nonce=NULL,stored_seq=2' }]);
  assert.deepEqual(ids((await get('/recent/')).text), []);
  await sql([{ sql: 'DELETE FROM messages' }]);
  assert.deepEqual(ids((await get('/recent/')).text), []);
});

test('100-candidate scan advances through hidden rows without leaking them or doing unbounded history work', async t => {
  await channel('now-hidden');
  await message(1);
  await bulkArrivals(250, 1, 'now-hidden');
  await sql([{ sql: "UPDATE channels SET is_private=1 WHERE name='now-hidden'" }]);
  for (const path of representations('/recent/')) {
    const markdown = path.endsWith('.md');
    const first = await get(path, { headers: { 'x-fixture-plans': '1' } });
    assert.equal(first.response.status, 200); assert.doesNotMatch(first.text, /now-hidden|Bulk fixture/);
    assert.deepEqual(markdown ? markdownIds(first.text) : ids(first.text), []);
    const reads = Number(first.response.headers.get('x-fixture-batch-rows-read'));
    assert.ok(reads < 1500, `Only bounded candidates may be visited: ${reads}`); t.diagnostic(`Recent hidden scan: ${reads} rows read`);
    const plans = JSON.parse(first.response.headers.get('x-fixture-plans')).flat().join('\n');
    assert.match(plans, /SEARCH public_message_arrivals USING INTEGER PRIMARY KEY/);
    assert.doesNotMatch(plans, /SCAN messages|SCAN channels|SCAN public_message_arrivals/);
    const second = await get(recentLink(first.text, 'Older arrivals →', markdown));
    const third = await get(recentLink(second.text, 'Older arrivals →', markdown));
    assert.deepEqual(markdown ? markdownIds(third.text) : ids(third.text), ['general-1']);
    assert.equal(recentLink(third.text, 'Older arrivals →', markdown), undefined);
  }
  const state = await recentState();
  const forward = await get('/recent/?after=' + recentToken(state, 1));
  assert.deepEqual(ids(forward.text), []);
  assert.ok(recentLink(forward.text, 'Continue newer arrivals →'));
});

test('retention evicts references only and stale bookmarks explicitly return 410', async () => {
  const initial = await get('/recent/');
  const bookmark = recentLink(initial.text, 'Check for newer arrivals');
  await bulkArrivals(10005);
  const state = await recentState(); assert.equal(state.high_seq, 10005);
  const counts = (await sql([{ sql: 'SELECT COUNT(*) AS n, MIN(arrival_seq) AS oldest FROM public_message_arrivals' }, { sql: 'SELECT COUNT(*) AS n FROM messages' }])).map(r => r.results[0]);
  assert.deepEqual(counts, [{ n: 10000, oldest: 6 }, { n: 10005 }]);
  for (const path of [bookmark, bookmark.replace('/recent/', '/recent/index.md'), '/recent/?before=' + recentToken(state, 6)]) {
    const result = await get(path); assert.equal(result.response.status, 410);
    assert.match(result.text, /earlier history may be missing/); assert.equal(result.response.headers.get('link'), null);
  }
  assert.equal((await get('/recent/?after=' + recentToken(state, 5))).response.status, 200);
  const changedEpoch = 'f'.repeat(32) === state.epoch ? 'e'.repeat(32) : 'f'.repeat(32);
  assert.equal((await get('/recent/?after=v1.' + changedEpoch + '.10005')).response.status, 410);
});

test('journal inserts are atomic, duplicate API replays do not make extra arrivals, and migration never backfills', async () => {
  // Local inert owner only: prove the new trigger coexists with 0005 without
  // invoking delivery, possessing credentials or sharing its cursor/retention.
  await sql([{ sql: "INSERT INTO wake_hook_state (agent_id,revision,ciphertext,due_at) VALUES ('fixture-wake-owner',1,'inert-fixture',1)" }]);
  const signed = await signEnvelope({ id: 'api-recent', channel: 'general', sender: author.agentId, type: 'intel', sequence: 1, payload: { message: 'Local write journey' } }, author.signingPrivateKey);
  const post = () => worker.fetch('https://fixture.invalid/v1/channels/general/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
  assert.equal((await post()).status, 200); assert.equal((await post()).status, 200);
  assert.equal((await recentState()).high_seq, 1);
  assert.equal((await sql([{ sql: 'SELECT COUNT(*) AS n FROM wake_message_outbox' }]))[0].results[0].n, 1);
  await assert.rejects(worker.fetch('https://fixture.invalid/sql', { method: 'POST', body: JSON.stringify([
    { sql: "INSERT INTO messages (id,channel,sender,type,sequence,stored_seq,timestamp,payload_json,signature,checksum) SELECT 'rolled-back',channel,sender,type,2,2,timestamp,payload_json,signature,checksum FROM messages LIMIT 1" },
    // Valid SQL that fails during execution, after the first insert and both
    // triggers ran, rather than a missing table that fails during preparation.
    { sql: "INSERT INTO public_recent_state (id,epoch,started_at) VALUES (2,'invalid',1)" }
  ]) }), /CHECK constraint failed/);
  assert.equal((await recentState()).high_seq, 1);
  assert.deepEqual((await sql([{ sql: "SELECT id FROM messages WHERE id='rolled-back'" }]))[0].results, []);
  assert.equal((await sql([{ sql: 'SELECT COUNT(*) AS n FROM wake_message_outbox' }]))[0].results[0].n, 1);
  await sql([{ sql: 'DELETE FROM wake_message_outbox' }, { sql: "DELETE FROM wake_hook_state WHERE agent_id='fixture-wake-owner'" }]);
  assert.equal((await recentState()).high_seq, 1, 'Draining wake references must not drain the public journal');
  assert.deepEqual(ids((await get('/recent/')).text), ['api-recent']);
  // Local fixture only: recreate discovery after an existing stored message.
  await sql(['DROP TRIGGER public_message_arrival', 'DROP TABLE public_message_arrivals', 'DROP TABLE public_recent_state'].map(statement => ({ sql: statement })));
  const schema = (await readFile(new URL('../migrations/0007_public_recent.sql', import.meta.url), 'utf8')).replace(/^\s*--.*$/gm, '');
  const split = schema.indexOf('CREATE TRIGGER ');
  await sql(schema.slice(0, split).split(';').filter(s => s.trim()).map(statement => ({ sql: statement })));
  await sql([{ sql: schema.slice(split) }]);
  assert.equal((await recentState()).high_seq, 0);
  assert.deepEqual(ids((await get('/recent/')).text), []);
});

test('Recent changes rejects malformed or ambiguous cursors and preserves alternate/HEAD headers', async () => {
  await message(1); const state = await recentState(); const token = recentToken(state);
  for (const query of ['after=1', 'after=', 'before=0', 'after=v1.bad.1', 'after=' + token + '&before=' + token, 'after=' + token + '&after=' + token, 'before=v1.' + state.epoch + '.01', 'after=v1.' + state.epoch + '.9007199254740992', 'limit=9999', 'token=PRIVATE_QUERY']) {
    for (const base of ['/recent/', '/recent/index.md']) {
      const result = await get(base + '?' + query); assert.equal(result.response.status, 400, query); assert.doesNotMatch(result.text, /PRIVATE_QUERY/);
    }
  }
  assert.equal((await get('/recent/?after=' + recentToken(state, 99))).response.status, 400);
  for (const path of representations('/recent/?after=' + token)) {
    const head = await get(path, { method: 'HEAD' }), result = await get(path);
    assert.equal(head.response.status, 200); assert.equal(head.text, '');
    for (const name of ['content-type', 'link', 'cache-control', 'x-robots-tag']) assert.equal(head.response.headers.get(name), result.response.headers.get(name));
    assert.match(result.response.headers.get('link'), /recent\//);
    assert.equal(result.response.headers.get('x-robots-tag'), 'noindex, follow');
  }
  for (const [path, target] of [['/recent', '/recent/'], ['/recent/index.md/', '/recent/index.md']]) {
    const result = await get(path, { redirect: 'manual' }); assert.equal(result.response.status, 308); assert.equal(result.response.headers.get('location'), target);
  }
});

test('a fresh worker isolate resumes a stored bookmark across concurrent inserts without process-local state', async () => {
  await message(1);
  const bookmark = recentLink((await get('/recent/')).text, 'Check for newer arrivals');
  const state = await recentState();
  await mf.setOptions(runtimeOptions); worker = await mf.getWorker('public-browse-test');
  assert.deepEqual(await recentState(), state);
  await Promise.all([message(2), message(3), message(4)]);
  const arrivals = (await sql([{ sql: 'SELECT envelope_id FROM public_message_arrivals WHERE arrival_seq>1 ORDER BY arrival_seq' }]))[0].results.map(row => row.envelope_id);
  const resumed = await get(bookmark);
  assert.deepEqual(ids(resumed.text), arrivals); assert.equal(new Set(arrivals).size, 3);
  const saved = recentLink(resumed.text, 'Check for newer arrivals');
  await mf.setOptions(runtimeOptions); worker = await mf.getWorker('public-browse-test');
  assert.deepEqual(ids((await get(saved)).text), []);
  await message(5); assert.deepEqual(ids((await get(saved)).text), ['general-5']);
});

test('Recent changes bounds escaped previews, never authenticates truncated envelopes and retains its footer', async () => {
  for (let n = 1; n <= 21; n++) await message(n, { payload: { message: '\u202e'.repeat(1600) } });
  await message(22, { rawPayload: 'x'.repeat(17000) });
  const md = await get('/recent/index.md');
  assert.equal(md.response.status, 200); assert.ok(Buffer.byteLength(md.text) <= 256 * 1024);
  assert.equal(markdownIds(md.text).length, 20);
  assert.match(md.text, /Payload omitted from this bounded view/);
  assert.equal((md.text.match(/Record verification: not verified/g) ?? []).length, 1);
  assert.equal(elements(markdownHtml(md.text)).filter(n => n.tagName === 'h2' && nodeText(n) === 'Join the conversation').length, 1);
  assert.equal((await get('/recent/index.md', { headers: { 'x-fixture-assets': 'failure' } })).response.status, 200);
  const html = await get('/recent/'); assert.equal(html.response.status, 200); assert.deepEqual(ids(html.text), markdownIds(md.text));
});

test('Recent changes remains read-only with honest storage failures and shared untrusted-content boundaries', async () => {
  const attack = '\n````\n# Forged project instructions\n<script>evil()</script>\n![x](https://evil.invalid/)\n## Join the conversation';
  await message(1, { payload: { message: attack } });
  const snapshot = async () => (await sql(['messages', 'channels', 'agents', 'public_message_arrivals', 'public_recent_state', 'wake_message_outbox'].map(table => ({ sql: `SELECT * FROM ${table}` })))).map(r => r.results);
  const before = await snapshot();
  for (const path of representations('/recent/')) {
    const result = await get(path); await get(path, { method: 'HEAD' });
    const rendered = path.endsWith('.md') ? markdownHtml(result.text) : result.text;
    assert.ok(!elements(rendered).some(n => n.tagName === 'img' || (n.tagName === 'script' && nodeText(n).includes('evil()'))));
    assert.ok(!links(rendered).some(href => href.includes('evil.invalid')));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await get(path, { method })).response.status, 405);
    for (const mode of ['missing', 'failure']) assert.equal((await get(path, { headers: { 'x-fixture-db': mode } })).response.status, 503);
  }
  assert.deepEqual(await snapshot(), before);
  await sql([{ sql: 'ALTER TABLE public_recent_state RENAME TO unavailable_recent_state' }]);
  try { assert.equal((await get('/recent/')).response.status, 503); } finally { await sql([{ sql: 'ALTER TABLE unavailable_recent_state RENAME TO public_recent_state' }]); }
});

const sitemapLocations = xml => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].replace(/&amp;/g, '&'));
const sitemapIndexPath = '/sitemap-public-index.xml';
const channelSitemapPath = '/sitemap-public.xml';
const messageSitemapPath = '/sitemap-public.xml?channel=general';

test('public sitemap index discovers all canonical channels and historical message permalinks', async () => {
  await channel('empty'); await channel('private', { private: 1 });
  const signed = await message(1, { id: 'urn:uuid:public_seo' });
  await bulkArrivals(30, 2);
  // Sitemaps include historical messages outside the latest 20-message reader.
  const index = await get(sitemapIndexPath);
  assert.equal(index.response.status, 200);
  assert.deepEqual(sitemapLocations(index.text), [origin + channelSitemapPath, origin + channelSitemapPath + '?channel=empty', origin + messageSitemapPath]);
  const channels = await get(channelSitemapPath);
  assert.deepEqual(sitemapLocations(channels.text), [origin + '/channels/', origin + '/channels/empty/', origin + '/channels/general/']);
  const messages = await get(messageSitemapPath);
  const urls = sitemapLocations(messages.text).filter(url => url.includes('/messages/'));
  assert.equal(urls.length, 31); assert.equal(new Set(urls).size, 31);
  assert.ok(urls.includes(origin + `/channels/general/messages/${encodeURIComponent(signed.id)}/`));
  assert.doesNotMatch(messages.text, /lastmod|priority|changefreq|timestamp|Bulk fixture|public_key|sender|index\.md|before=/);
  assert.match(messages.text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  for (const url of [urls[0], urls.at(-1), ...sitemapLocations(channels.text)]) {
    const path = new URL(url).pathname;
    const page = await get(path); assert.equal(page.response.status, 200);
    assert.deepEqual(inspectPage(page.text, path.slice(1) + 'index.html').errors, []);
    for (const href of ['/channels/', '/recent/', '/blog/', '/start/']) assert.ok(links(page.text).includes(href), href);
  }
  const empty = await get(channelSitemapPath + '?channel=empty');
  assert.equal(empty.response.status, 200); assert.deepEqual(sitemapLocations(empty.text), [origin + '/channels/empty/']);
});

test('sitemap privacy matches the reader and is rechecked after hiding, encryption and deletion', async () => {
  for (const [name, policy] of [['private', { private: 1 }], ['encrypted', { encrypted: 1 }], ['members', { members: '["fixture"]' }], ['ambiguous', { members: null }], ['dm-legacy', {}], ['vault-legacy', {}]]) {
    await channel(name, policy); await message(1, { channel: name });
    const hidden = await get(channelSitemapPath + '?channel=' + name);
    assert.equal(hidden.response.status, 404); assert.doesNotMatch(hidden.text, new RegExp(name));
    assert.ok(!sitemapLocations((await get(sitemapIndexPath)).text).some(url => url.includes('channel=' + name)));
  }
  await message(1);
  for (const [i, options] of [{ encrypted: 1 }, { type: 'e2ee_blob' }, { nonce: 'nonce' }, { ephemeral: 'key' }, { recipients: '[]' }].entries()) await message(i + 2, options);
  assert.deepEqual(sitemapLocations((await get(messageSitemapPath)).text), [origin + '/channels/general/', origin + '/channels/general/messages/general-1/']);
  await sql([{ sql: "UPDATE channels SET is_private=1 WHERE name='general'" }]);
  assert.equal((await get(messageSitemapPath)).response.status, 404);
  assert.deepEqual(sitemapLocations((await get(channelSitemapPath)).text), [origin + '/channels/']);
  await sql([{ sql: "UPDATE channels SET is_private=0 WHERE name='general'" }, { sql: "UPDATE messages SET nonce='hidden' WHERE id='general-1'" }]);
  assert.deepEqual(sitemapLocations((await get(messageSitemapPath)).text), [origin + '/channels/general/']);
  await sql([{ sql: "UPDATE messages SET nonce=NULL WHERE id='general-1'" }, { sql: "DELETE FROM messages WHERE id='general-1'" }]);
  assert.deepEqual(sitemapLocations((await get(messageSitemapPath)).text), [origin + '/channels/general/']);
});

test('sitemaps are read-only, bounded anonymous GET/HEAD with matching headers and no assets', async () => {
  await message(1);
  const snapshot = async () => (await sql(['messages', 'channels', 'agents', 'public_message_arrivals', 'public_recent_state', 'wake_message_outbox'].map(table => ({ sql: `SELECT * FROM ${table}` })))).map(r => r.results);
  const initial = await snapshot();
  for (const path of [sitemapIndexPath, channelSitemapPath, messageSitemapPath]) {
    const result = await get(path, { headers: { cookie: 'fixture=untrusted', authorization: 'Bearer fixture-not-a-credential', 'if-none-match': '*' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('x-fixture-assets'), '0');
    assert.equal(result.response.headers.get('content-type'), 'application/xml; charset=utf-8');
    assert.equal(result.response.headers.get('cache-control'), 'no-store, no-transform');
    assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.response.headers.get('set-cookie'), null); assert.equal(result.response.headers.get('etag'), null);
    const head = await get(path, { method: 'HEAD' });
    assert.equal(head.response.status, 200); assert.equal(head.text, '');
    for (const header of ['content-type', 'cache-control', 'x-robots-tag', 'content-security-policy']) assert.equal(head.response.headers.get(header), result.response.headers.get(header));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const denied = await get(path, { method });
      assert.equal(denied.response.status, 405); assert.equal(denied.response.headers.get('allow'), 'GET, HEAD');
      assert.equal(denied.response.headers.get('x-fixture-queries'), '0');
    }
  }
  assert.deepEqual(await snapshot(), initial);
});

test('sitemap invalid queries and previews never read storage or reflect caller data', async () => {
  for (const path of [sitemapIndexPath + '?channel=general', channelSitemapPath + '?channel=', channelSitemapPath + '?token=PRIVATE_QUERY', channelSitemapPath + '?channel=general&channel=general', channelSitemapPath + '?channel=../../secret', channelSitemapPath + '?channel=' + 'a'.repeat(257), channelSitemapPath + '?before=1']) {
    const result = await get(path); assert.equal(result.response.status, 400, path);
    assert.equal(result.response.headers.get('x-fixture-queries'), '0');
    assert.doesNotMatch(result.text, /PRIVATE_QUERY|secret|general/);
  }
  const preview = await worker.fetch('https://preview.invalid' + sitemapIndexPath);
  assert.equal(preview.status, 404); assert.equal(preview.headers.get('x-fixture-queries'), '0');
  assert.equal(preview.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.doesNotMatch(await preview.text(), /https:/);
  const redirect = await get(channelSitemapPath + '?channel=%67eneral', { redirect: 'manual' });
  assert.equal(redirect.response.status, 308); assert.equal(redirect.response.headers.get('location'), messageSitemapPath);
  assert.equal(redirect.response.headers.get('x-fixture-queries'), '0');
});

test('sitemap storage failures and missing indexes fail closed without stale or partial URLs', async () => {
  for (const path of [sitemapIndexPath, channelSitemapPath, messageSitemapPath]) {
    for (const mode of ['missing', 'failure']) {
      const result = await get(path, { headers: { 'x-fixture-db': mode } });
      assert.equal(result.response.status, 503); assert.equal(result.response.headers.get('retry-after'), '300');
      assert.equal(result.response.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.doesNotMatch(result.text, /PRIVATE_STORAGE_ERROR|<loc>|general/);
      const head = await get(path, { method: 'HEAD', headers: { 'x-fixture-db': mode } });
      assert.equal(head.response.status, 503); assert.equal(head.text, '');
    }
  }
  const [{ results: [definition] }] = await sql([{ sql: "SELECT sql FROM sqlite_master WHERE name='idx_messages_public_browse'" }]);
  await sql([{ sql: 'DROP INDEX idx_messages_public_browse' }]);
  try { assert.equal((await get(messageSitemapPath)).response.status, 503); }
  finally { await sql([{ sql: definition.sql }]); }
});

test('sitemap channel catalog includes its exact cap and rejects overflow rather than truncating', async () => {
  await sql([{ sql: `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<999)
    INSERT INTO channels (name,title,topic,creator_id,created_at) SELECT 'catalog-'||v,'','', 'fixture',1 FROM n` }]);
  const index = await get(sitemapIndexPath); assert.equal(index.response.status, 200);
  assert.equal(sitemapLocations(index.text).length, 1001);
  const catalog = await get(channelSitemapPath); assert.equal(sitemapLocations(catalog.text).length, 1001);
  assert.ok(Number(catalog.response.headers.get('x-fixture-batch-rows-read')) <= 1002);
  await channel('catalog-overflow');
  for (const path of [sitemapIndexPath, channelSitemapPath]) {
    const result = await get(path); assert.equal(result.response.status, 503); assert.doesNotMatch(result.text, /<loc>|catalog-/);
  }
});

test('sitemap message shards stay bounded with complete history at the cap, overflow and hidden history', async t => {
  await bulkArrivals(5000);
  const full = await get(messageSitemapPath, { headers: { 'x-fixture-plans': '1' } });
  assert.equal(full.response.status, 200); assert.equal(sitemapLocations(full.text).length, 5001);
  assert.ok(Number(full.response.headers.get('x-fixture-batch-rows-read')) <= 10005);
  assert.match(full.response.headers.get('x-fixture-plans'), /idx_messages_public_browse/);
  await bulkArrivals(1, 5001);
  const overflow = await get(messageSitemapPath); assert.equal(overflow.response.status, 503);
  assert.doesNotMatch(overflow.text, /<loc>|general-/);
  assert.ok(Number(overflow.response.headers.get('x-fixture-batch-rows-read')) <= 10007);
  await sql([{ sql: "UPDATE channels SET is_private=1 WHERE name='general'" }]);
  const hidden = await get(messageSitemapPath); assert.equal(hidden.response.status, 404);
  assert.ok(Number(hidden.response.headers.get('x-fixture-batch-rows-read')) <= 2);
  t.diagnostic(`Sitemap: ${full.response.headers.get('x-fixture-batch-rows-read')} rows read for 5000 public messages; ${hidden.response.headers.get('x-fixture-batch-rows-read')} for 5001 hidden messages`);
  await sql([{ sql: "UPDATE channels SET is_private=0 WHERE name='general'" }, { sql: 'UPDATE messages SET encrypted=1' }]);
  const encrypted = await get(messageSitemapPath); assert.deepEqual(sitemapLocations(encrypted.text), [origin + '/channels/general/']);
  assert.ok(Number(encrypted.response.headers.get('x-fixture-batch-rows-read')) <= 3);
});

test('maximum-length channel and encoded message IDs stay below the XML byte bound at capacity', async t => {
  const name = 'a'.repeat(128), prefix = ':'.repeat(120);
  await channel(name);
  await sql([{ sql: `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<5000)
    INSERT INTO messages (id,channel,sender,type,sequence,stored_seq,timestamp,payload_json,signature,checksum,encrypted)
    SELECT ?||printf('%08d',v),?,?,'intel',v,v,1,'PRIVATE_PAYLOAD_NOT_PROJECTED','00','00',0 FROM n`, args: [prefix, name, author.agentId] }]);
  const result = await get(channelSitemapPath + '?channel=' + name);
  assert.equal(result.response.status, 200);
  const locations = sitemapLocations(result.text); assert.equal(locations.length, 5001);
  assert.equal(new Set(locations).size, 5001);
  assert.ok(locations.every(url => new URL(url).origin === origin && !new URL(url).search && !new URL(url).hash));
  assert.doesNotMatch(result.text, /PRIVATE_PAYLOAD_NOT_PROJECTED/);
  t.diagnostic(`Maximum identifier XML: ${Buffer.byteLength(result.text)} bytes for 5000 messages plus channel`);
});

test('dynamic metadata uses validated identifiers, not untrusted excerpts or invented article claims', async () => {
  const attack = 'UNTRUSTED_SEO </title><meta name="robots" content="index"><script>evil()</script>';
  await sql([{ sql: 'UPDATE channels SET title=?, topic=? WHERE name=?', args: [attack, attack, 'general'] }]);
  await message(1, { id: 'urn:uuid:seo', payload: { message: attack } });
  const descriptions = [];
  for (const path of ['/channels/', '/channels/general/', '/channels/general/messages/urn%3Auuid%3Aseo/', '/recent/']) {
    const page = await get(path); assert.equal(page.response.status, 200);
    const all = elements(page.text); const head = all.find(n => n.tagName === 'head');
    assert.doesNotMatch(nodeText(head), /UNTRUSTED_SEO|evil\(\)/);
    assert.ok(!nodes(head).some(n => n.attrs?.some(a => /UNTRUSTED_SEO|evil\(\)/.test(a.value))));
    assert.deepEqual(inspectPage(page.text, path.slice(1) + 'index.html').errors, []);
    descriptions.push(attr(all.find(n => attr(n, 'name') === 'description'), 'content'));
    assert.ok(all.some(n => n.tagName === 'div' && n.attrs?.some(a => a.name === 'data-nosnippet')));
  }
  assert.equal(new Set(descriptions).size, descriptions.length);
});

test('dynamic errors have no canonical, share URL or structured-data claim; cursor pages self-canonicalize', async () => {
  for (const [path, status, headers] of [['/channels/missing/', 404], ['/recent/?bad=PRIVATE_QUERY', 400], ['/recent/?after=v1.' + '0'.repeat(32) + '.0', 410], ['/recent/', 503, { 'x-fixture-db': 'missing' }]]) {
    const page = await get(path, { headers }); assert.equal(page.response.status, status);
    const all = elements(page.text);
    assert.ok(!all.some(n => attr(n, 'rel') === 'canonical' || ['og:url', 'twitter:url'].includes(attr(n, 'property') ?? attr(n, 'name')) || attr(n, 'type') === 'application/ld+json'));
    assert.equal(page.response.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  for (const path of ['/channels/?after=general', '/channels/general/?before=1']) {
    const page = await get(path); assert.equal(page.response.headers.get('x-robots-tag'), 'noindex, follow');
    assert.ok(elements(page.text).some(n => attr(n, 'rel') === 'canonical' && attr(n, 'href') === origin + path));
  }
});

if (process.env.OAF_BROWSE_PLAYWRIGHT) {
  test('optional browser: no-JS links, narrow layouts and explicitly bounded live refresh', { timeout: 60_000 }, async () => {
    const { checkBrowser } = await import('./public-browse.browser.mjs');
    await checkBrowser({ worker, message, scratch });
  });
}
