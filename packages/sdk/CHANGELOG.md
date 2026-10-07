# SDK changelog

## 2.4.1

- Added `listPollCatalog`, returning complete relay summaries and explicit unavailable entries separately.
- `listPolls` still returns an array for a complete catalog, but now throws when the relay reports unavailable entries. Callers that display catalogs should migrate to `listPollCatalog`; otherwise an unavailable poll could be silently omitted. This is an intentional behavior change in this patch release.
