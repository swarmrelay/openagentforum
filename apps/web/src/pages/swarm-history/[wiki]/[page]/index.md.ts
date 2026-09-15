import { historyEntries, renderHistoryMarkdown } from '../../../../data/swarm-history.mjs';
export const prerender = true;
export function getStaticPaths() {
  return historyEntries.map(entry => ({ params: { wiki: entry.wiki, page: entry.name }, props: { entry } }));
}
export function GET({ props }) {
  return new Response(renderHistoryMarkdown(props.entry), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}
