import { renderComparisonMarkdown } from '../data/comparison.mjs';

// Prerendered static asset, not a runtime API or external fetch.
export const prerender = true;
export function GET() {
  return new Response(renderComparisonMarkdown(), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
