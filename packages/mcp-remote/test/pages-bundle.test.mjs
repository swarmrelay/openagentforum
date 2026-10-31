import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import workerd from 'workerd';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { generateAgentKeyPair } from '../../protocol/dist/index.js';
import { ROOM_CONTROL_PROTOCOL, deriveRoomId, signRoomControl } from '../../room-admission/dist/control.js';
import { ROOM_PACKET_RECOVERY_PROTOCOL, signRoomPacketRecovery } from '../../room-admission/dist/packet-wire.js';
import { browserMcp } from '../../../apps/web/src/data/browser-mcp.mjs';
import { compilerEnvironment, runCompiler } from './helpers/compiler-process.mjs';

test('actual Wrangler Pages bundle compiles without registry access and routes browser MCP, A2A, discovery and public reads in workerd', { timeout: 90_000 }, async t => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), 'oaf-pages-mcp-'));
  const oldRuntime = process.env.MINIFLARE_WORKERD_PATH;
  let mf, client, outbound = 0, registryRequests = 0;
  // A cold version-check cache plus a stalled LOCAL registry makes accidental
  // update traffic deterministic without contacting npm. Never inspect/log headers.
  // No response means the old update-check timeout leaves its socket referenced.
  const registry = createServer(() => { registryRequests++; });
  try {
    registry.listen(0, '127.0.0.1'); await once(registry, 'listening');
    const config = JSON.parse(await readFile(join(root, 'apps/web/wrangler.jsonc'), 'utf8'));
    // Run the installed CLI entry directly, avoiding pnpm + bin-wrapper descendants.
    const wrangler = createRequire(join(root, 'package.json')).resolve('wrangler');
    const compilation = await runCompiler(process.execPath, ['--no-warnings', wrangler, 'pages', 'functions', 'build', 'apps/web/functions',
      '--project-directory=apps/web', `--outdir=${scratch}/bundle`, `--metafile=${scratch}/meta.json`,
      `--compatibility-date=${config.compatibility_date}`, `--compatibility-flags=${config.compatibility_flags.join(',')}`,
    ], { cwd: root, signal: t.signal, env: compilerEnvironment({ ...process.env,
      TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      // The pinned registry-url dependency uses rc's npm_ prefix, not npm_config_.
      npm_registry: `http://127.0.0.1:${registry.address().port}/`,
    }) });
    t.diagnostic(`Pages compiler: ${JSON.stringify(compilation)}`);
    assert.equal(registryRequests, 0, 'compilation must not request npm version metadata');
    const metadata = JSON.parse(await readFile(join(scratch, 'meta.json'), 'utf8'));
    const inputs = Object.keys(metadata.inputs);
    assert.ok(inputs.some(path => path.includes('/shimsWorkerd.mjs')));
    assert.ok(!inputs.some(path => /\/shimsNode\.|packages\/(?:mcp|sdk|mesh|peer-stream)\/dist\//.test(path)), 'no local identity/stdio/peer runtime in Pages');
    assert.ok(inputs.some(path => /private-room-http\.ts$/.test(path)), 'private-room Pages route is mounted');
    const compiled = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/pages-bundle.mjs', import.meta.url))],
      alias: { 'oaf-pages-test-bundle': join(scratch, 'bundle/index.js') }, bundle: true, write: false,
      format: 'esm', platform: 'neutral', conditions: ['workerd'], external: ['node:*', 'cloudflare:*'] });
    process.env.MINIFLARE_WORKERD_PATH = workerd.default;
    mf = new Miniflare({ host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', cf: false,
      telemetry: { enabled: false }, logRequests: false, resourceTmpPath: join(scratch, 'runtime'),
      workers: [{ config: { name: 'pages-mcp-test', compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags, workersDev: false, previewUrls: false, domains: [], triggers: [],
        env: { DB: { type: 'd1', id: 'pages-mcp-local', dev: { remote: false } } },
        manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: compiled.outputFiles[0].text } } },
      }, dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler() { outbound++; throw new Error('No outbound requests'); } } } }],
    });
    await mf.ready;
    const worker = await mf.getWorker('pages-mcp-test');
    const sql = async statements => {
      const response = await worker.fetch('https://fixture.invalid/sql', { method: 'POST', body: JSON.stringify(statements) });
      assert.equal(response.status, 200);
      assert.ok((await response.json()).every(result => result.success));
    };
    const migrations = join(root, 'apps/web/migrations');
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
      const schema = (await readFile(join(migrations, file), 'utf8')).replace(/^\s*--.*$/gm, '');
      const trigger = schema.indexOf('CREATE TRIGGER ');
      await sql((trigger < 0 ? schema : schema.slice(0, trigger)).split(';').filter(s => s.trim()));
      if (trigger >= 0) await sql([schema.slice(trigger)]);
    }
    await sql([
      "INSERT INTO channels (name,title,topic,creator_id,created_at,is_private,e2ee_required,allowed_agents_json) VALUES ('general','General','Fixture','fixture',1,0,0,'[]')",
      `INSERT INTO messages (id,channel,sender,type,sequence,stored_seq,timestamp,payload_json,signature,checksum,encrypted) VALUES ('fixture-1','general','fixture','intel',1,1,1,'{"message":"LOCAL PUBLIC FIXTURE"}','invalid','invalid',0)`,
    ]);
    client = new Client({ name: 'pages-bundle-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StreamableHTTPClientTransport(new URL(browserMcp.endpoint), {
      fetch: (input, init) => worker.fetch(new Request(input, init)),
    });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), browserMcp.tools);
    for (const [name, args] of [['list_channels', {}], ['read_channel', { channel: 'general' }],
      ['read_message', { channel: 'general', message_id: 'fixture-1' }], ['recent_public_activity', {}]]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.match(result.content[0].text, /untrusted/);
    }
    assert.equal(transport.sessionId, undefined);
    const manifest = await (await worker.fetch('https://openagentforum.com/v1/mcp')).json();
    assert.deepEqual(manifest.browser_connector, browserMcp);
    assert.equal(manifest.transport.type, 'stdio');
    assert.equal(manifest.tools.length, 18); // stdio profile; campaign tools removed in MCP 1.3.0 (#360)
    assert.equal((await worker.fetch(browserMcp.endpoint)).status, 405);
    const preflight = await worker.fetch(browserMcp.endpoint, { method: 'OPTIONS', headers: { 'x-fixture-browser-origin': 'https://chatgpt.com' } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /MCP-Method/);
    // The separate A2A route (packages/a2a-remote) is mounted in the same bundle.
    const a2a = await worker.fetch('https://openagentforum.com/a2a', { method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: 'm1', parts: [{ text: 'read_message general fixture-1' }] } } }) });
    assert.equal(a2a.status, 200);
    const { result } = await a2a.json();
    assert.equal(result.task.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(result));
    assert.match(result.task.artifacts[0].parts[0].text, /LOCAL PUBLIC FIXTURE/);
    assert.match(result.task.artifacts[0].parts[0].text, /untrusted/);
    const roomGet = await worker.fetch('https://openagentforum.com/v1/rooms/control');
    assert.equal(roomGet.status, 405);
    assert.equal(roomGet.headers.get('allow'), 'POST');
    const roomPost = await worker.fetch('https://openagentforum.com/v1/rooms/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-oaf-signing-key': '1'.repeat(64) },
      body: '{}',
    });
    assert.deepEqual({ status: roomPost.status, body: await roomPost.json() }, { status: 409, body: { ok: false, error: 'room_request_unavailable' } });
    const owner = await generateAgentKeyPair();
    const now = Date.now(), requestId = 'a'.repeat(32);
    const roomId = await deriveRoomId('https://openagentforum.com', owner.agentId, requestId);
    const createWire = await signRoomControl({
      protocol: ROOM_CONTROL_PROTOCOL, hub: 'https://openagentforum.com', roomId, actor: owner.agentId,
      requestId, issuedAt: now, expiresAt: now + 60_000, expectedRevision: 0, action: 'create',
      payload: { encryptionPublicKey: owner.encryptionPublicKey },
    }, owner.signingPrivateKey);
    const created = await worker.fetch('https://openagentforum.com/v1/rooms/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-oaf-signing-key': owner.signingPublicKey },
      body: createWire,
    });
    assert.equal(created.status, 200);
    const createdJson = await created.json();
    assert.equal(createdJson.ok, true);
    assert.equal(createdJson.receipt.roomId, roomId);
    assert.equal(createdJson.receipt.action, 'create');
    const packetRecoveryWire = await signRoomPacketRecovery({
      protocol: ROOM_PACKET_RECOVERY_PROTOCOL, hub: 'https://openagentforum.com', roomId,
      actor: owner.agentId, signingPublicKey: owner.signingPublicKey,
      queryId: 'b'.repeat(32), requestId: 'c'.repeat(32), proofDigest: 'd'.repeat(64),
      issuedAt: now, expiresAt: now + 60_000,
    }, owner.signingPrivateKey);
    const packetRecovered = await worker.fetch('https://openagentforum.com/v1/rooms/packets/recovery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: packetRecoveryWire,
    });
    assert.equal(packetRecovered.status, 200);
    const packetRecoveredJson = await packetRecovered.json();
    assert.equal(packetRecoveredJson.ok, true);
    assert.equal(packetRecoveredJson.queryId, 'b'.repeat(32));
    assert.equal(packetRecoveredJson.receipt, null);
    assert.ok(packetRecoveredJson.observedAt >= createdJson.receipt.committedAt);
  } finally {
    try { await client?.close(); }
    finally {
      try { await mf?.dispose(); }
      finally {
        if (oldRuntime === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
        else process.env.MINIFLARE_WORKERD_PATH = oldRuntime;
        registry.closeAllConnections();
        try { await new Promise(resolve => registry.close(resolve)); }
        finally { await rm(scratch, { recursive: true, force: true }); }
      }
    }
  }
  assert.equal(outbound, 0);
});
