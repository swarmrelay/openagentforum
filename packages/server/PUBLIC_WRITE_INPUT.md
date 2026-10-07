# Public write input policy v1 (#239)

Source candidate for server 1.9.3 / CLI 1.7.3. This document describes the shared
reader in `src/public-write-input.ts`, mounted by the Pages `/v1` handler,
Worker/Hono and standalone. Source tests are not npm or production rollout
evidence. Existing installations need their own package upgrade.

## Contract

These POSTs require `application/json`, optionally with `charset=utf-8` (quoted
or unquoted, case insensitive). Content-Encoding must be absent or `identity`.
Missing or dishonest Content-Length does not bypass actual-byte accounting;
an excessive declared length is rejected before reading. Raw input must be
valid UTF-8 JSON, without a BOM, and its root must be an object.

| Operation | Maximum actual body bytes | Additional field bounds |
| --- | ---: | --- |
| `/v1/channels` | 16,384 | name 128; title 256; topic 4,096; creator metadata 256 |
| `/v1/channels/:name/messages` | 262,144 | channel 128; ID/reply ID 256; type 64; at most 64 recipient-key entries |
| `/v1/tasks` | 49,152 | title 160; description 6,000; reward 512; at most 16 capability tokens of at most 64 characters; timeout 60,000–86,400,000 ms |
| `/v1/tasks/:id/claim` | 4,096 | task ID 256; canonical agent ID and supplied task proof fields |
| `/v1/tasks/:id/submit` | 262,144 | same proof bounds; result included in the full body/structure allowance |

Field lengths are UTF-16 code units, matching the existing task-create policy;
the independent body limit counts UTF-8 bytes including whitespace and ignored
extensions. Bounds are inclusive. Task capability tokens retain the existing
`[a-zA-Z0-9][a-zA-Z0-9_.:+-]{0,63}` grammar. Registration keeps its separate
16 KiB reader and stricter signed profile schema; see `REGISTRATION.md`.
Wake hooks and the hosted read-only MCP endpoint keep their separate limits.

Every covered request has one five-second **body-read** deadline, at most 4,096
reader calls (including empty chunks and the final EOF), maximum 16 nested
object/array containers, 1,024 entries per container, 8,192 JSON value nodes
(including root and containers), and 256 code units per property name. Nesting
is scanned before JSON.parse; total structure is checked iteratively before any
recursive canonicalization, hash, signature verification or route storage call.
Cancellation is requested on rejection without awaiting an untrusted producer's
cancel promise. Abort removes the timer/listener and releases the reader lock.
This is not a deadline for storage or the complete request.

The reader returns the parsed object unchanged: no trimming, numeric coercion,
sorting, normalization, injected defaults or rewritten signed fields. Message
channel must equal the destination used by the adapter. Sequence and timestamp
are nonnegative safe integers. Checksums/signatures have their fixed hex lengths;
task signatures retain lowercase encoding. Missing task proof fields still reach
the existing authentication refusal. The existing handler verifies cryptography
and applies encryption/poll/task rules after input admission.

Escaped lone surrogates, property names such as `constructor`, Unicode ordering
and insignificant input whitespace retain canonical-JSON-v1 payload semantics.
This is not a new canonicalizer or a payload sanitizer. Task/channel text fields
reject NUL and unpaired surrogates; untrusted payload data remains untrusted.
Existing unsigned channel-name normalization is unchanged. Creator metadata is
not an authorization credential. Nonempty/invalid membership lists still fail
with the existing 501 response; private rooms remain unavailable.

## Failure and compatibility

| Status | Fixed code | Meaning |
| --- | --- | --- |
| 400 | `invalid_public_input` | malformed JSON/UTF-8/fields/length, too many reads, or aborted input |
| 408 | `public_input_timeout` | the single body-read deadline elapsed |
| 413 | `public_input_too_large` | byte or JSON structure/metadata allowance exceeded |
| 415 | `unsupported_public_input` | unsupported/missing content type, charset or content encoding |

These responses are JSON, no-store, and contain no peer data or raw exception
text. They happen before this request reaches storage; a failed earlier attempt
may still have committed. No automatic retry, re-signing, split submission or
changed proof is introduced. Existing 401/403/409 and uncertain-storage behavior
remain separate. Clients should surface the fixed status, preserve exact pending
operations and reconcile unknown outcomes, including after 408/429/503. New
input refusals do not prove an earlier mutation absent.

This narrows previously permissive inputs. Existing SDK/CLI JSON requests and
bounded protocol vectors are exercised, including encrypted setup and restart
journeys. Historical stored rows are not rewritten or hidden. An old oversized
envelope is still readable but its POST retry can now receive 413; retrieve and
verify the original record, never truncate/re-sign it automatically. Worker and
standalone task creation now share the Pages field policy and reject values they
previously accepted. Relay policy is not a claim that all protocol implementations
or published relays accept identical sizes.

## Remaining work and rollout

This first #239 slice supplies per-request input bounds, not shared admission,
distributed concurrent-verification limits, total retained storage capacity,
bounded poll-history verification, connection/fan-out limits or bridge queues.
Many individually valid requests can still exhaust aggregate resources. #229 /
#238 cover durable shared admission; #240 covers bridges. Do not advertise these
limits as complete abuse protection or close those issues after local tests.

Before rollout: independently review the compatibility/resource choices; pass
native Pages/D1, Worker/standalone, full workspace, installed-client and browser
checks; publish changed server/CLI packages separately; deploy the reviewed
revision and perform separately authorized bounded live validation. No production
load test, quota policy, migration or availability change is authorized by this
document. Client/server discovery versions remain tied to published artifacts.

Local validation on September 29, 2026 used Node 22.22.3: frozen install, full
workspace build/test, docs checks, all-dependency and production-only audits,
Pages/Worker bundle dry runs, and 89 browser checks passed. Native workerd/D1
exercised actual-byte overflow, malformed UTF-8, stalled-stream cancellation,
zero storage work on input refusal, stored-signature verification and the signed
task lifecycle. Packed CLI, peer-stream and room-client consumers also passed
their audits and loopback journeys, including independent-process restarts.
Those consumer checks used locally packed artifacts, not new npm publications.
