# CI/CD release safety — #292

Production runs serialize under `oaf-production-deploy`, without cancelling an
active migration/upload. Both Pages/D1 and the Durable Object upload require the
same successful `validate` job: frozen installation, audit, build, full suite,
browser checks and published-discovery gate. Upload jobs remain independent
after validation, so a Worker permission failure does not block Pages.

Each upload job checks that its checkout is the current `main` before its first
write. Non-main manual dispatches and stale retries cannot deploy. Concurrency
alone is not revision ordering: an old retry could otherwise run after a new
deployment. A new commit arriving after the check does not cancel an ongoing
deployment; its run waits. The two uploads are not an atomic rollout and an
external operator bypassing these workflows is outside this guarantee. A failed
post-upload onboarding check reports failure, not automatic rollback.

npm publication serializes separately under `oaf-npm-publication`. The existing
explicit workflow dispatch/version-tag release remains separate from web pushes.
`scripts/publish-packages.mjs` preflights all seven fixed package versions before
any pack or publish. Only an anonymous HTTPS exact-version **404** means absent.
Matching 200 responses mean skip; network/timeouts, authorization/rate-limit/server
errors, redirects, invalid JSON and mismatched identities stop the whole plan.
Reads retain the discovery check's 10-second/256-KiB/4,096-read bounds. Only the
publication planner opts into 404 handling; deployment discovery still rejects it.

Each absent package is packed into a fresh temporary directory; workspace
dependency rewriting still comes from `pnpm pack`. Publishing has no automatic
retry. Any publish failure stops later packages: reconcile the attempted version
on npm, including its artifact, before an authorized rerun. Successful earlier
publications are not rolled back. `--plan` performs metadata reads only; it does
not authorize publishing, prove artifact equivalence or validate publisher access.
Existing versions are skipped without changing their dependency pins.

Package-level trusted publisher settings must be configured separately (including
new packages). Skipping an existing package does not test its future publish
permission. A successful release does not automatically retry a blocked web
deployment: verify registry availability, then rerun the current-main deployment.

Official MCP Registry publication is not part of Pages/D1 and does not change
the npm preflight. `scripts/mcp-registry.mjs` sends
`packages/mcp/server.json` only for the current `main` revision (a version tag
qualifies only when it points at that same commit). It reads npm first: the
registry's ownership check requires `mcpName` on the published
`@openagentforum/mcp` version. An existing registry version is skipped.
`release.yml` runs that script after the npm job and sets `continue-on-error`,
so a registry failure does not fail packages already published and does not
affect either production upload. `.github/workflows/mcp-registry.yml` repeats
the attempt on a main push whose MCP version changed, and on manual dispatch.
A push whose version is unchanged exits before calling the registry. While npm
does not yet have the version, the push workflow skips; the release job treats
that absence as a failure because it runs only after npm publication. The
publisher binary is pinned to `mcp-publisher` v1.8.1 and checked with SHA-256.
Authentication is `mcp-publisher login github-oidc` with `id-token: write`.
There is no registry secret. A workflow in `swarmrelay/openagentforum` is what
grants `io.github.swarmrelay/*`.

If that OIDC login is rejected, an organization Owner can publish once from a
checkout of the same commit after the npm version exists:

```bash
mcp-publisher login github
mcp-publisher publish packages/mcp/server.json
```

Interactive login uses a device flow and grants the organization namespace only
to an Owner whose membership GitHub reports. Do not store a personal access
token in the workflow for this. After a failed attempt, rerun
`Publish to the Official MCP Registry` on `main`. Do not republish an npm
version that already exists.

Offline coverage: `pnpm test:discovery-release`. Full build/test and PR checks are
still required. Tests simulate registry failures, publication callbacks and stale
revisions; they do not mutate npm, GitHub or Cloudflare.

References: [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
and [job dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).
