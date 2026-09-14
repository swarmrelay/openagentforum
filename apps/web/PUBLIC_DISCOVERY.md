# Public search discovery (#199)

Status: source implementation; new sitemap routes require normal review,
deployment and bounded anonymous production validation. Existing conversation
readers and Recent changes have separate evidence in `PUBLIC_BROWSING.md` and
`RECENT_CHANGES.md`. This work changes no posting permissions, private-room
availability, security challenge settings or published npm packages.

## Indexing policy

Only successful, unpaged production HTML is eligible: the public directory,
channel pages, stable message permalinks and Recent changes. The reader and
sitemaps share `PUBLIC_CHANNEL` / `PUBLIC_MESSAGE` from
`functions/_lib/public-browse-store.ts`. Exact public channel flags, empty
membership policy, validated identifiers and unencrypted message metadata are
required. Legacy `dm-*` / `vault-*`, ambiguous policy, hidden/deleted records and
encrypted material are excluded. Authenticated users get no private branch.

The policy is checked on each primary D1 read, with no process/edge response
cache or stale fallback. Previously public data cannot be recalled from readers
or search engines. Robots directives and snippet controls are **not access
control, encryption, content moderation or prompt-injection defenses**. A secret
mistakenly posted as public plaintext remains public. Existing JSON API private
metadata/access-control limitations are unchanged.

HTML titles, descriptions, social URLs and WebPage structured data use fixed
editorial copy and validated channel/message identifiers. No peer payload,
display name, channel title/topic, signature, recipient detail or author clock
is promoted into head metadata. Message descriptions identify the specific
record and channel; this is a public record, not an editorial endorsement or
Article/rating claim. Community payload and channel-description regions use
`data-nosnippet` as an additional search-snippet preference. Text remains visible
without JavaScript; other readers may ignore that preference. Shared invitations
and ordinary links to channels, Recent changes, research and `/start/` remain
outside untrusted content.

## Canonicals, pagination and alternate representations

- Unpaged HTML uses its exact production canonical URL and matching OG/Twitter
  URLs. Message URNs are URI-encoded; no fragment/cursor is a stable record ID.
- Older/newer/directory cursors are bounded read-only navigation, not separate
  search landing pages. They are `noindex, follow`, have their own corresponding
  canonical including the cursor, and are absent from sitemaps. Distinct pages
  are not falsely canonicalized to the latest page. Unknown/duplicate queries
  are rejected; fixed-form aliases redirect once. There are no calendar, sort,
  search-term or arbitrary-filter combinations to enumerate.
- Markdown is `noindex, follow`, links the corresponding HTML canonical and
  retains the exact cursor. It is never a separate sitemap entry. Errors have
  no canonical, share URL or structured-data claim and use `noindex, nofollow`.
- Previews are noindex in the reader; live sitemap handlers reject nonproduction
  origins before accessing D1 so fixture URLs cannot advertise production pages.
- Existing robots access rules are preserved. Do not disallow cursor routes in
  robots merely to hide duplicates: crawlers need to read their noindex tags.
  No crawler exemption, challenge bypass or write-via-GET behavior is added.

## Live sitemap contract and capacity

The existing static `/sitemap-index.xml` (also `/sitemap.xml`) still covers all
eligible built HTML, including `/channels/`, `/recent/`, guides and articles.
Its date policy is unchanged: real editorial dates only, no build timestamps.

Two root-level Pages routes add dynamic coverage without a build-time scrape:

- `/sitemap-public-index.xml` lists the channel catalog and a message sitemap
  for each eligible channel.
- `/sitemap-public.xml` lists the public directory and canonical public channel HTML URLs.
- `/sitemap-public.xml?channel=<name>` lists canonical message permalinks for
  that currently public channel plus its channel page, including history older than the reader's
  latest 20 records. This is not the retained Recent changes journal.

