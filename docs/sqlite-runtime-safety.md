# Node SQLite runtime safety — #312

Reviewed 2026-09-24. This is an upstream runtime assessment and startup guard, not
a claim of observed corruption, a forum-message exploit or production compromise.
No production database or private deployment inventory was inspected.

## Why npm audit is not enough

The SQLite engine in `node:sqlite` comes with Node, outside npm's dependency audit.
[SQLite documents a rare WAL-reset corruption race](https://sqlite.org/wal.html#walreset)
when separate threads/processes concurrently write/checkpoint the same WAL file.
Its fixed versions are 3.51.3 and later, with listed backports 3.44.6 and 3.50.7.
Ordinary WAL use does not demonstrate the race; upstream describes its low observed
likelihood. Our local Node 22.14.0 reported SQLite 3.47.2, so API availability alone
was not a sufficient supported-runtime check.

Primary release notes identify [Node 22.22.3](https://nodejs.org/en/blog/release/v22.22.3)
and [Node 24.15.0](https://nodejs.org/en/blog/release/v24.15.0) as including SQLite
3.51.3. Use a maintained patched release on those supported LTS lines, not an old
runtime just because it meets the JavaScript API floor. These are known baselines,
not claims about today's latest release or every distributor's build.

## Source-level connection inventory

| Component | Observed contract | Guard / scope |
| --- | --- | --- |
| Node standalone relay | One caller-selected connection per factory call; WAL; returned DB is accessible to the operator. No exclusive process guarantee. | An in-memory engine probe runs before opening/creating the target file or constructing a listener. |
| Node wake attempt ledger | WAL/FULL; independent connections deliberately share retained attempt IDs and budgets. | Probe before opening/creating the ledger. Both entrypoints also probe before reading credentials or creating state files. |
| Internal room admission | Caller-owned WAL connection; atomic admission supports separate processes. | Read the engine version on that connection before journal/schema/authority writes. Caller still owns opening/closing the connection. |
| Pull result journal | DELETE rollback journal with exclusive connection locking. | Not the WAL mechanism in this advisory. The surrounding sender still requires a patched engine for its separate attempt ledger. |
| Protected room-client state (PR #313) | Exclusive DELETE rollback journal. | Separate source-only work; not a WAL consumer or evidence of production room availability. |
| Pages/D1 and Durable Objects | Cloudflare-managed engine and runtime, not the local Node builtin. | No Node version gate, migration or engine-version inference is applied to them. |

One configured sender process is not proof that no other local consumer can open
its ledger path. The pull-journal lock does not lock the separate ledger file.
Tests alternate independent synchronous ledger connections and exercise separate
room processes; they are not a reproduction of the upstream timing race.

## Enforcement

Each Node SQLite package has a small `src/sqlite-runtime.ts` guard. The independent
copies avoid adding new server dependencies to the private wake/room artifacts;
the conformance suite requires byte-identical source and identical behavior.
The guard reads only `SELECT sqlite_version() AS version` and accepts canonical
SQLite 3.x fixed ranges: 3.51.3+, 3.50.7+ on the 3.50 branch, and 3.44.6+ on 3.44.
Malformed, unknown-major, affected and unavailable results fail closed. There is
no environment bypass, automatic download, database-mode conversion or retry.

The fixed diagnostic includes no path, SQL exception, key or peer content. On
failure, do not delete database/WAL files, reset budgets or switch to a new state
directory. Update the reviewed runtime, preserve all state, then reconcile any
existing uncertain operations under their original IDs.

This checks the WAL-reset fix, **not all runtime vulnerabilities**, binary
authenticity, correct filesystem locking, power-loss guarantees or database
integrity. A custom distributor backport with an unrecognized version is refused;
review its evidence and update the policy explicitly rather than add an override.
Do not use the withdrawn SQLite 3.52.0 release as a recommended upgrade simply
because its WAL fix passes this narrow guard.

## Local and release checks

After building, the read-only preflight is:

```sh
pnpm runtime:check
```

It accepts no database path, opens only `:memory:` and reports Node/SQLite versions
plus the specific check name. `pnpm test` runs `test:sqlite-runtime` before the
workspace suites. Existing PR, deployment and publication workflows already run
that full suite; their revision, approval, serialization and discovery guards are
unchanged. The isolated Nostr socket matrix still tests its earlier supported Node
floor because it does not open SQLite.

The wake artifact's existing `deploy/wake/check-release.mjs` also probes the actual
operator-selected Node engine before reporting runtime readiness. It never starts
either service entrypoint or opens a service database. An artifact-only content
check is not a runtime check; execute the checker with the intended service binary.

Conformance tests cover fixed/backport boundaries, malformed/failed version reads,
redaction, no file/listener creation on refusal, no room initialization writes and
both wake entrypoints refusing before credential/state access. The old-runtime
test preload is test-only, never packed into runtime packages. Existing full
SQLite/D1 suites, clean-install and browser checks remain required.

## Publication and installed-service rollout

Server 1.9.2 source adds the guard; CLI 1.7.2 source picks up that exact server
dependency. They require separate review, publication and clean registry checks.
Already published client/onboarding pins stay unchanged. No claim is made that
these new versions have been published or that an installed relay was upgraded.

General SDK/MCP reads, client signing and `doctor` do not start standalone SQLite
and do not inherit this WAL guard. `serve` and source-only room dogfood do. Keep
their runtime distinction explicit when documenting the CLI's wider Node support.

For a separately installed service, obtain approval, verify a maintained official
architecture-matching runtime and checksum, record its actual SQLite version in
private operator notes, validate the reviewed artifact with that binary, and use
the existing controlled rollout/backup procedure. Do not replace unrelated system
runtimes, mutate a live database to test an advisory or downgrade/reset durable
state. Web pushes do not update a Node sender. This change performs no deployment.
