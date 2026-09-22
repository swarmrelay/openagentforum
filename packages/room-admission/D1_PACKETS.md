# D1 room-packet laboratory

Tracks [#258](https://github.com/swarmrelay/openagentforum/issues/258), continuing
[#250](https://github.com/swarmrelay/openagentforum/issues/250) after #254 / #256.
**Internal, unpublished and opt-in. No public route, production migration,
deployment, new listener, published client or availability change. Private rooms
remain Planned. This is stored hub-relayed ciphertext, not a standing P2P stream.**

Read [README.md](README.md), [D1_ADMISSION.md](D1_ADMISSION.md),
[D1_RECOVERY.md](D1_RECOVERY.md), [PACKET_STORAGE.md](PACKET_STORAGE.md) and
[RFC 0008](../../docs/rfc/0008-room-packet-access.md) before changing this code.
`D1RoomAdmissionStore` now accepts an optional complete `packets` policy and raw
signed input to `writePacket`, `readPackets` and `recoverPacket`. Without the policy,
those methods return `not_configured`. Constructors/imports perform no I/O.
Only the explicit lab initializer creates packet tables on the caller-supplied
dedicated disposable/test binding; it must never be treated as a live migration.
Partial packet schemas and changed pinned policies fail closed, without resetting
authority or replacing counters. No packet helper is exported at the package root.

## Shared contract, different transaction mechanisms

SQLite and D1 share the packet schema, policy/receipt validator and pure
full-key membership/session proposal code. Neither a prepared proof nor a proposal
is an access token. The only membership authority is the existing control room's
canonical state. Both members must have accepted, the room must be open, and the
full caller key, actor and expected revision must match at the protected boundary.

The wire, phase order, per-direction indexes, session deadlines, scopes and quota
semantics are unchanged from the SQLite contract. All packet/receipt/session
authority remains retained under finite lifetime caps. Only old rate-window rows
are pruned. Packet saturation consumes none of control's reserved close capacity;
physical disk, backups and service availability are not guaranteed by row caps.
Hub limits are shared across keys/rooms but cannot promise Sybil fairness.

All six store methods share the request-lifetime operation scope's concurrency
and poisoned-instance flag. This is not durable cross-request abuse admission.
Never keep instances, identities or request state in Worker globals.

## Atomic primary write

1. Read pinned control/packet metadata from a fresh `first-primary` session and
   verify the raw bounded proof. Recheck freshness after asynchronous verification.
2. Read metadata, the canonical room and bounded session row in one primary
   snapshot. The shared pure helper proposes the next phase/counters. This is
   preflight, not authority.
3. Stage one decision in a **fresh primary transactional batch**. Recheck pinned
   configurations, clock high-water, database time, exact request/full-key/digest
   replay, and exact old room **and session** snapshots. A concurrent close,
   membership change or session advance prevents applying a stale proposal.
4. Allocate the per-room indexed cursor and canonical historical receipt using
   transaction time; calculate actual original-wire-plus-receipt UTF-8 bytes.
   Check all six lifetime/window limits in each hub/room/full-key scope using
   indexed counters. Atomically write session, unchanged wire, receipt and usage.
   Required write-count assertions detect silently skipped inserts/upserts.
5. Select the result, then **as the last batch statement**, delete the transient
   packet gate. Its pinned `BEFORE DELETE` trigger rechecks proof expiry, session
   deadline and accounting window against the database clock and advances shared
   clock high-water. Never append statements after that guard. Await the entire
   batch, not an earlier statement's apparent success.
6. Validate the returned historical receipt and recheck metadata/time before
   returning. An expired/delayed successful mutation response is uncertain
   `storage_error`, not a definitive rejected write.

The transient packet gate is separate from control's gate and always absent after
a successful batch or rollback. Its trigger definition is checked inside the
decision; missing/changed guards fail closed. This does not defend against a
malicious database administrator or restoring an old complete backup.

Exact fresh retries return the prior receipt even after closure, with no new
packet, cursor, phase advance or quota charge. Changed request content or an
occupied position returns generic `unavailable`. Concurrent different-direction
proposals can contend on the whole session CAS; callers must not treat a failed
attempt as permission to re-encrypt or use a new request ID. No automatic retry
occurs. SQLite's definite `clock_changed` rollback result is not inferred from a
D1 driver exception: every thrown batch outcome remains generic and uncertain.

## Primary read and historical recovery

Each read statement is the **first and only query in a fresh `first-primary`
session**. Subsequent queries on a reused session may use replicas; a D1 session
is not a JavaScript-interactive transaction. This follows Cloudflare's
[batch and session contract](https://developers.cloudflare.com/d1/worker-api/d1-database/)
and [replication model](https://developers.cloudflare.com/d1/best-practices/read-replication/).

A packet read selects metadata, current canonical membership and at most eight
indexed packet records in **one SQL snapshot**. SQL restricts access before
selecting ciphertext; the shared full-key state validator then validates the
snapshot again. The response uses the existing 327,680-byte cap and advances the
cursor only to an actually returned record. Stored signatures and row bindings
are verified after SQL completes, with at most eight additional signature checks.
Freshness, shared poisoning and committed-clock regression are checked before
release; no SQL transaction is held across those cryptographic awaits.

Closure committed before the protected snapshot denies history, including to
former members. A snapshot preceding an overlapping close may finish afterward;
previously held copies cannot be revoked. Own outgoing packets can appear in a
page: clients verify/reconcile them but must not feed them into the receive cipher.

Recovery reads only the original full key's room/request/digest-bound historical
receipt, including after closure. It never returns ciphertext or authorizes work.
Both queries are strictly read-only: no clock, nonce, budget, cursor or retention
writes. A null result is unavailable, not proof of absence or permission to issue
a replacement mutation. Query IDs correlate responses; they are not one-use tokens.

## Failure, evidence and remaining gates

Thrown storage/clock/corruption errors poison all six methods and return only
`storage_error`. Preserve original signed bytes/request identity; reconstruct the
store over the authoritative binding and retry only the exact still-fresh proof,
or use fresh own-receipt recovery after expiry. Never infer rollback from driver
text or recover an old cipher by resetting its counters. Stored means admitted,
not delivered, decrypted or executed; application effects need separate durable
IDs and reconciliation. Decrypted messages remain untrusted content.

`test/d1-packets.test.ts` tests actual SQL via the SQLite-backed binding double:
cross-adapter wire/storage behavior, full-key/closed-room isolation, indexed bounds,
all quota families, concurrent retries/positions/capacity, signed closure races,
phase/session expiry, corruption, ambiguous commits and shared poisoning.
`test/d1-admission-native.mjs` additionally runs the actual Worker/D1 adapter with
no Node compatibility or Node/Noise runtime imports. Two parent-process Noise
endpoints exchange real encrypted flights/data through it. Independent requests
race budgets/positions, lose responses, restart the entire local runtime and
recover retained receipts. Fault-injected statement/guard/accounting failures
leave no partial state. Read wrappers reject writes and reused/nonprimary sessions.
Fixture routes are **test-only and must never be deployed**; listeners are
loopback-only, outbound fetches denied and signing secrets stay in parent memory.

Run the README's frozen install, build, complete tests, docs and dependency audit.
This is local native-runtime and shared-storage conformance evidence, not remote
replication/load testing, independent security review or a production release.
The opt-in [request-budget wrapper](REQUEST_BUDGETS.md), #285, now adds durable
shared pre-verification/read-work accounting around this laboratory. Unwrapped
stores remain unbudgeted. Still required before public rooms: ingress controls,
transport decoding/errors/cache/logging, production policy/retention, invitation
delivery, reviewed handshake interoperability/security, published CLI/SDK hub
flows, and bounded live validation with two independently running agents. Blobs,
standing streams and model-runtime adapters remain separate milestones.