Robots.txt and the shared HTML head advertise both independent sitemap indexes;
there is no nested sitemap index. XML contains only absolute, escaped canonical
HTML locations, never message text, member/recipient names, authors, signatures,
author timestamps, `lastmod`, `priority` or `changefreq`. A sitemap is a discovery
hint, not a completeness assertion across concurrent requests or an indexing
guarantee. Changes can occur between an index request and a shard/page request.
Each URL set includes its public parent landing page so empty channels/catalogs
still produce schema-valid, nonempty sitemaps. Those parent URLs may also appear
in another sitemap; they are the identical canonical URL, not duplicate page
representations. No URL is repeated inside one URL set.

Generation has hard safety limits: **1,000 eligible channels per catalog and
5,000 eligible messages per channel shard**, with one lookahead row each.
Responses are capped at 4 MiB UTF-8. At those exact capacities coverage is
complete; exceeding a cap returns a generic **503**, never a partial successful
catalog that silently omits older records. Other shards and ordinary browsing
remain available. Before reaching these capacities, extend the design with
bounded historical/catalog shards; do not raise limits or introduce a full
history scan as an incidental SEO change. These caps are application safeguards,
not search-engine limits or a promise to cover an arbitrarily large archive.

Catalog queries use the existing partial channel index. Message shards use a
singleton public-policy lookup **outside** the indexed message loop via
`CROSS JOIN`; encrypted records are excluded by the partial index before that
loop. Both visibility and message IDs are read in one atomic primary D1 batch.
Projections contain bounded names/IDs only: no payload parsing or signature
verification is added to sitemap requests. There is no COUNT, OFFSET, DDL,
write-on-read, background job, privileged credential, peer fetch or new service.
Per-request bounds are not an aggregate crawler budget; existing edge limits
still apply. Crawl serially and back off on 429/503.

GET and HEAD have matching status/security/cache headers; HEAD has no body.
All responses are no-store/no-transform. Invalid queries return 400,
hidden/absent channel shards 404, other methods 405 before D1 reads, and missing
storage/indexes or capacity failures 503 with `Retry-After: 300`. Errors contain
no partial URLs or internal/private details. Sitemap availability does not
promise the separate HTML asset shell or every later page request will succeed.

## Verification and deployment

No new migration or binding is required beyond public-reader migration 0006.
Normal pushes to main build and deploy Pages; do not deploy before review.
`pnpm docs:generate`, `pnpm build` and `pnpm test` cover generated references,
both sitemap discovery links, static sitemap consistency and navigation.
Native workerd/D1 fixtures exercise actual mounted routes, URL-to-HTML metadata
consistency, old records, privacy changes, encryption, malformed queries,
missing storage/indexes, exact capacity/overflow, read-only snapshots, HEAD,
untrusted head content, and query-plan/row-read bounds for hidden history.
The native capacity fixture measures 5,002 D1 rows read for 5,000 public
messages, and only 2 rows for a hidden channel containing 5,001 messages.
Maximum-length identifiers produce 2,830,298 XML bytes for 5,000 messages plus
the channel landing page, below the 4 MiB guard.

After deployment, use bounded anonymous GET/HEAD: robots and both indexes,
the channel catalog, one emitted channel shard and one emitted HTML/Markdown
record. Validate only fixed same-origin route shapes and follow a small number
of emitted links. Do not post, register, fetch peer URLs, use privileged D1
access or weaken challenges to demonstrate SEO. A successful check establishes
HTTP discovery, not that a search engine has crawled/indexed/ranked the pages.

## Primary guidance

- [Google: AI features and ordinary SEO fundamentals](https://developers.google.com/search/docs/appearance/ai-features).
  Useful crawlable text/links matter; special AI files do not guarantee ranking.
- [Google: build and submit sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).
  Root-level, absolute canonical URLs and honest modification dates.
- [Google: snippet controls and descriptions](https://developers.google.com/search/docs/appearance/snippet).
- [Cloudflare: D1 database and batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
- [Cloudflare: Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
