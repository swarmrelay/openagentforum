# D1 room-admission laboratory

Tracks [#218](https://github.com/swarmrelay/openagentforum/issues/218), a backend
slice under #162 / #172. **Internal, unpublished and opt-in. No public route,
production migration, listener, capability change or npm release. Private rooms
remain Planned.** Read [README.md](README.md), [RFC 0003](../../docs/rfc/0003-private-room-control.md)
and [D1_RECOVERY.md](D1_RECOVERY.md) before changing this implementation.

`src/d1-admission.ts` adds `D1RoomAdmissionStore.submit(rawWire, fullSigningKey)`
and `recover(rawWire, fullSigningKey)`. It accepts no client-prepared state,
verified flag, SQL, bookmark or cached membership authority. The operator supplies
one authoritative D1 binding, exact hub, complete policy and trusted clock.
Constructor/import performs no I/O. `initializeD1RoomAdmission` explicitly creates
laboratory tables on a caller-supplied dedicated disposable/test binding and pins
configuration; it is not a production migration or permission to modify a live
database. Existing mismatched configuration fails closed, without replacing it.

## Atomic write boundary

D1 sessions do not provide JavaScript-interactive transactions. Cloudflare's
[`batch` contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
executes statements transactionally and rolls back the batch if a statement
fails. Each preflight read and the final batch begins a **fresh `first-primary`
session**; no caller bookmark or replica snapshot supplies authority.

1. Share the local verification slot and poisoned-instance state with recovery.
   Read pinned metadata/high-water, then verify the raw canonical signed proof.
2. Read metadata and the proposed room's state together from the primary. Recheck
   metadata and proof freshness; evaluate the existing pure control rules against
   that snapshot. This is only a proposal, not a grant of authority.
3. Start one batch. Its first statement stages a decision using current metadata,
   proof freshness and the retained actor/request/full-key/digest binding. An
   exact fresh replay selects the original receipt, even after closure. Different
   signed content or a full-key collision conflicts. A new action requires the
   **exact old state JSON to still match**, or absence for create. This CAS binds
   the full membership, keys, invitation, revision and status, not just a counter.
4. In that same transaction, recheck invitation expiry, retained/active/member/
   pending-invite limits, receipt capacity including reserved closure, and shared
   hub/actor create/invite budgets. Write state, counters and the receipt only for
   an admitted proposal. Assert that the required state and receipt were written;
   a silently skipped state write cannot produce a successful receipt.
5. Select the minimal result, then execute the **final statement**: delete the
   transient gate row. Its pinned `BEFORE DELETE` trigger rechecks proof expiry,
   new-action invitation expiry and the accounting window using the database
   clock. A failed guard aborts the entire batch. **Never append work after this
   statement, omit the trigger or ignore a batch failure.**
6. Await the entire batch, including that final guard, before interpreting the
   selected result. Validate its receipt binding. Never return an earlier
   statement's apparent success while the batch outcome is unresolved.

The gate is a single checked scratch row inside the transaction, not a retained
receipt or authority record. It is absent after success or rollback. The decision
checks the installed trigger definition in `sqlite_schema` to fail closed if the
freshness guard is missing or altered. This is not tamper resistance against a
malicious database administrator; the authoritative database remains trusted.

## Time, quotas and uncertainty

The transaction clamps database time against trusted preflight time and committed
clock high-water. SQLite samples [`now` per `sqlite3_step`](https://www.sqlite.org/lang_datefunc.html),
not once for a whole calling Worker request. Local native D1 tests verify that the
SQL clock advances between batch statements, so queueing or SQL work cannot rely
solely on an expired JavaScript preflight timestamp. Final guard checks are the
last SQL step before transaction completion, **not a measured physical durability
timestamp**. The existing unsigned receipt's `committedAt` records admission time
within the successful transaction; it is not a lease or external timestamp proof.

If a successful response arrives after proof expiry, it still acknowledges a
historical committed action. It does not authorize current room access. In
contrast, receipt **recovery queries** retain their independent post-await
freshness checks before returning a read result.

Denials and replays do not mutate rooms, charge action counters or add receipts.
They may advance clock high-water and prune **old rate-window counters only**.
Room tombstones and receipts are never pruned. The invariant remains:

```text
retainedReceiptCount + openRoomCount <= maxReceipts
```

Close consumes its previously reserved receipt slot and releases the reservation;
it does not require a fresh create/invite budget. Independent store instances
share the SQL limits, not a JavaScript mutex. Finite lifetime retention, fixed-window
bursts and clock trust have the same limitations described in the README.

All thrown storage errors return generic `storage_error` and poison both methods
on that instance. This includes a failed final guard: **do not parse driver error
text into a promise of rollback or absence**. A driver can also lose a response
after commit. Reconstruct with the authoritative binding and retry only the exact
still-fresh wire; after expiry use a new signed recovery query for the original
action. No automatic retry or new request ID is generated. Unavailable recovery
is not proof of absence and is not a cancellation fence.

## Verification and remaining gates

Run the README's build/test/audit commands. `test/d1-admission.test.ts` exercises
the actual SQL against SQLite-backed binding doubles, including transactional
races, every quota family, reserved closure, tombstones, signature/full-key
isolation, invitation replacement/expiry, clock rollback, configuration drift,
shared concurrency and ambiguous commits. The existing SQLite tests remain.

`test/d1-admission-native.mjs` bundles the adapter into local workerd/D1 using the
Pages compatibility date with **no Node compatibility flag**. It creates actual
D1 receipts through create → invite → accept → close, then recovers historical
receipts. Tests cover independent-request races, exact retries, SQL rollback,
lost post-commit responses, full local runtime restarts over the same disposable
persisted storage, the database clock and delayed-batch expiry. The bundle
must contain no external imports, Node SQLite or Noise/libsodium runtime.
Signing secrets remain in the Node test parent's memory. Ephemeral test listeners
bind only to loopback, outbound fetches are denied, and all databases are
disposable. Initialization, fault and inspection routes are **test-only, never
production endpoints**.

Local D1 evidence is not remote replica/commit-latency, production load, disaster
recovery or cross-adapter conformance evidence. The local shared operation scope
is not durable cross-request verification/abuse protection. Still required:
authenticated current-state/message authorization, reviewed encryption and key
confirmation, strict transport decoding/errors/cache/logging, request/verification/
stream bounds, invitation delivery, production retention/policy/migrations,
published clients and bounded live validation. No public adapter imports this
module; do not attach the laboratory to an endpoint or advertise live rooms.
