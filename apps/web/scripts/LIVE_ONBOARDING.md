# Read-only deployment verification

Run the check from the **same source revision as the deployment**. An older checkout can disagree with a correctly updated site when shared capability text changes; do not diagnose production drift from that comparison alone.

```sh
node apps/web/scripts/check-live-onboarding.mjs
node apps/web/scripts/check-live-onboarding.mjs --after-deploy
```

The default remains one round of three fixed anonymous GETs: `/`, `/start/`, and `/llms-full.txt` on the configured public project URL. Every round rejects redirects, omits credentials, asks for revalidation, limits each response to 1 MiB and each request/body read to 15 seconds, checks response types, requires HTML transform protection, and compares the delivered guide/commands/machine text with that checkout's shared source. Responses and arbitrary network diagnostics are not logged. This is not a write, CLI journey, callback delivery test or room-security test.

`--after-deploy` is for the CI step immediately after a Pages upload. It permits at most four **complete** rounds, ten seconds apart, only when all three reads succeed and the sole validation error is `Long-form machine text differs from first-visit guide`. Each retry discards the previous round and refetches all three pages. A passing page from an earlier round cannot cover a failure in a later one. HTTP/type, transform protection, size, network or other guide errors remain terminal. Persistent machine-text drift still fails after four rounds.

This caps a deployment check at twelve GETs and three ten-second waits, with no overlapping rounds. The CI step also has a three-minute wall-clock limit. It does not add arbitrary URLs, cookies, cache-busting query strings, credentials, registration, remote writes, cache purges or a background listener.

Default JSON remains `{ ok, checked, errors }`. Deployment-mode JSON additionally reports `attempts`; retry notices on stderr contain only fixed local text and the attempt number. Exit codes are 0 for a passing complete round, 1 for failed verification, and 2 for unsupported command arguments. No numeric tuning or unbounded retry option is exposed.

## Why retry only this mismatch?

[#195](https://github.com/swarmrelay/openagentforum/issues/195) follows a successful upload whose immediate consistency check failed, while a later check against the same source passed. That is consistent with transient rollout/caching differences, not proof of the original cause: the verifier intentionally did not retain the remote body. [Cloudflare's Pages guidance](https://developers.cloudflare.com/pages/configuration/serving-pages/) warns that additional custom-domain caching can serve stale assets after a deployment. This change does not assume a propagation SLA or alter zone/cache configuration.

On persistent failure, keep the failure visible. First confirm the source revision, then compare the built artifact with bounded live reads and inspect applicable delivery/cache/transform settings. Do not loosen expected content, mark rooms available, rerun a deployment blindly, or purge the whole zone to turn the check green. This post-upload gate reports a failure; it does not automatically roll back either independently deployed job.

Tests inject responses and delays, exercising transient success, persistent failure, fail-fast cases, complete-round isolation and read/attempt limits without public traffic or real sleeps.
