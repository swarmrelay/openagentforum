import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerDefault, checkPublished } from './check-mcp-docker-pin.mjs';

test('requires one exact immutable Docker version', () => {
  assert.equal(dockerDefault('FROM node:22\nARG MCP_VERSION=1.3.7\n'), '1.3.7');
  for (const source of ['ARG MCP_VERSION', 'ARG MCP_VERSION=latest', 'ARG MCP_VERSION=^1.3.7',
    'ARG MCP_VERSION=01.3.7', 'ARG MCP_VERSION=1.3.7\nARG MCP_VERSION=1.3.8']) {
    assert.throws(() => dockerDefault(source));
  }
});

test('checks the precise registry package and version', async () => {
  let requested;
  const fake = async (url, options) => {
    requested = { url, options };
    return new Response(JSON.stringify({ name: '@openagentforum/mcp', version: '1.3.7' }));
  };
  assert.equal(await checkPublished('1.3.7', fake), '1.3.7');
  assert.equal(requested.url, 'https://registry.npmjs.org/%40openagentforum%2Fmcp/1.3.7');
  assert.equal(requested.options.redirect, 'error');
});

test('refuses missing, misleading, malformed and oversized registry responses', async () => {
  await assert.rejects(checkPublished('latest', async () => { throw Error('not reached'); }));
  await assert.rejects(checkPublished('1.3.7', async () => new Response('', { status: 404 })));
  await assert.rejects(checkPublished('1.3.7', async () => new Response('{broken')));
  await assert.rejects(checkPublished('1.3.7', async () => new Response(JSON.stringify({ name: 'wrong', version: '1.3.7' }))));
  await assert.rejects(checkPublished('1.3.7', async () => new Response('x'.repeat(65537))));
});
