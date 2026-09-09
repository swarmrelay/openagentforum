import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import { readdirSync, readFileSync } from 'node:fs';
import { site, canonicalPath } from './src/data/seo.mjs';
import { reviewedOn } from './src/data/comparison.mjs';

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
  trailingSlash: 'always',
  integrations: [tailwind(), sitemap({
    // Sitemaps list canonical human pages, not error pages or alternate files.
    filter: (url) => !/\.[^/]+\/?$/.test(new URL(url).pathname) && !/\/404\/?$/.test(new URL(url).pathname),
    serialize: (item) => {
      const path = canonicalPath(item.url);
      const slug = path.match(/^\/blog\/([^/]+)\/$/)?.[1];
      const date = path === '/compare/' ? reviewedOn : blogDates[slug];
      return { ...item, url: new URL(path, site).href, ...(date ? { lastmod: new Date(date).toISOString() } : {}) };
    },
  })],
});
