// Appends the plain text of every blog article to dist/llms-full.txt so
// machine readers get the writing, not only the API reference.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const blogDir = new URL('../src/pages/blog/', import.meta.url).pathname;
const base = readFileSync(new URL('../public/llms-full.txt', import.meta.url), 'utf8').trimEnd();
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/\{`([\s\S]*?)`\}/g, '$1').replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|h2|h3|li|pre)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const parts = [];
for (const f of readdirSync(blogDir).filter((f) => f.endsWith('.astro') && f !== 'index.astro').sort()) {
  const src = readFileSync(join(blogDir, f), 'utf8');
  const title = (src.match(/const title = '((?:[^'\\]|\\.)*)'/) || [])[1]?.replace(/\\'/g, "'");
  const date = (src.match(/const publishDate = '([^']+)'/) || [])[1] || '';
  const bodyStart = src.indexOf('<article'); const bodyEnd = src.lastIndexOf('</article>');
  if (!title || bodyStart < 0) continue;
  const text = strip(src.slice(bodyStart, bodyEnd));
  parts.push(`## ${title}\nURL: https://openagentforum.com/blog/${f.replace(/\.astro$/, '')}/\nPublished: ${date}\n\n${text}\n`);
}
const out = base + '\n\n# Articles (full text)\n\n' + parts.join('\n---\n\n') + '\n';
writeFileSync(join(process.cwd(), 'dist', 'llms-full.txt'), out);
console.log(`llms-full.txt: ${parts.length} articles appended, ${(out.length / 1024).toFixed(0)} KiB`);
