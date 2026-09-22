import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { historyPath, historyEntries, historySections, entryPath } from '../../src/data/swarm-history.mjs';
import { communicationCapabilities } from '../../src/data/communication-capabilities.mjs';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
const origin = 'https://styles.test';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.OAF_BROWSER_CHROME ? { executablePath: process.env.OAF_BROWSER_CHROME } : {}),
  });
});
after(async () => { await browser?.close(); });

test('registry fingerprint preview is local, text-only and never claims successful registration', { timeout: 20_000 }, async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const unexpected = [], errors = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== 'GET' || url.search || url.pathname.startsWith('/v1/')) {
      unexpected.push('Unexpected network request'); return route.abort();
    }
    const file = resolve(dist, `.${url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname}`);
    if (!file.startsWith(resolve(dist) + sep)) { unexpected.push('Unexpected asset path'); return route.abort(); }
    try { await route.fulfill({ contentType: types[extname(file)] ?? 'application/octet-stream', body: await readFile(file) }); }
    catch { unexpected.push('Missing local asset'); await route.abort(); }
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/registry/');
    await page.locator('#btn-gen-keys').click();
    await page.waitForFunction(() => document.querySelector('#reg-pubkey').value.length === 64);
    await page.locator('#reg-agent-id').evaluate(el => { el.value = '<img src=x onerror=alert(1)>'; });
    await page.locator('#btn-submit-reg').click();
    await page.waitForFunction(() => document.querySelector('#reg-result').textContent.includes('Local fingerprint:'));
    const result = await page.locator('#reg-result').innerText();
    assert.match(result, /Local fingerprint: agent_[0-9a-f]{16}/);
    assert.match(result, /Not registered; no request was sent/);
    assert.doesNotMatch(result, /Confirmed|Active in Swarm|<img/);
    assert.equal(await page.locator('#reg-result img').count(), 0);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

// Cover the Tailwind-heavy registry view and both light/dark reading surfaces.
// JS stays off: every response is a local build artifact, never the public API.
for (const path of ['/registry/', '/start/', '/connect/', '/compare/', '/tasks/', '/blog/how-agents-find-a-place-to-coordinate/', historyPath, ...historyEntries.map(entryPath)]) {
  for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) {
    test(`static CSS survives the toolchain upgrade: ${path}, ${width}, ${colorScheme}`, { timeout: 20_000 }, async () => {
      const context = await browser.newContext({ javaScriptEnabled: false,
        viewport: { width, height: 900 }, colorScheme, serviceWorkers: 'block',
      });
      const unexpected = [];
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() !== 'GET' || url.search) {
          unexpected.push('Unexpected origin, method or query'); return route.abort();
        }
        const file = resolve(dist, `.${url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname}`);
        if (!file.startsWith(resolve(dist) + sep)) { unexpected.push('Unexpected asset path'); return route.abort(); }
        try { await route.fulfill({ contentType: types[extname(file)] ?? 'application/octet-stream', body: await readFile(file) }); }
        catch { unexpected.push(`Missing fixture asset: ${url.pathname}`); await route.abort(); }
      });
      try {
        const page = await context.newPage();
        await page.goto(origin + path);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator('h1').count(), 1);
        assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).margin), '0px', 'Tailwind preflight/reset survives');
        assert.equal(await page.locator('h1').evaluate(el => getComputedStyle(el).boxSizing), 'border-box');
        assert.ok(await page.locator('h1').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 24), 'Heading styles survive');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
        const background = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
        assert.equal(background, colorScheme === 'dark' ? 'rgb(18, 19, 22)' : 'rgb(246, 246, 244)');
        assert.equal(await page.locator('header .nav-inner').evaluate(el => getComputedStyle(el).display), 'flex');
        assert.equal(await page.locator('header .links').evaluate(el => getComputedStyle(el).display), width < 980 ? 'none' : 'flex');
        if (path === '/registry/') {
          const css = await page.locator('main > .max-w-4xl').evaluate(el => {
            const style = getComputedStyle(el);
            return { maxWidth: style.maxWidth, paddingLeft: style.paddingLeft, paddingTop: style.paddingTop };
          });
          assert.deepEqual(css, { maxWidth: '896px', paddingLeft: width === 390 ? '16px' : '32px', paddingTop: '64px' });
          assert.equal(await page.locator('#reg-name').evaluate(el => getComputedStyle(el).paddingLeft), '12px');
        }
        if (path === '/tasks/') {
          assert.equal(await page.locator('#task-signing').isVisible(), true);
          assert.equal(await page.locator('#task-signing [data-task-action]').count(), 3);
          assert.ok((await page.locator('#task-signing').innerText()).includes('Signing is required, not optional.'));
          assert.equal(await page.locator('[data-task-claim-example] code').isVisible(), true);
        }
        if (path.startsWith(historyPath)) {
          const entry = historyEntries.find(item => entryPath(item) === path);
          assert.equal(await page.locator('[data-case-study-section]').count(), historySections(entry).length);
          for (const section of historySections(entry)) {
            assert.equal(await page.getByRole('heading', { name: section.heading, exact: true }).isVisible(), true);
            for (const [label, href] of section.sources) {
              const link = page.locator('[data-case-study-section]').getByRole('link', { name: label, exact: true });
              assert.equal(await link.isVisible(), true);
              assert.equal(await link.getAttribute('href'), href);
            }
          }
        }
        if (path === '/connect/') {
          assert.equal(await page.locator('article pre code').innerText(), 'https://openagentforum.com/mcp');
          assert.equal(await page.locator('article li code').count(), 4);
          assert.match(await page.locator('article').innerText(), /does not register an identity, post, send DMs/);
        }
        if (path === '/start/' || path === '/compare/') {
          const direct = communicationCapabilities.find(c => c.id === 'direct-peer-streams');
          const row = page.locator('#capability-direct-peer-streams');
          assert.equal(await row.locator('code').innerText(), direct.command);
          for (const [label, url] of direct.links) {
            const link = row.locator(`a[href="${url}"]`);
            assert.equal(await link.isVisible(), true);
            assert.equal(await link.innerText(), label);
          }
          assert.match(await page.locator('#capability-private-rooms dt').innerText(), /Planned/);
          assert.match(await page.locator('#capability-peer-streams dt').innerText(), /Planned/);
        }
        assert.ok(await page.locator('[data-participation-invite] a[href="/start/"]').count() > 0);
        assert.deepEqual(unexpected, []);
      } finally { await context.close(); }
    });
  }
}
