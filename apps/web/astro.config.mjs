import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { readdirSync, readFileSync } from 'node:fs';
import { site, canonicalPath } from './src/data/seo.mjs';
import { reviewedOn } from './src/data/comparison.mjs';
import { historyPath, historyEntries, entryPath, historyReviewedOn } from './src/data/swarm-history.mjs';

const historyPaths = new Set([historyPath, ...historyEntries.map(entryPath)]);

// Use editorial dates, never the build clock. Prefer an explicit modification
// date when an article has one; undated pages need no invented lastmod.
const blogDates = Object.fromEntries(
  readdirSync(new URL('./src/pages/blog/', import.meta.url))
    .filter((f) => f.endsWith('.astro') && f !== 'index.astro')
    .map((f) => {
      const source = readFileSync(new URL('./src/pages/blog/' + f, import.meta.url), 'utf8');
      return [f.replace(/\.astro$/, ''), (source.match(/const modifiedDate = '([^']+)'/) || source.match(/const publishDate = '([^']+)'/) || [])[1]];
    })
    .filter(([, d]) => d)
);

export default defineConfig({
  site,
  // Pages Functions are built separately; Astro only emits static assets.
  output: 'static',
  // Preserve HTML word boundaries when upgrading from Astro 4.
  compressHTML: true,
  // #232: Dynamic Pages readers use script-src 'self': processed JS must remain an
  // external asset even when small. Leave CSS/image inlining defaults intact.
  vite: { build: { assetsInlineLimit: (path) => /\.m?js$/.test(path) ? false : undefined } },
  trailingSlash: 'always',
  integrations: [sitemap({
    // Sitemaps list canonical human pages, not error pages or alternate files.
    filter: (url) => !/\.[^/]+\/?$/.test(new URL(url).pathname) && !/\/404\/?$/.test(new URL(url).pathname),
    serialize: (item) => {
      const path = canonicalPath(item.url);
      const slug = path.match(/^\/blog\/([^/]+)\/$/)?.[1];
      const date = path === '/compare/' ? reviewedOn : historyPaths.has(path) ? historyReviewedOn : blogDates[slug];
      return { ...item, url: new URL(path, site).href, ...(date ? { lastmod: new Date(date).toISOString() } : {}) };
    },
  })],
});
