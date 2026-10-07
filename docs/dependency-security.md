# Dependency-security triage — #191

Reviewed 2026-09-14 against the committed workspace lockfile. This is an advisory
and execution-surface review, not exploit testing or a complete security audit.

## Baseline and disposition

At main commit `7918682`, `pnpm audit --json` reported 3 critical, 12 high,
27 moderate and 6 low findings. `pnpm audit --prod --json` reported 1 critical,
11 high, 22 moderate and 6 low. These are registry audit metadata counts, not
distinct exploitable public endpoints. The production-only install includes web
build tools, so its classification alone is insufficient.

| Installed dependency path before this change | Surface and relevant preconditions | Disposition |
| --- | --- | --- |
| `apps/web → astro@4.16.19 → sharp@0.33.5` | Astro builds static assets in CI/local development. No configured SSR adapter, `astro:assets`, `getImage`, image components, server islands or Astro middleware; no Astro image endpoint in the Pages API. The critical AVIF advisory requires an untrusted image reaching the optimizer. Compiling project templates is still privileged build work. | Astro 7.3.2, with Sharp 0.35.4. |
| `apps/web → @astrojs/cloudflare@14.2.5 → wrangler@3.114.17` (peer) and `→ @cloudflare/vite-plugin@1.54.2 → miniflare@5.20260828.0-alpha → sharp@0.35.2` | Adapter was installed but not imported/configured. Its Astro 7 / Wrangler 4 peers conflicted with the old direct tools; its dependencies were included in production-only audit output. | Remove the unused adapter. Preserve the separate `functions/` tree and Pages deployment. |
| Root and `packages/server → wrangler@3.114.17 → miniflare@3.20250718.3 → undici@5.29.0, ws@8.18.0`; Wrangler also selected `sharp@0.33.5, esbuild@0.17.19` | Local emulation and deployment tooling, including HTTP/WebSocket client and decompression paths; not the live Pages request handler. Exposing development servers or accepting untrusted tooling inputs increases exposure. | Pin Wrangler 4.131.2 at root, web and server, including all deployment-action inputs. Its Miniflare uses patched Undici 7.29.0, ws 8.21.0 and Sharp 0.35.4. |
| Root and the protocol, mesh, room-admission, server, wake-service, SDK, MCP and CLI test packages `→ vitest@2.1.9 → vite@5.4.21 → esbuild@0.21.5` | Tests use `vitest run`, not the UI/API server. The critical Vitest advisory concerns a listening UI server; Vite/mocker findings concern development serving. Do not equate this with code execution through a forum post. | Pin Vitest 4.1.11, the patched maintained v4 line identified by its advisory. Vite resolves to 8.2.2. No need to adopt Vitest 5. |
| `apps/web` and `packages/wake-feasibility → miniflare@5.20260907.0-alpha → sharp@0.35.2` | Direct, local-only D1/workerd fixtures; no production image service. These were already prerelease tool versions. | Pin Miniflare 5.20260911.1-alpha and workerd 1.20260911.1; rerun actual Pages/D1 and outbound-feasibility fixtures. Hosting conclusions and release gates do not change. |
| `packages/server → ws@8.21.3` | Standalone relay WebSockets, an actual runtime dependency. This was already outside the affected ws ranges in the baseline lockfile. | Retain it; do not claim the old Wrangler ws finding was a live relay vulnerability. |

`pnpm -r why sharp ws undici vite esbuild` confirms paths which the registry audit
deduplicates. The new all-dependency and production-only audits both report zero
known advisories, without overrides, ignored IDs or registry-error suppression.
This statement is a dated snapshot and will change when new advisories appear.

## Compatibility decisions

- Keep `output: 'static'` explicit. Astro does not own the production HTTP API;
  `apps/web/functions/` still does. Do not add an adapter or an Astro `_worker.js`
  that bypasses Pages Functions. Local Pages and Worker bundle checks pass with
  Wrangler 4.131.2. Their input metadata contains no Astro, Sharp, Vitest, Vite or
  Undici runtime. Wrangler's generated Pages router and Worker polyfills are
  expected build inputs, not the whole Wrangler CLI in the deployed runtime.
- Replace unsupported `@astrojs/tailwind` with Tailwind 3's documented PostCSS +
  Autoprefixer setup. Keep the existing theme/configuration and include base,
  component and utility CSS in both layouts and the standalone homepage.
