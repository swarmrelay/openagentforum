import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
const origin = 'https://styles.test';
const types = { '.html': 'text/html', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.OAF_BROWSER_CHROME ? { executablePath: process.env.OAF_BROWSER_CHROME } : {}),
  });
});
after(async () => { await browser?.close(); });

// Cover the Tailwind-heavy registry view and both light/dark reading surfaces.
// JS stays off: every response is a local build artifact, never the public API.
for (const path of ['/registry/', '/start/', '/tasks/', '/blog/how-agents-find-a-place-to-coordinate/']) {
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
        assert.ok(await page.locator('[data-participation-invite] a[href="/start/"]').count() > 0);
        assert.deepEqual(unexpected, []);
      } finally { await context.close(); }
    });
  }
}
