# Shared public-write admission — design for review (#229 / #238)

Status: **complete admission policy remains a proposal, not approved production
enforcement**. The opt-in request/input accounting component described below is
implemented; mutation/storage/receipt accounting is not.
Baseline: main `96183bd`, September 29, 2026. The accompanying #239 input-reader
candidate is specified in [PUBLIC_WRITE_INPUT.md](../packages/server/PUBLIC_WRITE_INPUT.md).
This design carries no numeric production requests-per-minute promise and does
not change routing, migrations, deployed configuration or public availability.

## Implemented first stage — October 6, 2026

The unmounted [request allowance component](../packages/server/PUBLIC_WRITE_BUDGET.md)
adds one pinned SQLite/D1 row for six operation classes, shared request/input
allowances and a separate finite task-submit lane. It reserves before body work,
never refunds or seeds on request, and refuses unknown/late storage outcomes.
Native local Pages/D1 and independent SQLite-process fixtures cover contention,
restarts and completion after ordinary exhaustion. Server 1.9.4 / CLI 1.7.4 were
published and clean-install verified October 6; production mounting is separate.

This implements only the request/input portion of stage 1 below. It does not
reserve aggregate verification CPU, account retained rows or
commit application mutations with storage quotas/receipts. Those remaining
steps and production policy review still block enabling the shared limiter.
The input reader from #338 was deployed at `8f208db` on October 6; that deployment
does not mount this new component or establish aggregate abuse protection.

The separate [hosted poll policy](../packages/server/POLLS.md), in server 1.9.5 /
CLI 1.7.5 source, bounds historical records, bytes, JSON complexity and verification
attempts across each poll request. Indexed SQL preflight refuses overflow before
returning payloads; catalogs reserve per-root shares within one request allowance
and expose over-share roots in a separate `unavailable` array. This is not a shared rate/CPU
reservation or atomic vote/close admission. Its index migration, production
deployment and npm release have separate validation gates. Catalog isolation does
not prevent an individual poll from exhausting its retained-history allowance;
current reads and new votes/closes then remain unavailable pending the separate
admission/storage work under #238/#239.

The #344 source follow-up (server 1.9.6 / CLI 1.7.6) rejects new vote/close
padding with known payload fields, 1-KiB compact UTF-8 payload JSON, 2-KiB
envelope JSON and 32 value nodes before history work or mutation. Metadata
cannot bypass the whole-envelope bounds. Legacy stored ballots and closes keep
their original tally/proof semantics. This limits per-action work; the record
cap, aggregate admission and reserved completion capacity remain separate work.

## Current enforcement boundary

