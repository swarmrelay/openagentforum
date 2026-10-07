import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve through the installed build tools, never directly to the vendor copy.
const webRequire = createRequire(new URL('../package.json', import.meta.url));
const tailwindRequire = createRequire(webRequire.resolve('tailwindcss/package.json'));
const consumers = ['chokidar', 'micromatch'].map(name => {
  const require = createRequire(tailwindRequire.resolve(name));
  return { name, require, braces: require('braces'), entry: require.resolve('braces') };
});
const depthError = error => error instanceof SyntaxError && /AST nesting depth exceeds/.test(error.message);
const ast = depth => {
  let node = { type: 'root', nodes: [] };
  for (let i = 0; i < depth; i++) node = { type: 'root', nodes: [node] };
  return node;
};

for (const { name, require, braces, entry } of consumers) {
  test(`${name} resolves the private bounded copy, with unchanged ordinary glob syntax`, () => {
    const metadata = require('braces/package.json');
    assert.equal(metadata.name, '@openagentforum/build-braces');
    assert.equal(metadata.private, true);
    assert.equal(metadata.dependencies['fill-range'], '7.1.1');
    assert.equal(braces.compile('app/{reading,writing}/**/*.{js,jsx}'), 'app/(reading|writing)/**/*.(js|jsx)');
    assert.deepEqual(braces.expand('page-{1..3}.js'), ['page-1.js', 'page-2.js', 'page-3.js']);
    assert.deepEqual(braces.expand('a\\{b,c\\}'), ['a{b,c}']);
    assert.equal(braces.compile(braces.parse('a/{b,c}/d')), 'a/(b|c)/d');
    const pattern = '{'.repeat(99) + 'x' + '}'.repeat(99);
    assert.equal(braces.stringify(pattern), pattern);
    assert.deepEqual(braces.expand(pattern), [pattern]);
  });

  test(`${name} rejects deep strings on a small stack before recursive overflow`, () => {
    const source = `
      const assert = require('node:assert/strict');
      const braces = require(process.argv[1]);
      for (const open of ['{', '(']) {
        const pattern = open.repeat(4000) + 'x' + (open === '{' ? '}' : ')').repeat(4000);
        for (const run of [braces, braces.parse, braces.compile, braces.expand, braces.stringify]) {
          assert.throws(() => run(pattern, { maxDepth: Infinity }), error =>
            error instanceof SyntaxError && /AST nesting depth exceeds/.test(error.message));
        }
      }
    `;
    execFileSync(process.execPath, ['--stack_size=512', '-e', source, entry], { timeout: 3000, stdio: 'pipe' });
  });

  test(`${name} bounds direct AST walkers including cyclic nodes and depth boundaries`, () => {
    for (const operation of ['compile', 'expand', 'stringify']) {
      assert.deepEqual(braces[operation](ast(100)), operation === 'expand' ? [] : '');
      assert.throws(() => braces[operation](ast(101)), depthError);
      assert.throws(() => braces[operation](ast(4000)), depthError);
      const cycle = { type: 'root', nodes: [] }; cycle.nodes.push(cycle);
      assert.throws(() => braces[operation](cycle), depthError);
    }
  });
}

test('Astro refuses remote image load and cache revalidation without network or cache reads', async () => {
  const astroRequire = createRequire(webRequire.resolve('astro/package.json'));
  const root = dirname(webRequire.resolve('astro/package.json'));
  assert.throws(() => astroRequire.resolve('http-cache-semantics'), { code: 'MODULE_NOT_FOUND' });
  const remote = await import(pathToFileURL(join(root, 'dist/assets/build/remote.js')));
  let fetches = 0, cacheReads = 0;
  const fetch = () => { fetches++; throw new Error('Must not fetch'); };
  const cache = new Proxy({}, { get() { cacheReads++; throw new Error('Must not reuse cache'); } });
  for (const src of ['https://example.invalid/image.png', 'file:///private-fixture']) {
    await assert.rejects(remote.loadRemoteImage(src, fetch), /Remote image optimization is disabled/);
    await assert.rejects(remote.revalidateRemoteImage(src, cache, fetch), /Remote image optimization is disabled/);
  }
  assert.equal(fetches, 0); assert.equal(cacheReads, 0);
  // Installed tooling must keep the patch when another change refreshes the lock.
  const source = await readFile(join(root, 'dist/assets/build/remote.js'), 'utf8');
  assert.ok(!source.includes('http-cache-semantics'));
});

test('Astro rejects remote generation before a fresh or stale on-disk cache could be reused', async () => {
  const root = dirname(webRequire.resolve('astro/package.json'));
  const { generateImagesForPath } = await import(pathToFileURL(join(root, 'dist/assets/build/generate.js')));
  let accesses = 0;
  const env = new Proxy({}, { get() { accesses++; throw new Error('Must not access cache/output environment'); } });
  const transforms = new Map([['fixture', { finalPath: '/fixture.png', transform: { src: 'https://example.invalid/image.png' } }]]);
  for (const originalPath of ['https://example.invalid/image.png', '/local-fixture.png']) {
    await assert.rejects(generateImagesForPath(originalPath, { transforms }, env), /Remote image optimization is disabled/);
  }
  assert.equal(accesses, 0);
});
