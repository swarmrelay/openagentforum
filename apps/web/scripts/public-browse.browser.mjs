// Optional local browser check. Supply an installed Playwright module and Chrome
// through operator environment variables; no browser or public data is downloaded.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function checkBrowser({ worker, message, scratch }) {
  const { chromium } = await import(pathToFileURL(process.env.OAF_BROWSE_PLAYWRIGHT).href);
  const browser = await chromium.launch({ headless: true, ...(process.env.OAF_BROWSE_CHROME ? { executablePath: process.env.OAF_BROWSE_CHROME } : {}) });
  const origin = 'https://openagentforum.com';
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };
  const requests = [], errors = [];
  let channelReads = 0;
  try {
    for (let n = 1; n <= 22; n++) await message(n);
    for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 }, colorScheme });
      await intercept(context);
      const page = await context.newPage();
      await page.goto(origin + '/channels/');
      assert.equal(await page.getByRole('link', { name: 'Read this page as Markdown', exact: true }).getAttribute('href'), '/channels/index.md');
      assert.ok(await page.locator('[data-public-refresh]').isHidden(), 'No dead refresh button without JavaScript');
      const cardStyle = await page.locator('.public-channel').first().evaluate(card => ({ padding: parseFloat(getComputedStyle(card).paddingTop), link: getComputedStyle(card.querySelector('a')).textDecorationLine }));
      assert.ok(cardStyle.padding <= 32, 'Long-form article padding must not override compact cards');
      assert.ok(cardStyle.link.includes('underline'), 'Directory links remain visibly clickable');
      await page.screenshot({ path: join(process.env.OAF_BROWSE_SCREENSHOTS ?? scratch, `public-directory-${width}-${colorScheme}.png`), fullPage: true });
      await page.locator('[data-public-record] a[href="/channels/general/"]').click();
      assert.equal(await page.locator('[data-record-id]').count(), 20);
      await page.getByRole('link', { name: 'Older messages →', exact: true }).click();
      assert.equal(await page.locator('[data-record-id]').count(), 2);
      assert.equal(await page.getByRole('link', { name: 'Read this page as Markdown', exact: true }).getAttribute('href'), '/channels/general/index.md?before=3');
      await page.getByRole('link', { name: 'Message general-1', exact: true }).click();
      assert.equal(await page.locator('[data-record-id]').count(), 1);
      assert.ok(await page.getByRole('link', { name: 'Markdown record', exact: true }).isVisible());
      assert.ok(await page.locator('[data-participation-invite]').isVisible());
      const dimensions = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
      assert.ok(dimensions.content <= dimensions.width, `Horizontal overflow at ${width}/${colorScheme}`);
      await page.screenshot({ path: join(process.env.OAF_BROWSE_SCREENSHOTS ?? scratch, `public-browse-${width}-${colorScheme}.png`), fullPage: true });
      await page.locator('[data-channel-reading-help] a[href="/recent/"]').click();
      assert.equal(await page.locator('h1').textContent(), 'Recent changes');
      assert.equal(await page.locator('[data-record-id]').count(), 20);
      assert.equal(await page.getByRole('link', { name: 'Read this page as Markdown', exact: true }).getAttribute('href'), '/recent/index.md');
      assert.ok(await page.getByRole('link', { name: 'Check for newer arrivals', exact: true }).isVisible());
      const recentDimensions = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
      assert.ok(recentDimensions.content <= recentDimensions.width, `Recent changes overflow at ${width}/${colorScheme}`);
      await page.screenshot({ path: join(process.env.OAF_BROWSE_SCREENSHOTS ?? scratch, `public-recent-${width}-${colorScheme}.png`), fullPage: true });
      await page.getByRole('link', { name: 'Older arrivals →', exact: true }).click();
      assert.equal(await page.locator('[data-record-id]').count(), 2);
      await page.getByRole('link', { name: 'Message general-1', exact: true }).click();
      assert.equal(await page.locator('[data-record-id]').count(), 1);
      await page.goto(origin + '/tasks/');
      assert.equal(await page.locator('[data-task-id]').count(), 20);
      assert.ok(await page.locator('#task-signing').isVisible());
      assert.ok(await page.getByRole('link', { name: 'More tasks →', exact: true }).isVisible());
      await page.getByRole('link', { name: 'More tasks →', exact: true }).click();
      assert.equal(await page.locator('[data-task-id]').count(), 2);
      await page.getByRole('link', { name: 'Task bulk_000001', exact: true }).click();
      assert.equal(await page.locator('[data-task-id]').count(), 1);
      assert.equal(await page.getByRole('link', { name: 'Read this page as Markdown', exact: true }).getAttribute('href'), '/tasks/bulk_000001/index.md');
      assert.ok(await page.locator('[data-participation-invite]').isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Task overflow at ${width}/${colorScheme}`);
      const taskStyle = await page.locator('.tk-card').evaluate(card => ({ padding: parseFloat(getComputedStyle(card).paddingTop), link: getComputedStyle(card.querySelector('a')).textDecorationLine }));
      assert.ok(taskStyle.padding <= 32); assert.ok(taskStyle.link.includes('underline'));
      await page.screenshot({ path: join(process.env.OAF_BROWSE_SCREENSHOTS ?? scratch, `public-task-${width}-${colorScheme}.png`), fullPage: true });
      await page.getByRole('link', { name: 'Open tasks requesting research', exact: true }).click();
      assert.equal(await page.locator('[data-task-id]').count(), 20);
      assert.ok(page.url().endsWith('/tasks/?capability=research'));
      await page.getByRole('link', { name: 'completed', exact: true }).click();
      assert.equal(await page.locator('[data-task-id]').count(), 0);
      assert.ok((await page.locator('[data-public-record]').innerText()).includes('No matching public tasks in this scan'));
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await intercept(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.goto(origin + '/channels/general/');
    await page.waitForLoadState('networkidle');
    const initialReads = channelReads;
    await page.clock.runFor(16_000);
    assert.equal(channelReads, initialReads, 'No polling before explicit start');
    await message(23);
    await page.getByRole('button', { name: 'Start live refresh', exact: true }).click();
    await page.clock.runFor(15_000);
    await page.locator('[data-record-id="general-23"]').waitFor();
    assert.equal(channelReads, initialReads + 1);
    await page.getByRole('button', { name: 'Stop live refresh', exact: true }).click();
    await page.clock.runFor(30_000);
    assert.equal(channelReads, initialReads + 1, 'Stop cancels further reads');
    await page.getByRole('button', { name: 'Start live refresh', exact: true }).click();
    await page.clock.fastForward(300_000);
    await page.getByRole('button', { name: 'Start live refresh', exact: true }).waitFor();
    const finishedReads = channelReads;
    await page.clock.runFor(30_000);
    assert.equal(channelReads, finishedReads, 'Five-minute session ends without new reads');
    assert.deepEqual(errors, []);
    assert.ok(requests.every(request => ['GET', 'HEAD'].includes(request.method)));
    await context.close();
  } finally { await browser.close(); }

  async function intercept(context) {
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      requests.push({ method: request.method(), path: url.pathname });
      if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
        errors.push('Unexpected browser request'); await route.abort(); return;
      }
      if (url.pathname.startsWith('/channels/') || url.pathname.startsWith('/recent/') || url.pathname.startsWith('/tasks/')) {
        if (url.pathname === '/channels/general/') channelReads++;
        const response = await worker.fetch(url.href, { method: request.method(), signal: AbortSignal.timeout(10_000) });
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
      } else {
        const path = resolve(dist, `.${url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname}`);
        if (!path.startsWith(dist.replace(/\/$/, '') + sep)) throw new Error('Asset escaped build directory');
        await route.fulfill({ contentType: types[extname(path)] ?? 'application/octet-stream', body: await readFile(path) });
      }
    });
  }
}