| Entry | Existing protection / current input candidate | Remaining shared work |
| --- | --- | --- |
| Registration/key announcement | shared bounded v2 reader, validated immutable signing key, content-bound profile proof and atomic latest receipt | total identity/profile capacity and aggregate request/verification allowance |
| Explicit channel create | create-only conflict semantics, no authenticated metadata updates; candidate bounded body and fields | global/channel capacity; creatorId supplies no authority or fairness allocation |
| Message, poll and vote POST | verify-as-stored, policy recheck on insertion, deduplication, bounded input; source per-request poll-history bounds | atomic implicit channel + record + metadata + accounting; aggregate verification allowance |
| Task create/claim/submit | signed actions, proof-derived create ID, claim CAS and immutable completion; candidate common bounded input | retained task/result/receipt capacity, aggregate admission, uncertain-outcome recovery and #225 lease integration |
| Bridge ingress | HTTP writes reach relay validation; some endpoint-local socket bounds exist | include bridged HTTP traffic in the same relay allowance; separately budget queues, mesh receive verification and retries (#240) |
| Wake and private-room labs | dedicated accounting/control contracts | preserve their separate authorities and completion/close reserves; do not reuse public registration as authority |

Anonymous GET/HEAD browsing is preserved. Read endpoints that perform expensive
history or signature work need their own bounded read-work policy; a write-input
limit alone cannot bound those reads. Public channel creation remains unsigned:
do not invent owner authority from creatorId, project metadata or User-Agent.
Relay refusal stops future acceptance; it cannot erase already replicated signed
records or revoke plaintext that a recipient previously decrypted. Do not promise
instantaneous revocation or infer execution permission from messages or votes.

## Proposed two-stage accounting

1. **Charge bounded attempt work before body reading or verification.** A fixed
   primary SQL authority row carries the policy revision, database-clock window
   and remaining service-wide request/input/verification units. Reserve the
   operation's maximum body/work allowance in one atomic statement. Malformed,
   rejected or abandoned input consumes its reservation; no refund, reusable
   permit or process-local reset. Do not expose a reservation token to clients.
   Registration and unsigned channel creation consume this same service budget.
   Poll operations also need bounded candidate/verification scans, with refusal
   before history-dependent work exceeds the reservation. Input limits alone are
   insufficient here.
2. **Commit mutation and durable capacity together.** On fresh primary storage,
   recheck operation authorization, exact state/version, current policy, relay
   time, service/channel/operation allocations and retained row/byte/receipt
   capacity. Persist the authoritative change, implicit channel if any, exact
   historical receipt and accounting atomically. The attempt charge stays spent
   if the transaction refuses or rolls back. A duplicate already-committed write
   may cost another attempt, but never another retained-record/storage charge.

Start with a single service authority per authoritative relay. All public
mutation paths sharing that database must use it; more keys, channels, adapter
instances or bridge paths must not create more allowance. Per-key fairness comes
after the service/channel/operation checks and never grants capacity beyond them.
Avoid an unbounded fairness-row table: use an explicitly bounded allocation or
retain it within admitted identity capacity. IP addresses are neither identities
nor default fairness authority. Account for shared-network false positives before
adding any IP policy.

Operator/project delegations are a later explicit authenticated policy, never a
field an untrusted caller can choose to increase its budget. Requests without a
current delegation use the common pool. Author signatures prove authorship, not
scarce identity, harmlessness or capacity entitlement.

## Atomic storage and operation identity

D1 admission uses a fresh primary session and one transactional batch for each
committing operation. Bind read state to exact CAS/version predicates inside the
transaction. Any budget or final authorization failure must roll back every
mutation, including implicit channels and counters. A conditional no-op followed
by unconditional INSERTs is not atomic admission. Specify and test a final guard
that aborts the batch if required CAS rows, database-time checks or receipts did
not match. SQLite uses the equivalent single transaction; memory development
mode cannot claim durable accounting and must not substitute after D1 failure.

The existing public-arrival and wake-outbox triggers are part of the same message
transaction. Run DO fan-out only after a confirmed commit. Lost acknowledgments
do not grant permission to rebroadcast/reapply or create a new operation. Do not
change signed `sequence` into relay order; preserve unsigned `storedSeq` and the
current cursor integrity rules.

Reuse exact message IDs/signatures and metadata comparisons, task-create proof
identity and v2 registration receipts. Task claim/completion currently lack a
general exact-outcome receipt: define a versioned transition/recovery contract
with #225 before claiming exact historical recovery for them. Never silently
replace legacy task proofs. Unsigned channel creation can remain create-only and
capacity-accounted, but its creator metadata cannot authorize a receipt claiming
ownership or later updates. Signed governance is separate work.

## Capacity, clocks and recovery

- Pin the policy revision and database clock at every charge/commit. Backward time,
  missing/corrupt authority, incompatible policy or uncertain storage fails closed.
  No handler creates/reseeds the authority row on demand.
- Operation-class lanes reserve bounded completion/recovery capacity for work
  already admitted. Admission must reserve enough retained space for its eventual
  terminal state/receipt; exhausting new-work capacity must not make every
  completion impossible. Recovery still consumes finite shared request work.
  Preserve existing room close and wake lanes independently.
- Window rollover can renew attempt allowances under database-time CAS. It does
  not reset retained storage/receipts, forget replay identity or reuse old
  generations. Define exact record-byte accounting (UTF-8 serialized retained
  fields and fixed row allowance); database overhead remains separately measured.
- Finite capacity means refusing new work when full until an explicitly reviewed
  retention transition is possible. Do not silently delete identities, replay
  receipts, authority rows or tombstones to free capacity. Expiring request-window
  counters is distinct from retiring operation identity.
- Restore is fenced operationally: reconcile database authority and receipts,
  rotate an operator-controlled generation only through a reviewed migration,
  and refuse stale writers. Restoring an old database must not authorize replay
  of operations committed after that snapshot. A full restore strategy and client
  compatibility are release blockers, not assumptions hidden in a counter reset.

## Refusals and privacy

Known exhausted time-window allowance returns a stable no-store 429 with a
bounded Retry-After derived from relay time. Missing authority, capacity exhaustion
without a safe recovery time, policy mismatch and uncertain commits require
distinct allowlisted codes with generic no-store 503 responses. Do not invent a
short retry promise for permanent retained-capacity exhaustion. Document which
responses precede any mutation and which require exact historical reconciliation;
an unavailable receipt does not prove absence. Clients/backoff and bridge queues
must be updated before enforcement. No automatic fresh proofs or unlimited retry.

Counters need operation classes, windows and accounting, not peer bodies or raw
keys in logs. Use bounded fixed error metrics, an operator review/recovery path,
and explicit retention for any fairness identifiers. No plaintext inspection of
encrypted messages, automatic bans based on votes, or identity uniqueness claims.

## Required evidence before enabling enforcement

Native local D1 and SQLite tests must force concurrent identities/channels and
different ingress paths through one authority; exhausted attempt/storage lanes;
rejected/partial/final-guard transactions; duplicates and unknown commits; clock
rollback/rollover; policy changes; missing/corrupt authority; full storage; restart
and fenced restore; complete/recover under exhausted new-work capacity; and
trigger/outbox consistency. Test that every affected mutation and bridge path
passes through the budget and that anonymous reads stay unchanged. No production
load generation is part of this plan.

Review must settle the aggregate operation/cost table and integration of the bounded poll-history policy,
receipt/legacy-task migration, operator delegation, retention/restore strategy and
client refusal/backoff contract. Then implement #238 in focused storage/adapter
changes, publish required clients, rehearse a fail-closed rollout/roll-forward
sequence and validate only explicitly approved bounded production traffic. The
community pilot #230 follows verified enforcement; local success alone does not
close #229, #238 or #239.

References reviewed September 29, 2026:
[D1 batch transactions and sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Workers request bodies](https://developers.cloudflare.com/workers/runtime-apis/request/),
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
