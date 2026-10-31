import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as client from '../dist/index.js';
import { parseRoomInstallMode, preflightRoomRegistry, verifyRoomConsumerLock } from '../../../scripts/check-room-install.mjs';
import { releaseDirectories } from '../../../scripts/publish-packages.mjs';

test('client-only exports do not expose a hub, signer service or admission implementation', () => {
  assert.deepEqual(Object.keys(client).sort(), ['RoomClient', 'RoomClientError', 'RoomHttpClient', 'RoomHttpError',
    'RoomInvitationMailbox', 'RoomLocalState', 'RoomLocalStateError', 'closeRoom', 'readRoomStatus', 'recoverRoomOperation'].sort());
  const error = new client.RoomClientError('unavailable'); assert.equal(error.permitsReplacementMutation, false);
});
test('command artifact matches its small source closure, is executable and remains optional', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL('../dist/build-manifest.json', import.meta.url)));
  assert.deepEqual(pkg.bin, { 'oaf-room': './dist/cli.mjs' });
  assert.deepEqual(Object.keys(manifest.commands).sort(), ['cli-driver.mjs', 'cli-io.mjs', 'cli.mjs']);
  for (const [name, hash] of Object.entries(manifest.commands)) {
    const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    assert(bytes.equals(await readFile(new URL(`../src/${name}`, import.meta.url))));
  }
  assert.equal((await stat(new URL('../dist/cli.mjs', import.meta.url))).mode & 0o111, 0o111);
  const command = await readFile(new URL('../dist/cli.mjs', import.meta.url), 'utf8');
  assert.ok(command.startsWith('#!/usr/bin/env node\n'));
  assert.ok(command.includes(`const version = '${pkg.version}';`));
  for (const name of ['sdk', 'cli']) {
    const ordinary = JSON.parse(await readFile(new URL(`../../${name}/package.json`, import.meta.url)));
    assert.equal(ordinary.dependencies?.['@openagentforum/room-client'], undefined);
  }
});
test('artifact has complete client declarations and no hub implementation or workspace runtime dependency', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(Boolean(pkg.private), false);
  assert.deepEqual(pkg.publishConfig, { access: 'public' });
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@openagentforum/protocol', 'noise-handshake']);
  const code = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../dist/build-manifest.json', import.meta.url)));
  assert.equal(manifest.runtimeSha256, createHash('sha256').update(code).digest('hex'));
  assert.ok(manifest.declarations.includes('client-entry'));
  assert.ok(!/room_lab_|RoomAdmissionStore|D1Room|BudgetedRoomStore|private-room-http|@openagentforum\/room-admission/.test(code));
  for (const name of manifest.declarations) {
    const text = await readFile(new URL(`../dist/types/${name}.d.ts`, import.meta.url), 'utf8');
    assert.ok(!/request-gate|request-budget|\.\/sqlite\.js|\.\/d1-|@openagentforum\/room-admission/.test(text));
  }
});

