import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
const origin = 'https://homepage.test';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg' };
const fixtures = new Map([
  ['/v1/status', { stats: { total_agents: 2, total_channels: 1, total_messages: 0, open_tasks: 0 } }],
  ['/v1/channels/general/messages', { messages: [] }],
  ['/v1/agents', { agents: [] }],
  ['/v1/polls?status=open', { polls: [] }],
]);
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.OAF_BROWSER_CHROME ? { executablePath: process.env.OAF_BROWSER_CHROME } : {}),
  });
});
after(async () => { await browser?.close(); });

async function openHomepage({ width = 1280, colorScheme = 'light', reducedMotion = 'no-preference', mode = 'enabled' } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: mode !== 'disabled',
    viewport: { width, height: 900 }, colorScheme, reducedMotion, serviceWorkers: 'block',
  });
  const unexpected = [], errors = [];
  let blockedScripts = 0, loadedScripts = 0;
  // No listener, production data, third-party requests or fallback network path.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== 'GET') {
      unexpected.push('Unexpected origin or write method'); return route.abort();
    }
    if (fixtures.has(url.pathname + url.search)) return route.fulfill({ json: fixtures.get(url.pathname + url.search) });
    if (request.resourceType() === 'script') {
      if (mode === 'blocked') { blockedScripts++; return route.abort('failed'); }
      loadedScripts++;
    }
    const path = resolve(dist, `.${url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname}`);
    if (!path.startsWith(resolve(dist) + sep) || url.search) {
      unexpected.push('Unexpected asset path'); return route.abort();
    }
    try { await route.fulfill({ contentType: types[extname(path)] ?? 'application/octet-stream', body: await readFile(path) }); }
    catch { unexpected.push(`Missing fixture asset: ${url.pathname}`); await route.abort(); }
  });
  if (mode === 'no-observer') await context.addInitScript(() => { delete window.IntersectionObserver; });
  if (mode === 'broken-observer') await context.addInitScript(() => {
    window.IntersectionObserver = class { constructor() { throw new Error('fixture observer unavailable'); } };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin);
    await page.evaluate(() => document.fonts.ready);
    return { page, close: async () => {
      await context.close();
      assert.deepEqual(unexpected, [], 'Browser must use only local fixtures and static assets');
      assert.deepEqual(errors, mode === 'broken-observer' ? ['fixture observer unavailable'] : []);
      if (mode === 'blocked') assert.ok(blockedScripts > 0, 'Actually block the built module');
      if (['enabled', 'no-observer', 'broken-observer'].includes(mode)) assert.ok(loadedScripts > 0, 'Exercise the real built module');
    } };
  } catch (error) { await context.close(); throw error; }
}

// Playwright's isVisible() accepts opacity:0. Inspect effective ancestor styles
// as well, so DOM-only visibility or a visible parent cannot mask hidden cards.
async function unreadable(page) {
  return page.evaluate(() => {
    const targets = document.querySelectorAll('.load, .watch, .watch .stagger li, .watch .stagger .cell, .watch a[href], .watch button, [data-participation-invite]');
    return [...targets].flatMap(target => {
      let opacity = 1;
      for (let el = target; el; el = el.parentElement) {
        const css = getComputedStyle(el);
        opacity *= Number(css.opacity);
        if (css.display === 'none' || css.visibility !== 'visible' || el.hidden || el.inert) return [`hidden: ${target.className}`];
      }
      const rect = target.getBoundingClientRect();
      return opacity < 0.99 || rect.width <= 0 || rect.height <= 0 ? [`transparent/empty: ${target.className}`] : [];
    });
  });
}

for (const mode of ['disabled', 'blocked', 'enabled', 'no-observer']) {
  for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`homepage remains readable: ${mode}, ${width}, ${colorScheme}, ${reducedMotion}`, { timeout: 20_000 }, async () => {
      const { page, close } = await openHomepage({ mode, width, colorScheme, reducedMotion });
      try {
        assert.equal(await page.locator('.watch').count(), 5);
        assert.equal(await page.locator('.watch .stagger .cell').count(), 7);
        assert.deepEqual(await unreadable(page), [], 'Initial content must be visible before a scroll observer runs');
        const sections = page.locator('.watch');
        for (let i = 0; i < await sections.count(); i++) {
          await sections.nth(i).evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
          if (mode === 'enabled' && reducedMotion !== 'reduce') {
            await page.waitForFunction(i => document.querySelectorAll('.watch')[i].classList.contains('in'), i, { timeout: 3000 });
          }
          assert.deepEqual(await unreadable(page), [], 'Scrolling/entrance motion cannot make content transparent');
        }
        if (reducedMotion === 'reduce') {
          await page.locator('.watch .stagger .cell').first().hover();
          assert.deepEqual(await page.locator('.load, .watch, .watch .stagger .cell').evaluateAll(elements => elements.filter(el => {
            const css = getComputedStyle(el); return css.animationName !== 'none' || css.transform !== 'none';
          }).map(el => el.className)), [], 'Reduced motion includes nested feature cards');
        }
        const start = page.locator('.watch a[href="/start/"]');
        await start.focus();
        assert.equal(await start.evaluate(el => document.activeElement === el), true);
        assert.deepEqual(await unreadable(page), [], 'Keyboard-focused content and its ancestors are visible');
        assert.equal(await start.evaluate(el => getComputedStyle(el.closest('.watch')).animationName), 'none');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
        if (width === 390 && ['enabled', 'no-observer'].includes(mode)) {
          await page.locator('.nav-burger').click();
          assert.equal(await page.locator('.nav-burger').getAttribute('aria-expanded'), 'true');
          assert.equal(await page.locator('#mobile-nav').evaluate(el => el.hidden), false);
        }
      } finally { await close(); }
    });
  }
}

test('a broken enhancement cannot hide the static content', { timeout: 20_000 }, async () => {
  const { page, close } = await openHomepage({ mode: 'broken-observer' });
  try { assert.deepEqual(await unreadable(page), []); } finally { await close(); }
});

test('changing to reduced motion cancels all active entrance animations', { timeout: 20_000 }, async () => {
  const { page, close } = await openHomepage();
  try {
    await page.evaluate(() => {
      document.querySelectorAll('.watch').forEach(el => el.classList.add('in'));
      document.getAnimations().filter(a => a.animationName === 'rise').forEach(a => a.pause());
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.watch .stagger .cell').first().hover();
    assert.deepEqual(await unreadable(page), []);
    assert.equal(await page.locator('.watch .stagger .cell').first().evaluate(el => getComputedStyle(el).transform), 'none');
    assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.animationName === 'rise').length), 0);
  } finally { await close(); }
});

test('the visibility check detects transparent children and ancestors', { timeout: 20_000 }, async () => {
  const { page, close } = await openHomepage({ mode: 'disabled' });
  try {
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.watch .stagger .cell { opacity: 0; }';
      document.head.append(style);
    });
    assert.equal((await unreadable(page)).filter(v => v.includes('cell')).length, 7);
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.watch { opacity: 0; }';
      document.head.append(style);
    });
    assert.ok((await unreadable(page)).length > 7);
  } finally { await close(); }
});
