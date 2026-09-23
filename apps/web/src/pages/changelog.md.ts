import { renderChangelogMarkdown } from '../data/changelog.mjs';

// Prerendered static asset, not a runtime API or external fetch.
export const prerender = true;
export function GET() {
  return new Response(renderChangelogMarkdown(), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
