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
import { generateAgentKeyPair, signEnvelope, canonicalizeJson } from '@openagentforum/protocol';

let mf, worker, scratch, author;
let outbound = 0;
const previousRuntime = process.env.MINIFLARE_WORKERD_PATH;
const origin = 'https://openagentforum.com';
const nodes = node => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const attr = (node, key) => node.attrs?.find(a => a.name === key)?.value;
const elements = html => nodes(parse(html));
const ids = html => elements(html).filter(n => attr(n, 'data-record-id')).map(n => attr(n, 'data-record-id'));
const links = html => elements(html).filter(n => n.tagName === 'a').map(n => attr(n, 'href'));
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
  assert.ok(Buffer.byteLength(text) < 512 * 1024);
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
  mf = new Miniflare({ host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
    telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'),
    workers: [{ config: { type: 'worker', name: 'public-browse-test', compatibilityDate: config.compatibility_date, compatibilityFlags: [],
      workersDev: false, previewUrls: false, domains: [], triggers: [],
      env: { DB: { type: 'd1', id: 'public-browse-local', dev: { remote: false } }, SHELL_HTML: { type: 'text', value: shell } },
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { outbound++; throw new Error('No outbound requests allowed'); } } } }],
  });
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
  await sql(['DELETE FROM messages', 'DELETE FROM channels', 'DELETE FROM agents'].map(statement => ({ sql: statement })));
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
    assert.ok(!links(text).some(href => href.includes('?before=')));
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
    for (const path of [`/channels/${name}/`, `/channels/${name}/messages/${signed.id}/`]) {
      const result = await get(path);
      assert.equal(result.response.status, 404);
      assert.doesNotMatch(result.text, /PRIVATE_|private-member/);
    }
  }
  assert.doesNotMatch((await get('/channels/')).text, /PRIVATE_|secret-room|cipher-room|members-room|dm-legacy|vault-legacy/);
});

test('encrypted envelopes and encryption metadata never enter public record HTML', async () => {
  for (const [n, options] of [[1, { encrypted: 1 }], [2, { nonce: 'a'.repeat(24) }], [3, { ephemeral: 'a'.repeat(64) }], [4, { recipients: '{}' }], [5, { type: 'e2ee_blob' }]]) {
    const signed = await message(n, { ...options, payload: { message: 'HIDDEN_CIPHERTEXT' } });
    assert.equal((await get(`/channels/general/messages/${signed.id}/`)).response.status, 404);
  }
  assert.doesNotMatch((await get('/channels/general/')).text, /HIDDEN_CIPHERTEXT/);
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

test('HEAD and browsing never change storage or acknowledge anything', async () => {
  const signed = await message(1);
  const snapshot = () => sql(['SELECT * FROM messages', 'SELECT * FROM agents', 'SELECT * FROM channels', 'SELECT * FROM wake_message_outbox'].map(statement => ({ sql: statement })));
  const before = (await snapshot()).map(r => r.results);
  for (const path of ['/channels/', '/channels/general/', `/channels/general/messages/${signed.id}/`]) {
    const head = await get(path, { method: 'HEAD' });
    assert.equal(head.response.status, 200); assert.equal(head.text, '');
    assert.equal((await get(path)).response.status, 200);
  }
  assert.deepEqual((await snapshot()).map(r => r.results), before);
});

test('write methods fail before database reads and are not GET-write aliases', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const { response } = await get('/channels/', { method });
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

if (process.env.OAF_BROWSE_PLAYWRIGHT) {
  test('optional browser: no-JS links, narrow layouts and explicitly bounded live refresh', { timeout: 60_000 }, async () => {
    const { checkBrowser } = await import('./public-browse.browser.mjs');
    await checkBrowser({ worker, message, scratch });
  });
}
