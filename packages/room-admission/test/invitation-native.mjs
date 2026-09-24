import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';

test('independent agents privately invite, explicitly accept, exchange untrusted data, recover and close through real Pages/D1 adapters', { timeout: 45000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'oaf-room-invitation-native-'));
  const previous = process.env.MINIFLARE_WORKERD_PATH, children = [];
  let mf, outbound = 0;
  try {
    process.env.MINIFLARE_WORKERD_PATH = workerd.default;
    const pages = JSON.parse(await readFile(new URL('../../../apps/web/wrangler.jsonc', import.meta.url), 'utf8'));
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/invitation-worker.mjs', import.meta.url))],
      bundle: true, write: false, format: 'esm', platform: 'neutral', metafile: true, external: ['node:*', 'cloudflare:*'] });
    assert.ok(Object.values(bundle.metafile.outputs).every(o => o.imports.length === 0));
    assert.ok(Object.keys(bundle.metafile.inputs).every(path => !/noise|local-state|local-files|invitation-mailbox/.test(path)));
    mf = new Miniflare({ host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
      telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'),
      workers: [{ config: { type: 'worker', name: 'room-invitation-test', compatibilityDate: pages.compatibility_date,
        compatibilityFlags: [], workersDev: false, previewUrls: false, domains: [], triggers: [],
        env: { DB: { type: 'd1', id: 'room-invitation-local', dev: { remote: false } } },
        manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
      }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { outbound++; throw new Error('No outbound traffic'); } } } }],
    });
    const endpoint = (await mf.ready).origin, worker = await mf.getWorker('room-invitation-test');
    const sql = async statements => {
      const response = await worker.fetch('https://fixture.invalid/test-only/sql', { method: 'POST', body: JSON.stringify(statements) });
      assert.equal(response.status, 200); return response.json();
    };
    const migrations = new URL('../../../apps/web/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
      const schema = (await readFile(new URL(file, migrations), 'utf8')).replace(/^\s*--.*$/gm, '');
      const trigger = schema.indexOf('CREATE TRIGGER '), ordinary = trigger < 0 ? schema : schema.slice(0, trigger);
      await sql(ordinary.split(';').filter(s => s.trim())); if (trigger >= 0) await sql([schema.slice(trigger)]);
    }
    assert.equal((await worker.fetch('https://fixture.invalid/test-only/init', { method: 'POST' })).status, 200);
    const launch = async role => {
      const directory = join(scratch, role); await mkdir(directory, { mode: 0o700 });
      const child = fork(fileURLToPath(new URL('./fixtures/invitation-agent.mjs', import.meta.url)), [role, directory, endpoint],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
      const record = { child, messages: [], bytes: 0, exited: false }; children.push(record);
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      record.exit = new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('exit', (code, signal) => {
        clearTimeout(timer); record.exited = true; resolve(signal ? -1 : code); }); });
      const bound = chunk => { record.bytes += chunk.length; if (record.bytes > 8192) child.kill('SIGKILL'); };
      child.stdout.on('data', bound); child.stderr.on('data', bound); // never print child diagnostics or peer content
      child.on('message', message => {
        if (record.messages.length >= 5 || JSON.stringify(message).length > 1024) { child.kill('SIGKILL'); return; }
        record.messages.push(message);
      });
      record.wait = async kind => {
        const deadline = performance.now() + 15000;
        while (performance.now() < deadline) {
          const message = record.messages.find(m => m.kind === kind); if (message) return message;
          const failure = record.messages.find(m => m.kind === 'failed');
          const stage = ['initialize', 'key-exchange', 'offer', 'accept', 'session', 'owner-data', 'owner-recovery', 'peer-data', 'peer-close'].includes(failure?.phase) ? failure.phase : 'unknown';
          assert.equal(!!failure || record.exited, false, `Local ${role} fixture stopped before ${kind} at ${stage}`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail('Local fixture stage deadline');
      };
      return record;
    };
    const [owner, peer] = await Promise.all([launch('owner'), launch('peer')]);
    const identities = await Promise.all([owner.wait('identity'), peer.wait('identity')]);
    assert.notEqual(identities[0].signingPublicKey, identities[1].signingPublicKey);
    const channel = 'room-setup-' + crypto.randomUUID().replaceAll('-', '');
    for (const [i, actor] of [owner, peer].entries()) actor.child.send({ kind: 'select', channel,
      peerKey: identities[1 - i].signingPublicKey, peerId: identities[1 - i].agentId });
    await peer.wait('invitation-awaits-explicit-acceptance');
    const before = await sql(["SELECT json_extract(receipt_json,'$.action') AS action FROM room_lab_receipts ORDER BY json_extract(receipt_json,'$.revision')"]);
    assert.deepEqual(before[0].results.map(r => r.action), ['create', 'invite']); // decryption did not join
    peer.child.send({ kind: 'accept' }); // explicit trusted fixture consent, not a command found in a forum message
    const completed = await Promise.all([owner.wait('closed'), peer.wait('closed')]);
    assert.deepEqual(completed[0], completed[1]);
    assert.deepEqual(await Promise.all([owner.exit, peer.exit]), [0, 0]); // natural exit, no persistent agent listener/timer
    const rows = await sql(['SELECT type,payload_json FROM messages', "SELECT json_extract(receipt_json,'$.action') AS action FROM room_lab_receipts ORDER BY json_extract(receipt_json,'$.revision')",
      'SELECT count(*) AS n FROM room_lab_packets', 'SELECT count(*) AS n FROM agents']);
    assert.equal(rows[0].results.length, 4); assert.equal(rows[0].results.filter(r => r.type === 'e2ee_blob').length, 2);
    const publicRecords = JSON.stringify(rows[0].results);
    assert.ok(!publicRecords.includes(completed[0].roomId)); assert.ok(!publicRecords.includes(completed[0].sessionId));
    assert.ok(!publicRecords.includes('execute code')); assert.ok(!publicRecords.includes('invitationDigest'));
    assert.deepEqual(rows[1].results.map(r => r.action), ['create', 'invite', 'accept', 'close']);
    assert.equal(rows[2].results[0].n, 6); assert.equal(rows[3].results[0].n, 2);
    assert.equal(outbound, 0);
  } finally {
    for (const c of children) if (!c.exited) c.child.kill('SIGKILL');
    await Promise.all(children.map(c => c.exit)); await mf?.dispose();
    if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previous;
    await rm(scratch, { recursive: true, force: true });
  }
});
