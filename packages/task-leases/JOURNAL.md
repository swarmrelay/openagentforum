# Internal durable task-client journal

`src/sqlite-journal.ts` implements `TaskLeaseOperationJournal` for the existing
`JournaledTaskLeaseClient`. This private package remains source-only and unmounted;
the journal has no signer, network transport, scheduler, task executor or key store.
It does not change the public task API or establish production custody.

The caller supplies a dedicated private SQLite connection outside the checkout,
on a maintained runtime accepted by the shared WAL guard. Before explicit
provisioning, configure WAL, FULL synchronization, foreign keys, enabled CHECK
constraints and a busy timeout no greater than one second. Keep the containing
directory 0700 and database/sidecars private; this API does not open files, manage
permissions or defend against the same OS user. Task descriptions, submitted
results and signed wires are retained as plaintext. The caller owns close/backup.

`provisionTaskLeaseJournal` accepts only an empty dedicated database. The
constructor validates the exact schema and independently supplied HTTPS origin,
audience, generation, policy revision, full actor key and finite capacity. Neither
construction nor a request provisions, adopts, repairs, migrates or resets state.
Changing a pin fails closed. The API provides no delete, eviction, pruning or
capacity-refund operation; acknowledged records and unused reservations remain.

## Retention and completion capacity

`retain` snapshots and verifies the complete canonical signature and matches the
wire to every scope/operation/task/digest field. One FULL-synchronized transaction
stores the unchanged wire before its promise resolves. Reusing an operation ID
with different bytes is a conflict; exact retention is idempotent, including
after the proof expires. Verification is historical here; the hub rechecks its
own current authority and clocks when asked to act.
A pending operation also blocks a different mutation for that same task in this
actor's journal. Unavailable recovery does not clear that refusal.

The pinned limits permit at most 512 logical operation slots and 32 MiB of
logical retained operation/receipt allocation. Each ordinary record allocates its
actual nested JSON bytes plus a complete 4-KiB receipt. Every claim additionally
reserves one operation slot and 73,728 bytes for one future submission or release,
before the claim can be posted. This covers the maximum nested 32-KiB signed wire
and receipt, including a maximum-size result. These logical limits do not bound
physical database, WAL, filesystem or backup usage.

A submission/release uses only the reservation of an acknowledged local claim
with the same task, full actor key, generation and expected revision. It consumes
that reservation exactly once. Unknown claims must first recover a matching
receipt; a new terminal operation cannot substitute for an uncertain one. A
rejected/expired claim's unused reservation remains allocated. There is no claim
retry, result generation, replacement mutation or automatic local capacity reset.

`acknowledge` accepts only the exact retained operation's correlated receipt and
never overwrites a different prior receipt. Receipt space was allocated before
POST, so acknowledgment does not compete with new operations for capacity. These
receipts remain historical HTTPS hub assertions, not independently signed current
leases or permission to execute external effects.

## Restart and uncertainty

Open the same database with the independently expected pins. `pending()` returns
a bounded, signature-checked historical snapshot; `get(operationId)` returns the
exact operation and any correlated receipt. Neither method contacts the hub.
Concurrent acknowledgment may make a pending snapshot stale; it grants no write
authority. To reconcile, explicitly sign a fresh receipt query for the retained
operation and pass both wires to `JournaledTaskLeaseClient.recover`.

An unavailable recovery keeps the operation pending. Every journal failure has
`permitsReplacementMutation: false`. Thrown or uncertain database/COMMIT outcomes
poison that instance, without parsing driver errors into proof of rollback. A
replacement process may reopen the preserved authoritative database for explicit
recovery; it must not delete or replace it. Verification is single-flight per
instance, and native transactions share capacity across independent connections.

The exact schema/scope pins detect drift, not a complete old backup restored under
the same pins or malicious database administration. Fenced restore, custody,
power-loss/storage guarantees, operational retention policy and production review
remain gates. A historical claim receipt cannot fence an old worker's effects in
an external system.

## Evidence

The journal tests exercise signature/scope/receipt binding, concurrent connections,
capacity before dispatch, reserved maximum-size completion, snapshotting across
verification awaits, lost COMMIT acknowledgment and immutable acknowledgment.
The native D1 HTTP fixture uses this concrete journal in separate Node processes:
one loses a successful hub response, then a replacement recovers after the full
local D1 runtime restarts. Another process exits without closing SQLite after
retention but before POST; the replacement observes the original pending record,
and unavailable recovery creates no task or replacement mutation.

All fixture storage/listeners are temporary and loopback-only. No production
task route, remote database, public task mutation, package publication or completed
#225/#238 admission claim follows from these local tests.
