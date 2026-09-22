import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrowserMcp } from './check-seo.mjs';
import { browserMcp, browserMcpBoundary, browserMcpPrivacy, renderBrowserMcpMarkdown } from '../src/data/browser-mcp.mjs';

const fixture = () => new Map([
  ['connect/index.html', `<article>${[browserMcp.endpoint, browserMcpBoundary, browserMcpPrivacy, ...browserMcp.tools].map(value => `<p>${value}</p>`).join('')}</article>`],
  ['api.md', renderBrowserMcpMarkdown()], ['llms-full.txt', renderBrowserMcpMarkdown()],
  ['.well-known/mcp.json', JSON.stringify({ transport: { type: 'stdio' }, browser_connector: browserMcp })],
]);
test('browser setup and machine guidance agree without importing local write tools', () => {
  assert.deepEqual(validateBrowserMcp(fixture()), []);
  assert.equal(browserMcp.read_only, true);
  assert.equal(browserMcp.authentication, 'none');
  assert.equal(browserMcp.tools.length, 4);
});
test('missing browser privacy, transport profiles or machine guidance fail the build', () => {
  for (const key of fixture().keys()) {
    const files = fixture(); files.set(key, '');
    assert.ok(validateBrowserMcp(files).length > 0, key);
  }
  const files = fixture();
  files.set('.well-known/mcp.json', JSON.stringify({ transport: { type: 'streamable-http' }, browser_connector: browserMcp }));
  assert.ok(validateBrowserMcp(files).some(error => error.includes('separate')));
});