test('registry consumer modes enforce strict anonymous preflight, no fallback and isolated lockfile closure (#337)', async () => {
  assert.deepEqual(parseRoomInstallMode([]), { mode: 'packed', registryProtocol: false, registryClient: false });
  assert.deepEqual(parseRoomInstallMode(['--registry-protocol']), { mode: 'registry-protocol', registryProtocol: true, registryClient: false });
  assert.deepEqual(parseRoomInstallMode(['--registry-client']), { mode: 'registry-client', registryProtocol: true, registryClient: true });
  for (const invalid of [['--unknown'], ['--registry-protocol', '--registry-client'], ['--publish']]) {
    assert.throws(() => parseRoomInstallMode(invalid), /Usage: node scripts\/check-room-install\.mjs/);
  }
  assert.equal(releaseDirectories.includes('room-client'), true);

  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const protocol = JSON.parse(await readFile(new URL('../../protocol/package.json', import.meta.url)));
  let calls = 0;
  assert.deepEqual(
    await preflightRoomRegistry({ mode: 'packed', pkg, protocol, fetchImpl: async () => { calls++; throw new Error('no network in packed preflight'); } }),
    { published: false, clientSource: 'packed', protocolSource: 'packed' },
  );
  assert.equal(calls, 0);

  // --registry-protocol verifies exact protocol identity on npm.
  assert.deepEqual(
    await preflightRoomRegistry({
      mode: 'registry-protocol', pkg, protocol,
      fetchImpl: async (url, init) => {
        assert.equal(url, `https://registry.npmjs.org/${encodeURIComponent(protocol.name)}/${encodeURIComponent(protocol.version)}`);
        assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
        return Response.json({ name: protocol.name, version: protocol.version });
      },
    }),
    { published: false, clientSource: 'packed', protocolSource: 'registry' },
  );

  // While a candidate remains private: true, --registry-client refuses even if protocol exists on npm.
  await assert.rejects(
    preflightRoomRegistry({
      mode: 'registry-client', pkg: { ...pkg, private: true }, protocol,
      fetchImpl: async () => Response.json({ name: protocol.name, version: protocol.version }),
    }),
    /candidate package is still private/,
  );

  // Negative preflight cases for public candidate metadata.
  const publicCandidate = { ...pkg, private: false };
  for (const failure of [404, 429, 503, 'redirected', 'wrong-name', 'wrong-protocol-dep', 'extra-dep']) {
    await assert.rejects(
      preflightRoomRegistry({
        mode: 'registry-client', pkg: publicCandidate, protocol,
        fetchImpl: async url => {
          if (String(url).includes(encodeURIComponent(protocol.name))) {
            return Response.json({ name: protocol.name, version: protocol.version });
          }
          if (typeof failure === 'number') return new Response('untrusted', { status: failure });
          if (failure === 'redirected') {
            const res = Response.json({ name: pkg.name, version: pkg.version });
            Object.defineProperty(res, 'redirected', { value: true });
            return res;
          }
          if (failure === 'wrong-name') return Response.json({ name: '@other/pkg', version: pkg.version });
          if (failure === 'wrong-protocol-dep') {
            return Response.json({
              name: pkg.name, version: pkg.version,
              dependencies: { '@openagentforum/protocol': '0.0.1', 'noise-handshake': pkg.dependencies['noise-handshake'] },
            });
          }
          return Response.json({
            name: pkg.name, version: pkg.version,
            dependencies: { ...pkg.dependencies, '@openagentforum/server': '1.0.0' },
          });
        },
      }),
      error => !error.message.includes('untrusted'),
    );
  }

  assert.deepEqual(
    await preflightRoomRegistry({
      mode: 'registry-client', pkg: publicCandidate, protocol,
      fetchImpl: async url => String(url).includes(encodeURIComponent(protocol.name))
        ? Response.json({ name: protocol.name, version: protocol.version })
        : Response.json({
          name: pkg.name, version: pkg.version,
          dependencies: { ...pkg.dependencies, '@openagentforum/protocol': protocol.version },
        }),
    }),
    { published: true, clientSource: 'registry', protocolSource: 'registry' },
  );

  const baseLock = {
    packages: {
      '': { name: 'oaf-clean-room-fixture', private: true },
      'node_modules/@openagentforum/room-client': { resolved: 'file:../packed/openagentforum-room-client-0.1.0.tgz' },
      'node_modules/@openagentforum/protocol': { resolved: 'file:../packed/openagentforum-protocol-2.3.0.tgz' },
      'node_modules/noise-handshake': { resolved: 'https://registry.npmjs.org/noise-handshake/-/noise-handshake-4.2.0.tgz' },
    },
  };
  verifyRoomConsumerLock({ lock: baseLock, mode: 'packed' });
  assert.throws(() => verifyRoomConsumerLock({ lock: baseLock, mode: 'registry-protocol' }), /Non-registry dependency/);

  const registryProtocolLock = structuredClone(baseLock);
  registryProtocolLock.packages['node_modules/@openagentforum/protocol'].resolved =
    'https://registry.npmjs.org/@openagentforum/protocol/-/protocol-2.3.0.tgz';
  verifyRoomConsumerLock({ lock: registryProtocolLock, mode: 'registry-protocol' });
  assert.throws(() => verifyRoomConsumerLock({ lock: registryProtocolLock, mode: 'registry-client' }), /Non-registry dependency/);

  const registryClientLock = structuredClone(registryProtocolLock);
  registryClientLock.packages['node_modules/@openagentforum/room-client'].resolved =
    'https://registry.npmjs.org/@openagentforum/room-client/-/room-client-0.1.0.tgz';
  verifyRoomConsumerLock({ lock: registryClientLock, mode: 'registry-client' });
});
