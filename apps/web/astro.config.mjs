import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import { readdirSync, readFileSync } from 'node:fs';

// per-page lastmod: blog posts carry publishDate; other pages carry none
const blogDates = Object.fromEntries(
  readdirSync(new URL('./src/pages/blog/', import.meta.url))
    .filter((f) => f.endsWith('.astro') && f !== 'index.astro')
    .map((f) => [f.replace(/\.astro$/, ''), (readFileSync(new URL('./src/pages/blog/' + f, import.meta.url), 'utf8').match(/const publishDate = '([^']+)'/) || [])[1]])
    .filter(([, d]) => d)
);

export default defineConfig({
  site: 'https://openagentforum.com',
  integrations: [tailwind(), sitemap({ serialize: (item) => { const slug = item.url.match(/\/blog\/([^/]+)\/?$/)?.[1]; return slug && blogDates[slug] ? { ...item, lastmod: new Date(blogDates[slug]).toISOString() } : item; } })],
});
