# Poll admission HTTP and exact-operation clients — #238

**Private, source-only and unmounted.** No production route imports the Pages
factory `apps/web/functions/_lib/poll-admission-http.ts`. It uses the dedicated
[D1 store](D1.md); the shared handler also supports [SQLite](README.md). This is
not a production migration, published SDK or complete public-write admission.

## Wire and work

Bodies contain the original signed envelope JSON, without a wrapper or rewritten
fields. Trusted paths select finite work lanes before any body pull; the signed
channel and poll ID must subsequently match the path.

| Draft POST path | Lane | Operation |
| --- | --- | --- |
| `/v1/channels/:channel/messages` | ordinary | Supported root, ballot or `intel` |
| `/v1/channels/:channel/polls/:pollId/close` | completion | Creator close for that exact poll/channel |
| `/v1/channels/:channel/messages/recovery` | recovery | Historical exact-envelope receipt lookup |

Production messages still use the existing handler. The other two paths are not
public APIs. Public browsing is unchanged; GET/HEAD sent directly to this handler
returns 405 without work accounting or mutation.

`prepare`/`recover` additionally accept trusted `{ read, signal }` input. The
store commits its durable request/input/verification charge before invoking
`read` once. No transaction spans the body await. The HTTP reader bounds actual
bytes, chunk count, strict UTF-8 and time. Malformed, oversized, stalled, aborted
or abandoned bodies never refund the charge. Exhaustion refuses before pulling
the body. Route mismatches consume the selected lane. Invalid completion attempts
can exhaust finite completion work; reserved storage is not an availability SLA.

Origin, generation, policy revision, full policy and body timeout are operator
configuration. The body timeout cannot exceed the preparation lifetime (at most
five seconds); the overall deadline includes charge, body, verification and commit.
Keep handler/store in a caller-owned scope. Its eight-operation bound and poisoned
state are local, not distributed. The adapter stores no request I/O or D1 binding
in Worker globals. Production ingress/concurrency policy remains required.

Path, method, supplied Origin, JSON media type, encoding and Content-Length checks
precede charging. Those bounded refusals still cost resources and are not an
ingress limiter. Actual byte counting never trusts Content-Length. Missing or
mismatched authority refuses before body reading; requests never initialize,
reset or adopt policy or fall back to memory. Originless clients are accepted;
supplied Origin must match the exact HTTPS pin. Cookies, cross-origin browser
permission and caller-selected quota headers are not used.

## Responses and uncertainty

Responses are at most 4,096 bytes, with `no-store, no-transform`, nosniff and
no-referrer. Errors contain fixed codes, never proofs, bodies or SQL diagnostics.
Access-log policy remains an operator release requirement.

| Status/code | Meaning |
| --- | --- |
| 200 | Historical result; `unavailable` never proves absence |
| 400 / 408 / 413 / 415 | Invalid, timed-out, oversized or unsupported request |
| 403 / 404 / 405 | Wrong Origin, destination/path or method |
| 409 `poll_request_refused` | Generic proof/state/route/exact-operation refusal |
| 429 `poll_rate_limited` | Exhausted work lane; conservative one-window Retry-After of 1–86,400 seconds |
| 503 `poll_capacity` | Retained/history capacity unavailable; no retry-time promise |
| 503 `poll_unavailable` | Configuration, authority, contention or charge failure |
| 503 `poll_outcome_unknown` | Dispatched commit/transport outcome uncertain |

Deadlines bound waiting, not execution or rollback of a dispatched D1 batch.
Timed-out preparation cannot proceed to HTTP commit; an in-flight commit may
finish. No later refusal or unavailable receipt settles an earlier uncertainty
or authorizes a fresh ID. No automatic POST/proof/reservation retry is added.

## Client and durable journal

`PollHttpClient` validates envelopes with an independently pinned full actor key,
sends one explicit POST, rejects redirects, omits credentials and bounds response
time/bytes/UTF-8. It correlates receipt shape, origin, generation, policy revision,
actor, ID, channel, signature and checksum. Positions/time remain unsigned relay
assertions; receipts are historical, not fresh permission. Errors always expose
`permitsReplacementMutation: false`. This low-level transport has no persistence.

`JournaledPollClient` awaits durable exact-wire/context retention before POST.
Failed retention sends nothing. Uncertain replies and failed local acknowledgments
leave the operation pending. Recovery is explicit and uses the same wire;
unavailable recovery stays pending. No automatic resubmission, new proof or eviction.
If local `acknowledge` throws after a `found` reply, the call throws the journal
error without returning that receipt. This does not mean the remote operation
failed or was absent; retain the original wire and explicitly recover it later.

`SQLitePollJournal` supplies this storage on an operator-owned dedicated local WAL
database, with the maintained-engine guard and `synchronous=FULL`. Protect its
directory outside the checkout and close the connection explicitly. It contains
public keys, signed operations and receipts, never private signing keys; operation
bodies may still be private workspace data.

`provisionPollJournal` is explicit empty-database setup. Constructors and client
methods never create/reset/adopt state. Pins include origin, key, generation,
policy revision and explicit limits (up to 512 operations and 16 MiB logical
bytes). Each retained operation reserves 4,096 bytes for its acknowledgment, so
full new-operation capacity does not block that acknowledgment. Exact retention
retries add no rows; different bytes for an existing ID conflict. Pending and
acknowledged operations both remain retained, without automatic retirement.
Logical limits exclude SQLite pages/indexes/WAL overhead. Deleting or restoring a
journal cannot prove earlier external work absent.

Transactions recheck schema, pins and limits; unknown local outcomes poison the
instance. Reopening cannot settle uncertain server outcomes. `get(id)` only reads;
transport validation still precedes network operations. Journal/peer contents
never grant execution or spending authority. Production key-custody UX and client
packaging remain separate work.

## Evidence and remaining gates

Native workerd/D1 fixtures bundle the actual Pages factory without Node imports.
Separate temporary client processes use durable local SQLite journals and the
real client. Parent-owned IPC forwards bounded requests to the local fixture;
this is not independent remote agents or TLS evidence. A lost committed vote
response survives D1/client restarts and resolves from its retained wire without
another insert. Close/recovery survive ordinary exhaustion. Other tests cover
route/origin mismatches, charge-before-pull, malformed/stalled/chunked bodies,
hostile responses, journal limits/conflicts and local retention/ACK failures.
No test posts publicly.

#238 still needs production-compatible storage/capture integration, registration,
profiles, explicit/implicit channels, operation/per-key allocations, task receipts
and #225 lease fencing, all bridge/writer paths, fenced backup recovery, reviewed
limits, published clients and bounded approved rollout. This does not enable the
#230 pilot. See the [complete design](../../docs/public-write-admission.md).
