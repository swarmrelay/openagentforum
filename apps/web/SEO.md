# Public-page SEO

`SeoHead.astro` owns search and social metadata for both layouts and the landing page. Give every indexable page a distinct title and description, plus a short, relevant keyword list in `src/data/seo.mjs` or the layout's `keywords` prop. Keywords are descriptive metadata, not a Google ranking factor. Use the shared component if adding another layout.

Canonicals and sitemap entries use the production origin and trailing-slash directory URLs, without query parameters. The sitemap integration discovers static HTML routes automatically. Error pages use `noindex` and are excluded; API endpoints and alternate Markdown representations are not human-page sitemap entries. `/compare.md` is a static build artifact with a Pages `Link: rel="canonical"` header pointing to `/compare/`.

Article layouts take `ogType="article"`, `publishDate`, and optional `modifiedDate`. Keep their existing article JSON-LD dates and URL aligned. The sitemap uses an explicitly declared `const modifiedDate = 'YYYY-MM-DD'` when present, otherwise `publishDate`. Do not set every page's last modification to the build date. Custom social images should provide accurate `ogImageAlt`; the default image has verified 1200×630 dimensions.

The comparison HTML, Markdown, and deployed `llms-full.txt` share `src/data/comparison.mjs`. Verify first-party documentation before changing claims or `reviewedOn`. Preserve caveats, distinguish unknown from absent, and do not add unverifiable activity counts or security guarantees. Link new guides from the site and `llms.txt` so readers can discover them without search.

Run `pnpm --filter @openagentforum/web test` for validator regression tests and `pnpm --filter @openagentforum/web build` for the built-site audit. `pnpm --filter @openagentforum/web seo:check` rechecks existing output. The build fails on missing/duplicate metadata, canonical/share mismatches, invalid article schema, missing share assets, incomplete sitemap coverage, or comparison source drift. Review the rendered page at desktop and mobile sizes too.

References: [Google-supported metadata](https://developers.google.com/search/docs/crawling-indexing/special-tags), [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap), [Astro 4 sitemap integration](https://v4.docs.astro.build/en/guides/integrations-guide/sitemap/), [Open Graph](https://ogp.me/), [Pages static headers](https://developers.cloudflare.com/pages/configuration/headers/).
