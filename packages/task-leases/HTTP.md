# Unmounted task-lease HTTP/client integration (#225 / #238)

`src/http-server.ts` and the Pages factory
`apps/web/functions/_lib/task-lease-http.ts` compose the dedicated task authority
with a bounded transport. No production route imports them. The package remains
private and source-only. The existing `/v1/tasks` contract, discovery pages and
SDK/CLI/MCP operations are unchanged.

## Trusted composition and routes

The operator supplies the exact HTTPS origin, audience, generation, policy
revision and finite policy independently of requests. A caller-owned handler
retains one store instance and its shared poisoning/concurrency scope; do not
replace a failed instance to bypass uncertainty. The factory never provisions,
adopts or repairs a database. Its schema is incompatible with production tasks.

| Method | Draft path | Durable attempt lane |
| --- | --- | --- |
| POST | `/v1/task-leases` | ordinary (`create`) |
| POST | `/v1/task-leases/{fullTaskId}/claim` | ordinary |
| POST | `/v1/task-leases/{fullTaskId}/reopen` | ordinary |
| POST | `/v1/task-leases/{fullTaskId}/submit` | completion |
| POST | `/v1/task-leases/{fullTaskId}/release` | completion |
| POST | `/v1/task-leases/{fullTaskId}/receipt` | recovery |
| GET, HEAD | `/v1/task-leases/{fullTaskId}` | none; bounded read-only snapshot |

Paths use the complete `task_` + SHA-256 identifier. Query strings, trailing
slashes, legacy IDs/paths and wrong methods are refused. The exact URL origin and
any supplied Origin header must match the pinned origin. No CORS permission or
redirect is supplied. POST accepts JSON with optional UTF-8 charset and no content
encoding other than identity. Invalid headers/declared sizes fail before storage.

The trusted route selects the lane. After the store commits its durable attempt
charge, a deferred reader pulls at most 32 KiB in at most 4,096 reads, with strict
UTF-8 and an independently pinned body deadline within the overall preparation
deadline. Actual bytes count even without Content-Length. The parsed action/task
must match the route, then the exact original wire goes to canonical signature
verification and current primary authorization. The route check only rejects;
it never grants authority or rewrites signed fields. Rejected work retains its
charge, including a wrong operation sent to the completion lane.

Responses have fixed no-store errors and at most 32 KiB of JSON. A dispatched
commit with a lost, late or unrecognized outcome returns `task_outcome_unknown`.
The handler never treats cancellation as rollback. Known refusals remain fixed
400/409/413/415/429/503 responses without storage details. Attempt exhaustion
includes a bounded Retry-After hint. GET/HEAD never claims, expires or charges a
task; the returned view omits results and receipt history. Public read admission
would need additional protection before mounting.

## Explicit client and journal contract

`TaskLeaseHttpClient` accepts independently pinned scope and one full actor key.
It verifies canonical signatures before sending, sends one request with redirects
disabled, consumes a bounded response under one deadline and matches all receipt
fields against the retained operation and scope. It does not sign, discover an
identity, retry, execute task content or interpret a receipt as a current lease.
Responses are hub assertions over HTTPS, not separately signed receipts.

`JournaledTaskLeaseClient` first awaits a trusted `retain(operation)` callback,
then sends. It acknowledges only a matching found receipt. The callback contract
must durably preserve the exact wire/scope/operation/digest before resolving and
must refuse conflicting reuse or capacity exhaustion. A failed retain prevents a
send; a failed acknowledgment leaves recovery to the caller. This slice supplies
the interface, **not a production persistent journal, custody policy or eviction
scheme**. Do not use an in-memory callback as durable production storage.

Recovery takes both the retained original operation and an explicitly signed fresh
receipt query. `unavailable` leaves the operation pending. Every client error has
`permitsReplacementMutation: false`; neither an error nor a historical claim
receipt authorizes a new operation or an external effect. Each client/journal
wrapper is single-flight. The transport does not automatically retry a fresh
original wire, though the store still supports explicit exact replay.

## Local evidence and remaining gates

Run the package build/tests as described in the [README](README.md). Tests cover
SQLite transport behavior, full-key receipt correlation, malformed/oversize/stalled
streams, route mismatches, retained work charges, separate completion/recovery
lanes, lost responses, failed durability callbacks and read-only expired views.

The native workerd fixture bundles the actual Pages factory without Node/SQLite
imports. It inspects the persisted D1 attempt row at the first body pull, tests
unknown commits and shared-handler poisoning, and restarts the full local worker
and D1 persistence. Two separate Node client processes retain a private fixture
journal before POST, lose a successful response, then recover the exact receipt
after the server restart. That fixture journal syncs its file and directory; it
is test infrastructure, not a released checkpoint implementation. Fixture
networking is parent-owned loopback and rejects outbound requests. HTTPS origin
matching inside the fixture does not establish live TLS or production evidence.

Production still requires all-writer shared admission (#238), operator policy,
legacy-writer exclusion, fenced backup/restore and audience lineage, distributed
work bounds, a reviewed durable client journal and separate SDK/CLI/MCP publication.
The dedicated task counter does not share the poll authority. No production
migration, route, scheduler, quota default, npm export or availability change is
included. #225 and #238 remain open.
