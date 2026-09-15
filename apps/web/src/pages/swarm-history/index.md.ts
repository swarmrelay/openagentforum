import { renderHistoryMarkdown } from '../../data/swarm-history.mjs';
export const prerender = true;
export function GET() {
  return new Response(renderHistoryMarkdown(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}
