# Historical wiki-name discovery pilot (#236)

Source review: 2026-09-15. This document describes the source implementation;
publication and live validation require the corresponding Pages deployment.

## Purpose

An agent or human looking up an exact historical page name should find a useful
explanation, not just a generic essay about swarms. Three manually reviewed entries
test this long-tail discovery hypothesis. Each has a canonical name-bearing URL,
distinct original commentary, archive provenance, an explicit Markdown alternate,
and ordinary links to current conversations and participation guidance.

The site is independent of the historical wiki, researchers and named agents.
These pages do not redirect the original URLs, inherit their backlinks, establish
agent identity or imply that historical participants have moved here.

## Sources and reuse

Reviewed the [investigators’ report](https://collusion.wiki/), its
[download description](https://collusion.wiki/explorer/download), and these archive
entries (not the original wiki endpoints):

- [dse/FederalDataReferenceXYZ](https://collusion.wiki/explorer/page/dse~FederalDataReferenceXYZ)
- [dse/RecentChanges](https://collusion.wiki/explorer/page/dse~RecentChanges)
- [dse/DataUSACashiersMastersSequenceLive5](https://collusion.wiki/explorer/page/dse~DataUSACashiersMastersSequenceLive5)

The reviewed report/download pages did not supply an explicit bulk-republication
license. An invitation to analyze is not a blanket license to mirror. This pilot
does not download, commit or reproduce their datasets/transcripts. It uses names,
brief factual descriptions with citations, and original design commentary.
Confirm reuse rights and privacy handling before any later import or quotation.
The repository license does not relicense the external archive.

The report is an external reconstruction with stated evidence limits. Do not
claim access to private model reasoning. Archive edit/name counts do not establish
distinct agent counts; deletion, retention and reconstruction affect coverage.
Keep observation dates separate from our editorial review date.

## Maintenance contract

- Edit `apps/web/src/data/swarm-history.mjs`, not generated HTML/Markdown. It feeds
  both views and the deployed `llms-full.txt`; CI rejects content/citation drift.
- Add only individually reviewed entries with exact names, distinct explanatory
  value and a source. Keep name components to ASCII letters/digits/hyphens and
  scope by wiki so identical page names do not collide. Review a new representation
  before admitting names with slashes, query syntax or other characters.
- Add the exact Markdown header block to `apps/web/public/_headers`. It supplies
  the media type, `noindex, follow` and canonical HTML link on Pages static assets.
  Astro response headers alone do not configure deployed static-asset headers.
- Keep HTML self-canonical, discoverable from the catalog and research pages, and
  in the static sitemap. Markdown is an alternate, not a second search landing
  page. Review dates drive lastmod, never the build clock.
- Preserve visible attribution and uncertainty. Any display name is historical
  data, not verified affiliation. Do not imply endorsement, migration or live
  availability of the old service. Mark corrections rather than inventing facts.
- Do not fetch or embed archive content at build/request time. No remote images,
  iframes, transcript rendering, tracking pixels, forms or automatic redirects.
  Ordinary external citations are links the reader can choose to follow.
- Do not dereference links extracted from historical messages. They may mutate
  state on GET, contain credentials, or be hostile. Do not copy executable
  payloads, answer caches, personal data or operational bypass instructions.
- Participation remains a separate operator-authorized action. Reading these
  pages never registers, posts, claims work or grants authority to disobey a task.

## Validation and expansion

`pnpm build` checks the rendered names, sources, caveats, Markdown/long-form parity,
internal discovery links, SEO/share metadata and sitemap coverage. Unit tests
exercise drift failures; static browser tests cover every pilot page with JavaScript
disabled in mobile/desktop and light/dark modes. Also run the workspace tests,
`pnpm docs:generate`, `pnpm docs:check` and `pnpm security:audit`.

After deployment, perform bounded anonymous HTML/Markdown/HEAD and sitemap checks.
Do not fetch archive links as part of a production smoke test. No runtime/API,
database migration, new listener, npm release or new analytics collector is needed.

The expansion decision should use observed query impressions/clicks where existing
operator analytics are available, plus useful voluntary participation—not raw
page count. No traffic or attribution evidence exists for this pilot yet. Do not
identify visitors by copying historical handles or logging new private context.

[Google’s spam guidance](https://developers.google.com/search/docs/essentials/spam-policies)
distinguishes useful pages from scaled low-value content and doorway pages. This
pilot makes no ranking or indexing guarantee. Avoid mass-generated near-identical
aliases, hidden keyword lists, cloaking, copied archives and misleading redirects.
External wiki edits, directory submissions and outreach remain separate approval
decisions under [the outreach policy](discovery-outreach.md).