- Preserve HTML-aware whitespace with `compressHTML: true`; Astro 7's new JSX
  default can remove spaces between inline elements. The repository does not use
  Astro content collections, `Astro.glob`, view transitions, actions or custom
  Markdown processors. Existing HTML/SEO/participation tests remain required.
- The workspace build now declares Node 22.13+ (the existing internal SQLite
  floor also meets Astro's Node 22.12+ requirement). Consumer package runtime
  engines and wire protocols are unchanged.
- Package patch versions and generated MCP metadata advance under the repository
  versioning rule. They do **not** mean npm publication occurred. Before merging
  into the web deployment, publish and clean-install verify the new package set
  (especially MCP 1.1.3 referenced by generated discovery metadata), or keep the
  PR pending. Do not deploy an install command pointing to an absent npm version.
  Separately installed Node services are not updated by this change.

## Verification and ongoing policy

Run:

```sh
pnpm install --frozen-lockfile
pnpm security:audit
pnpm audit --prod
pnpm docs:check
pnpm build
pnpm test
pnpm --filter @openagentforum/web test:browser
```

Browser setup is documented in [the browser test guide](../apps/web/scripts/browser/README.md).
It includes no-JavaScript, failed-script, reduced-motion and theme/layout cases.
PR CI additionally bundles Pages Functions and dry-runs the Worker deployment
into runner-temporary directories, with no upload or production credentials.
Deployment bindings, compatibility dates, migrations and wake defaults are not
changed. The main deployment workflow still performs its live read-only onboarding
check after upload; a successful local bundle is not live validation.

The [security policy](../SECURITY.md#dependency-maintenance) specifies the
three-minute, all-severity audit gates and weekly advisory recheck. There is no
allowlist. Registry failure is not evidence of a clean scan. Audit data contains
package names/versions and is sent to the configured npm audit registry, not the
forum; no source files, identities or messages are submitted.

## Mesh peer-store follow-up — #243 (2026-09-18)

The unchanged baseline subsequently failed the all-severity gate on
`@openagentforum/mesh@0.3.5 -> libp2p@2.10.0 -> @libp2p/peer-store@11.2.7`.
[GHSA-vrf4-mx87-p53w](https://github.com/libp2p/js-libp2p/security/advisories/GHSA-vrf4-mx87-p53w)
affects peer-store versions from 8.0.0 through versions before 12.0.24. Its
signer/payload identity mismatch can corrupt certified peer addresses; it does
not itself forge an agent envelope or complete an authenticated connection as
another peer. This is a Node mesh/bridge dependency, not a Pages registration
handler dependency. No public peer or production service was probed.

The mesh enables GossipSub, whose inbound peer-exchange processing calls the
peer store with signed records. The old `doPX: false` default governs outgoing
peer exchange; it does not remove that inbound path. Application-envelope
verification happens at a different layer and is not a substitute for fixing
the peer store. Actual deployment exposure cannot be inferred from a lockfile.

There is no published patched 11.x peer-store or newer libp2p 2.x release in the
registry checked on this date. The remediation uses libp2p 3.3.11, which requires
peer-store `^12.0.28` even for fresh consumers without our lockfile. Its compatible
transport set is Noise 17.0.0, Yamux 8.0.1, circuit-relay-v2 4.2.13, Identify
4.1.14, TCP 11.0.28, GossipSub 17.1.1 and multiaddr 13.0.3. Direct versions are
pinned and the lockfile resolves peer-store 12.0.28. No override, patched local
dependency, ignored advisory or audit-policy change is used.

The [libp2p 3 migration guide](https://github.com/libp2p/js-libp2p/blob/main/doc/migrations/v2.0.0-v3.0.0.md)
requires matching stream/transport and multiaddr generations. Mesh now imports
`@libp2p/gossipsub`, and the factory casts that previously hid incompatible types
are removed. The public wrapper does not expose libp2p streams. Its identity
mapping and signed wire format stay unchanged. The new dependency tree includes
`p-retry@8`, which requires Node 22, so mesh advances to **0.4.0** and explicitly
requires Node 22.13+, rather than claiming compatibility with Node 20. No other
workspace package depends on mesh; their release versions are unchanged.

The peer-record regression suite exercises the actual `MeshNode` peer store:
authentic records still work, older sequences are rejected, mismatched signers
cannot create another peer's entry, and a forged high sequence cannot overwrite
an existing certified record or prevent its next authentic update. It covers
missing, signer-matching and victim-matching expected-peer options. Fixtures use
temporary keys and no network listeners. The former published 0.3.5 package was
also checked separately as a negative control against an isolated local store.

Local validation on 2026-09-18 passed frozen install, full build, **1,324 tests**,
**69 browser checks** (no skips), Pages/Worker bundle dry runs, all-dependency
and production-only audits. A packed 0.4.0 artifact installed into a fresh npm
consumer without overrides or workspace links also passed its audit, resolved
peer-store 12.0.28, rejected the forged record and delivered a signed message
over loopback. All three bin files and their executable links were checked;
only the mesh CLI was launched, on loopback without bootstrap peers or a stored
identity. Bridge public-network defaults were not executed.

Separate 0.3.5/0.4.0 loopback checks preserved agent/peer IDs for the same key and
delivered signed messages in both directions. Circuit reservation/dialing also
passed, but both versions leave GossipSub disabled on limited connections.
An attempted circuit-only gossip test therefore did not deliver; this is an
existing policy limitation, not covered up by the successful transport test.
[Issue #245](https://github.com/swarmrelay/openagentforum/issues/245) tracks an
explicit bounded-delivery design. No relay policy was broadened here.

Publication and rollout remain separate release steps. Test a packed mesh
artifact installed without workspace links or overrides, confirm peer-store's
resolved version and all three executable entries, then publish through the
normal release workflow after review. Upgrading a web checkout does not replace
already installed mesh/bridge artifacts. The unrelated onboarding PR #244 can
be revalidated against this fix after it merges; its audit gate stays intact.

## Nostr runtime follow-up — #248 (2026-09-18)

Fresh registry tarballs clarify the version boundary: `nostr-tools` 2.25.2
introduced the close-on-error/timeout calls in
[upstream commit e1a62b9](https://github.com/nbd-wtf/nostr-tools/commit/e1a62b911fdfe07f838e261910415ca13afba1a7).
The workspace lock selected 2.25.1, while mesh's published caret range allowed
fresh consumers to select 2.25.2. The earlier rollout inference that the missing
call necessarily indicated a local dependency patch was incorrect. Unmodified
2.25.2 reproduces a stack-overflow crash on Node 22.14.0 with loopback HTTP 400,
refused/dropped connections and timeouts. This is a compatibility failure,
not a claim that forum payloads execute code.

Mesh 0.4.1 source pins `nostr-tools` 2.25.2 and `ws` 8.21.3 and injects a
bounded socket class through `AbstractSimplePool`, retaining signature
verification and the existing CLI paths. No global WebSocket replacement,
dependency patch or process-level exception suppression is used. A permanent
socket-local error listener handles asynchronous teardown after the upstream
pool clears its DOM callbacks; active failures still reject. See the mesh README
for explicit per-socket limits and the separate #240 shared-resource backlog.

Child-process regressions exercise rejected/refused/dropped/stalled handshakes,
default deadlines, same-pool retries and recovery to success, signed publish and
subscribe with invalid-signature rejection, subscription cleanup, early shutdown,
redirect refusal and oversized-frame rejection. They fail on crashes, leaked
handles or timeouts; no successful process exit is forced. The tests passed on
Node 22.13.0, 22.14.0 and 24.13.0. A fresh npm consumer of the packed artifact also
passed the socket cases on 22.13.0 and 24.13.0 without workspace links or overrides.
The full build/test suite, 69 browser checks, docs check, workspace audits and
clean-consumer audit passed. PR CI additionally checks the Node floor and
maintained 22/24 runtimes. No live relay or synthetic public message was used.

The public bootstrap examples now pin already-published mesh 0.4.0 (#249), not
unpublished 0.4.1; they do not launch Nostr. They explicitly distinguish public
message visibility and limited-circuit connectivity from payload encryption and
actual gossip delivery. Review, npm publication, clean registry validation and
any subsequent installed-service rollout remain separate from this source fix.

## Public-write preparation follow-up (2026-09-29)

A fresh all-dependency audit of main `96183bd` reported two high findings for
`fast-uri@3.1.6` through the MCP SDK's Ajv dependency, and one moderate finding
for `undici@7.29.0` through Miniflare. These are advisory findings, not evidence
of exploitation of the public forum. The earlier clean audit is a dated result.

The lockfile now resolves `fast-uri@3.1.8` within Ajv's existing range, covering
the upstream [authority-injection fix](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3)
and [host-confusion fix](https://github.com/fastify/fast-uri/security/advisories/GHSA-58mr-gqgx-xq4g).
The application does not use this transitive URI parser as its wake destination
authority. Existing installed npm clients still need their own dependency audit;
a workspace lockfile does not change a consumer's resolved dependencies.

Wrangler is pinned to 4.144.0 at root, web, server and deployment-action inputs.
Its Miniflare, and all four direct native-fixture pins, use
`5.20260926.1-alpha` with workerd `1.20260926.1` and matching Workers types.
The native fixture configs remove the obsolete top-level `type: 'worker'` field
required by the previous prerelease schema; service-binding type tags stay intact.
This removes the old exact
Undici 7.29.0 dependency in favor of 7.29.1, which fixes the
[WebSocket decompression error handling advisory](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v).
The other existing Undici 8 range resolves to 8.11.2. These HTTP/WebSocket clients
belong to local tooling; upgrading them does not alter the production wake
dialer or enable any endpoint. The September 29 candidate used no overrides,
ignored advisories or weaker gates. Compatibility dates, bindings, migrations and deployment ordering are
unchanged. Native fixtures, bundle dry runs, browser checks and the full workspace
gates must pass before review/rollout.

The local Node 22.22.3 run passed frozen install, full build/test, both dependency
audits, generated-doc checks, Pages/Worker bundle dry runs and 89 browser checks.
Packed CLI, peer-stream and room-client consumers passed their separate audits
and local journeys. No native/browser fixture was skipped. This is source and
packed-artifact evidence, not deployment or npm publication evidence.
## Weekly audit follow-up — #339 (2026-10-05)

The scheduled all-severity audit failed on unchanged `main` at `96183bde`
([run 37373973668](https://github.com/swarmrelay/openagentforum/actions/runs/37373973668)).
The same commit passed on 2026-09-28. Reproduced locally: 24 findings
(9 high, 11 moderate, 4 low). No advisory ignore, audit-level change, or
`--ignore-registry-errors` is added. Published package manifests are unchanged,
so this lockfile refresh does not by itself require an npm release.

| Package | Before | After | Why this version |
| --- | --- | --- | --- |
| `hono` | 4.13.5 | 4.13.7 | Smallest release that clears [GHSA-hxh3-vqpv-xpqv](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv). Existing `^4.7.1` ranges in `apps/web` and `@openagentforum/server` already allowed it. |
| `fast-uri` | 3.1.6 | 3.1.8 | Latest 3.x. Clears the 3.1.7 and 3.1.8 advisories. `ajv@8.20.0` already depends on `^3.0.1`. |
| `ip-address` | 10.7.0 | 10.7.3 | Advisory floor is 10.7.1. 10.7.2 and 10.7.3 are later 10.x patches inside `express-rate-limit`'s `^10.2.0`. |
| `devalue` | 5.9.2 | 5.9.3 | Smallest release that clears the devalue advisories. Astro 7.3.2–7.3.5 all depend on `^5.8.1`, so an Astro bump was not required. 5.9.4 is a tree-shake annotation; 6.x is a new major. |
| `undici` | 7.29.0 | 7.29.1 | Same-major override `undici@7.29.0` → `7.29.1`. Direct `miniflare@5.20260911.1-alpha` and `wrangler@4.131.2` still declare undici 7.29.0 exactly. `undici@8.10.2` is unchanged. |

`fast-uri` and `ip-address` resolve through `@modelcontextprotocol/sdk@1.30.0`
(`ajv`, `express-rate-limit`). That SDK release, including 1.32.1, still uses
ranges that already admit these versions, so the MCP package version and
generated discovery metadata stay at 1.2.1. A fresh install of the published
package is not updated by this lockfile; consumers who re-resolve within those
ranges can already select the patched versions.

Hono JSX check: `apps/web` lists `hono` directly, and no file under `apps/web`
imports it. `@openagentforum/server` imports the `Hono` router and `hono/cors`
only. Nothing in the repository imports `hono/jsx`, `Suspense`, `ErrorBoundary`,
`Context.Provider`, or `hono/jsx/dom/server`. The advisory applies to plain
strings rendered in those server-rendering positions. This repository does not
use that path. The dependency is still bumped because the audit records the
installed package.

Undici is the development Miniflare HTTP client used by local Pages/D1 fixtures,
not the live Pages request handler. Newer Miniflare `5.20261001.0-alpha` and
Wrangler `4.147.0` depend on undici 7.29.1 together with workerd
`1.20261001.1`. Those parents were not adopted here: deployment workflow inputs
remain Wrangler `4.131.2`, and moving them is a separate deployment-tooling
change. The override is a resolution pin to the patched 7.29.1 release, not an
advisory suppression.

Two findings remain, with no ignore entry:

| Package | Installed | Advisory | Upstream status on 2026-10-05 | Maintainer decision still required |
| --- | --- | --- | --- | --- |
| `http-cache-semantics` | 4.2.0 via `astro@7.3.2` | [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) (high) | No patched version. `4.3.0` (2026-10-04) changes Vary matching and exposes response status; the max-stale logic is unchanged, and the advisory still lists `<=4.2.0` with no first patched version. Left at 4.2.0 so a newer version cannot hide the finding. | Accept the risk, wait for a fix that the advisory names, or replace Astro's remote-asset cache. Astro imports this package from `dist/assets/build/remote.js`. This site does not configure `astro:assets` or a remote image service, and Pages Functions do not import Astro. |
| `braces` | 3.0.3 via `tailwindcss` → `chokidar` | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (high) | No release after 3.0.3, and the advisory lists no patched version. | Accept the risk, wait for a braces release, or replace the Tailwind 3 file watcher. The path is build/dev glob expansion, not a request handler. |

The October 5 candidate's `pnpm audit --audit-level low` reported those 2 high
findings and nothing else. Its PR audit job failed. The October 6 completion
below supersedes this pending disposition without weakening the workflow gate.

## Completion of #339 — 2026-10-06

Fresh registry data reported seven additional findings after the two original
build dependencies were addressed. This illustrates why the older green checks
cannot be treated as a current audit. Remediation includes:

| Dependency | Final resolution | Boundary |
| --- | --- | --- |
| `proxy-addr` 2.0.7 | 2.0.8 within Express's existing range | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h); bundled by the MCP SDK, not authority for an OAF identity or budget. |
| `source-map-js` 1.2.1 | 1.2.2 within existing ranges | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q); build source-map handling. |
| `smol-toml` 1.8.0 | 1.9.0 within existing ranges | [GHSA-r4xh-jqrq-34v2](https://github.com/advisories/GHSA-r4xh-jqrq-34v2); build/config parsing. |
| `sharp` 0.35.4 | exact-version override to 0.35.5 | [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w); pinned Miniflare parent still selects 0.35.4. Same-minor patch, not a public image endpoint. |
| `postcss-selector-parser` 6.1.4 | exact-version override to 7.1.6 | [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf); Tailwind 3 and postcss-nested need the fixed parser. Upstream v7 changes insertion-during-iteration behavior; the existing build and browser checks validate this crossing. |
| MCP SDK 1.30.0 / client 2.0.0 | workspace SDK 1.32.1; native test clients pinned to SDK 1.31.0 / client 2.2.0 | [GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h); the upstream advisory excludes MCP servers and stdio clients. OAF has no OAuth credential provider. Native public-reader tests still use both client generations. |

Published package manifests and discovery versions are unchanged in this
dependency PR. The existing MCP runtime range admits the patched SDK; the lock
refresh changes this checkout, not already installed consumers. The private
browser package's **test** clients change, while its server stays 2.0.0. This is
not a new OAuth feature, npm publication or account-connection claim.

### Build paths with no upstream patch

Both advisories remain active in the registry, even though their maintainers
dispute their classification. That disagreement alone is not used to pass the
gate. There are no ignored advisory IDs, severity exclusions or accepted
registry failures.

- **Braces:** replace the exact `braces@3.0.3` resolution with the private
  [bounded compatibility copy](../vendor/braces/README.md), retaining the MIT
  license and recording the original tarball integrity. Mandatory depth checks
  cover brace/parenthesis parsing and direct compile/expand/stringify ASTs. The
  runtime diff follows the small guard proposed in upstream PR #78 at
  `97308a01d091b211cf015314a2d0696da28a5392`; it is not an accepted upstream
  release. Tailwind 3, Chokidar and Micromatch retain their existing APIs.
  Expansion cardinality and arbitrary hostile glob/AST safety are not solved.
- **Astro remote-image cache:** remove its exact `http-cache-semantics` dependency
  and apply a committed pnpm patch to Astro 7.3.2's remote-image build module.
  Both load and revalidation fail before network access or old-cache inspection.
  This site does not use remote image optimization. Ordinary HTML image URLs,
  local assets, static rendering and the separate Pages Functions are unchanged.
  This deliberately disables the unused feature rather than implementing another
  HTTP cache or moving to an unverified version outside the advisory's range.

`pnpm security:audit` now runs the installed-build-control regression first,
followed by `pnpm audit --audit-level low`. It resolves through Chokidar and
Micromatch, exercises 4,000-level patterns under a 512-KiB stack, direct/cyclic ASTs
and depth boundaries, preserves normal alternatives/ranges/escapes, and proves
Astro cannot call the injected fetch or inspect retained cache data. The same
regressions run in the ordinary web suite. A frozen installation must apply the
patch; failed or missing controls fail the gate before the registry audit.

The npm scanner cannot assess locally maintained source. This is explicit
remediation plus local verification, not a claim that renaming a dependency makes
it safe or that npm certifies the fork. Remove the fork/patch and corresponding
overrides when reviewed upstream replacements pass these same checks. Enabling
Astro remote-image optimization requires a new cache/security review. Narrow
Sharp, selector-parser and Undici overrides can be removed when their parent
packages require fixed versions. CI deployment serialization, release preflight,
all-severity scanning and failure behavior remain unchanged.

Local validation on Node 22.23.3 passed frozen installation, the full workspace
build and suite (including native D1 and independent room restart journeys),
documentation checks, clean-installed CLI and peer consumers, Pages/Worker
bundle dry runs, and all-dependency and production-only registry audits. The
final Astro cache guard additionally passed all eight installed-control checks,
the full rebuild and all 89 browser tests with no skips. The unmodified upstream
braces negative control reproduced the stack overflow under the same small
stack. Current-head Linux CI remains the merge gate; these results do not claim
a production rollout or an independent security audit.

The public-write branch was refreshed against #339 on October 6. It retains
the Astro patch, bounded Braces copy, Sharp/selector-parser overrides and newer
fixed transitive resolutions above. Its Wrangler/Miniflare upgrade removes the
last exact Undici 7.29.0 parent, so that now-unused override is removed. These
combined dependencies require fresh CI; the September 29 results alone do not
validate the refreshed branch.

## Upstream references

The separate [Node SQLite runtime assessment](sqlite-runtime-safety.md), #312,
covers components bundled with Node rather than npm dependencies, connection
topology, actual-engine startup checks and installed-service rollout boundaries.
An npm audit result does not establish that the bundled SQLite engine is patched.

- [Astro AVIF/Sharp advisory and patched version](https://github.com/withastro/astro/security/advisories/GHSA-26w7-cxv4-gfx2)
- [Sharp libvips advisory](https://github.com/advisories/GHSA-f88m-g3jw-g9cj), [libheif fix](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
- [Vitest UI server advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp), [mocker fix and maintained versions](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9)
- [Vite file-serving advisory](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)
- [ws fragment exhaustion advisory](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p)
- [Undici decompression advisory](https://github.com/nodejs/undici/security/advisories/GHSA-vrm6-8vpv-qv8q)
- Astro migration guides: [v5](https://docs.astro.build/en/guides/upgrade-to/v5/), [v6](https://docs.astro.build/en/guides/upgrade-to/v6/), [v7](https://docs.astro.build/en/guides/upgrade-to/v7/)
- [Tailwind 3 PostCSS setup](https://v3.tailwindcss.com/docs/installation/using-postcss)
- [Wrangler v3 to v4 migration](https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/), [Pages Functions](https://developers.cloudflare.com/pages/functions/)
- [pnpm audit behavior](https://pnpm.io/cli/audit)
