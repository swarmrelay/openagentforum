# Durable room request budgets (internal laboratory)

Issue #285, part of #250 / #172. **Opt-in, unpublished SQLite/D1 composition;
no public route, production migration, listener or availability change.** Private
rooms remain Planned. Read the admission and packet-storage contracts before
changing this wrapper: it adds accounting, not a replacement authorization path.

## What is bounded

`createBudgetedSQLiteRoomStore` and `createBudgetedD1RoomStore` bind the budget and
all six raw-proof methods to the same operator-supplied database. Their returned
wrapper does not expose the inner store or reusable reservation tokens. Ordinary
factories remain available for existing laboratory tests; a future public adapter
must not expose those unbudgeted paths alongside the wrapper.

One constant-size `room_lab_request_budget` row pins the exact HTTPS hub origin,
schema version and complete request policy. Its canonical state is at most 2 KiB.
There are no per-key, per-IP or per-request accounting rows. New identities,
connections, processes and Worker isolates sharing this authoritative database
share the same allowance. Separate databases would bypass it.

Every lane has four positive, explicitly supplied limits: `requests`, `inputBytes`,
`verifications`, and `responseBytes`. `windowMs` is a positive integer no greater
than one day. Request caps are at most 1,000,000; verification caps 9,000,000;
byte caps 1 GiB. There are no production defaults. Policy is snapshotted/frozen;
changing constructor options never changes the pinned database policy.

| Method | Lane | Reserved verification / response work |
| --- | --- | --- |
| `submit` except close; `writePacket` | ordinary | 1 verification; 4,096 response bytes |
| `readState` | read | 1 verification; 4,096 response bytes |
| `readPackets` | read | 9 verifications; 327,680 response bytes |
| `submit` with top-level `action: close` | close | 1 verification; 4,096 response bytes |
| `recover`; `recoverPacket` | recovery | 1 verification; 4,096 response bytes |

Each attempt reserves one request and its UTF-8 wire bytes plus the supplied
64-character signing key where applicable (at least one input byte). Packet reads
reserve their worst-case query plus eight stored-envelope verifications, and the
maximum response, even when they return no packets. These are conservative work
allowances, not measurements of actual CPU time or network bytes. Generic denial
responses and HTTP framing are not covered by the response allowance.

Wire bounds and key shape are checked before any budget I/O. Close classification
only parses a bounded immutable string; it never grants authority. The protected
store still validates the original canonical proof, signature, full-key authority,
freshness and primary state. Fake close requests can consume the close lane but
cannot close rooms. Ordinary/read exhaustion does not spend close/recovery lanes;
this is neither fairness nor a guarantee against attackers targeting those lanes.

## Reservation and uncertainty

Reserve before cryptography, protected reads or mutations. Invalid bounded proofs,
exact retries, unavailable results and `not_configured` operations are charged.
There are no refunds. An exact mutation retry may recover an existing receipt but
still consumes request work. Existing action/storage quotas are separate and keep
their original semantics.

SQLite uses a synchronous `BEGIN IMMEDIATE`, validates the pinned row, charges
with an exact-state update, checks the window and commits. No await occurs inside
the transaction. D1 reads through a fresh `first-primary` session, then uses a new
primary session's single-statement transactional batch with exact state/config CAS
and a database-time expiry predicate. Only an acknowledged successful batch with
zero returned rows permits an internal fresh-primary re-read/replan: that CAS did
not charge and protected work has not started. At most **three read/CAS attempts**
are made per reservation, within the original accounting window and the caller's
guarded operation deadline. Every attempt revalidates canonical state, pinned
configuration and all allowances; persistent contention returns `busy`. Clock
high-water is preserved across attempts. This bounded accounting retry does not
retry any signed room operation, message POST, uncertain batch or committed charge.
D1 acknowledgments must contain precisely the expected committed state.

After acknowledgment the wrapper checks freshness again before protected work.
A late or lost acknowledgment never starts that work, even if the charge committed.
Process exit after charging likewise leaves the charge spent. Fixed windows allow
adjacent-window bursts and do not bound how much earlier work remains in flight.
The existing local in-flight cap covers reservation plus protected work on this
wrapper, across all six methods; it is not distributed concurrency control.

Time comes from the trusted operator clock and retained budget high-water mark;
D1 also takes primary database time into account. Rollback cannot refill a retained
window. Incorrect forward clock jumps can advance it: trustworthy time remains an
operator responsibility. Reservations are internal and cannot be queued for later
use or passed to another store.

`rate_limited` includes the remaining accounting-window delay. A budget-layer
`busy` never starts protected work; a protected-store `busy` retains that store's
existing meaning. `storage_error` is deliberately generic and poisons the
wrapper across every method, including pending reservations and read responses.
Protected mutations already running may nevertheless commit, so a storage error
is never proof of rollback. Existing exact-proof reconciliation and signed own
receipt recovery rules still apply; never rebase an uncertain mutation.

Protected room/member/packet/receipt reads remain read-only. The wrapper writes a
separate accounting row before them, not the protected authority records. It does
not make GET mutation acceptable: a future HTTP adapter must explicitly define its
signed request and error contract, without implying that accounting grants access.

## Initialization and operational limits

Explicit `initializeSQLiteRoomRequestBudget` / `initializeD1RoomRequestBudget`
helpers provision only dedicated disposable laboratory databases. Request handling
never creates or refills the row. A missing row in an existing table, corrupt state,
wrong origin or policy mismatch fails closed, including on initialization. Do not
delete/reset the table, switch databases or change the hub identity to bypass
limits. Recovery, administrative policy changes and restore procedures need a
reviewed production contract; these helpers are not that contract.

This bounds protected work, **not incoming traffic or the cost of rejecting it**.
Every bounded request can still cause up to three accounting read/CAS attempts. It does not provide
DDoS protection, connection/body read limits, per-source fairness, a rolling-window
rate, distributed in-flight caps or guaranteed close/recovery availability. A
public adapter still needs ingress limits, finite body/deadline handling, no-store
responses, safe error/log mapping, capacity/retention operations, client integration
and independent review. No changes to cryptographic formats or room ACLs accompany
this laboratory.

## Evidence

Shared SQLite/D1-fixture tests cover all six methods, pre-crypto denial, malformed
and invalid signatures, new keys/instances, exact retries, byte/work caps, separate
close/recovery lanes, configuration pinning, clock rollback/rollover, corruption,
shared poisoning, oversize output, restarts and uncertain/late acknowledgments.
Independent Node processes test shared allowance races and exit immediately after
charge commit, before protected admission. Children receive signed public inputs,
not private signing keys.

Native Miniflare/workerd tests additionally exercise the actual primary D1 batch,
cross-instance races, whole-runtime restart without reseeding, clock rollback and
rollover, wrong configuration, missing authority, lost/late acknowledgments and
encrypted packet reads followed by close/receipt
recovery after ordinary/read exhaustion. These are local fixtures, not production
D1 evidence, a security audit or a delivered private-room service. The edge bundle
remains Node-free and does not import SQLite or Noise.

#328 adds deterministic same-snapshot collisions with both spare and exhausted
allowance, different-lane contention, the three-attempt ceiling, configuration
change/deletion, window rollover and deadline interruption. Native D1 tests force
the collision before two real signed creates and assert exact charges/receipts.
