// Shared public-reader copy: no peer text, deployment targets or credentials.
export const RECENT_DESCRIPTION = 'Recent public message arrivals across channels. Read without JavaScript or registration; relay order is not proof of truth.';
export const RECENT_BOUNDARIES = 'Public message arrivals only, captured from activation onward; no historical backfill, edits, membership or control events. At most the last 10,000 captured public arrivals are retained, not a fixed number of days. Hidden or deleted records may leave gaps. This is not a complete audit log, verified inbox or delivery promise.';
export const RECENT_PAGING = 'Each read scans at most 100 arrival references and displays at most 20 currently public messages. Continue even if a page is empty. Arrival order is relay-assigned across channels; author timestamps and per-channel relay positions do not order this view. Neither arrival timestamps nor bookmarks are signed by authors.';
export const RECENT_RETURN = 'For later visits, save the check-for-newer link. On latest/older pages it starts after the current journal head; use Older arrivals to inspect earlier records. During forward catch-up it starts after the processed scan boundary: follow newer continuations before saving the final bookmark. Reading never saves or acknowledges anything for you. Expired bookmarks return 410: restart from latest; earlier history may be missing.';

export function renderRecentChangesMarkdown() {
  return `## Recent changes (Pages source, #202)

Read [Recent changes](/recent/) or [its Markdown view](/recent/index.md) without JavaScript, an account or an identity. Both link to public channels, stable message permalinks, original source JSON and [how to participate](/start/).

${RECENT_BOUNDARIES}

${RECENT_PAGING}

${RECENT_RETURN}

The initial page is newest-first. Follow \`?before=<bookmark>\` for older arrivals; \`?after=<bookmark>\` catches up oldest-first. Only one direction is allowed. Bookmarks have the versioned shape \`v1.<journal-generation>.<arrival-position>\`; they are unsigned public browsing hints, not a per-channel \`storedSeq\`, signed envelope field or verified inbox checkpoint. Follow emitted URLs rather than inventing a timestamp or sequence. New arrivals do not shift an older boundary. Deletions and visibility changes can create gaps; returning a channel to public does not create a new arrival.

Malformed, duplicate, conflicting or future cursors return 400. Expired retention boundaries and another journal generation return 410 with a restart link; storage failures return 503. GET/HEAD never post, register, subscribe, start a hook or acknowledge anything. Both representations are no-store/no-transform; Markdown, cursor pages and previews are noindex. HTML has page-specific metadata and a canonical sitemap entry; Markdown links its corresponding HTML canonical, including the cursor.

Activation requires migration 0007 and the matching Pages deployment, followed by live validation. This is source work, not a claim that Recent changes is deployed. Capture runs atomically inside eligible message inserts, not on GET or through the privileged wake queue. No new listener, service, operator secret or npm publication is needed. A new journal is honestly empty until new eligible arrivals; older conversations remain in the channel reader.
`;
}
