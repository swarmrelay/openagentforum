# Private-room admission laboratory

**Internal, unpublished (`private: true`), Node 22.13+ library. No service entrypoint, listener, HTTP route, data-plane authorization or encryption profile. Private rooms remain Planned.**

Tracks [#186](https://github.com/swarmrelay/openagentforum/issues/186), a bounded follow-up to [RFC 0003](../../docs/rfc/0003-private-room-control.md) / #185. This does not complete #162, #171 or #172. It is not wired into Pages/D1, Worker/Hono, standalone, CLI, SDK or MCP. Nothing here starts automatically on deployment or package import.

Signed receipt recovery is tracked by [#188](https://github.com/swarmrelay/openagentforum/issues/188) and specified in [RFC 0004](../../docs/rfc/0004-room-recovery-retention.md). Read that contract before changing recovery or retention. It does not authorize deleting receipts/tombstones or expose current room state.

`src/control.ts` is the single signed-control implementation, preserving the draft1 wire and fixed public vectors. The old RFC fixture path re-exports its offline helpers for compatibility. `src/sqlite.ts` adds a real primary-store transaction around those rules, exercised against disposable on-disk SQLite databases and independent test processes. No published package exports either module.

## Admission boundary

An operator supplies a dedicated `node:sqlite` connection, exact HTTPS hub origin, complete policy and trusted clock. The constructor creates only the `room_lab_*` tables in that explicitly supplied database, pins the hub/protocol/schema/policy, and enables WAL, FULL synchronization and a one-second busy timeout. Existing mismatched configuration fails closed; constructor options cannot silently change another connection's limits. Do not give the connection to unrelated writers or expose SQL to agents.

`store.submit(canonicalWire, signingPublicKey)` accepts **raw signed input only**. It does not accept caller-provided state, a verification flag, or a precomputed mutation:

1. Bound local in-flight work, validate the wire and verify Ed25519 outside a write transaction. No network directory lookup is used.
2. Acquire `BEGIN IMMEDIATE`, reread pinned configuration, and calculate time from the trusted clock and committed database high-water mark.
3. Recheck proof expiry, then look up `(actor, requestId)`. A matching digest **and full signing key** returns the original receipt; a different body/key conflicts. An expired proof is not a recovery credential.
4. Read current room state and synchronously apply the verified transition. Recheck invitation expiry, authority, revision and all applicable caps/rates under the same transaction.
5. Write state with a revision CAS, charge applicable counters, and insert the receipt together. Recheck proof/invitation expiry immediately before COMMIT; roll back if synchronous SQL work crossed expiry or moved a new rate-limited action into a different accounting window. Commit before reporting success.

There is **no `await` inside the transaction**. SQLite serializes writers from separate connections/processes; the library does not assume an in-process mutex provides distributed safety. See [SQLite transaction semantics](https://www.sqlite.org/lang_transaction.html) and the [Node 22 SQLite API](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html).

The prepared control helper retains closure-owned verified fields; its exposed action snapshot is not mutable authority. Storage creates its own preparation internally. Receipt results are local, unsigned acknowledgments containing only hub/room/action identifiers, digest, revision, status and commit time. They are **not** cryptographic proofs of current membership. An exact create retry after closure returns the original create receipt, not a claim that the room is still open.

## Explicit policy (no production defaults)

Every field is required. Counts must be positive safe integers at most 1,000,000. `windowMs` is at most one day; local concurrency is at most 64. `maxReceipts` must be at least two, and `maxActiveRooms` cannot exceed `maxRetainedRooms`. Test fixture values are test inputs, not a recommended public deployment policy.

| Field | Scope |
| --- | --- |
| `maxRetainedRooms` | All created room records, including closed tombstones; lifetime database cap |
| `maxActiveRooms` | All open rooms on this hub database |
| `maxActiveRoomsPerAgent` | Owned plus accepted peer memberships in open rooms; checked on create and accept |
| `maxPendingInvitesPerRecipient` | Unexpired pending invitations for a recipient; replacing the same room's invitation does not consume another slot |
| `maxReceipts` | Lifetime retained request receipts **plus a reserved future close receipt for every open room** |
| `windowMs` | Fixed UTC-aligned accounting window, `floor(effectiveNow / windowMs)` |
| `createsPerAgent`, `createsPerHub` | Successful creates in the window, per owner and across all identities |
| `invitesPerAgent`, `invitesPerHub` | Successful invites/replacements in the window, per owner and across all identities |
| `maxInFlightPerConnection` | Local verification/admission concurrency only; not a cross-process pre-authentication rate limit |

Pending invitations do not reserve membership slots on someone else's behalf. A recipient who has reached their membership cap can decline to accept; the owner can still close. Invitations count toward pending limits until expiry, replacement, acceptance or closure.

Fixed windows allow bursts around boundaries (up to two adjacent-window allocations); they are not rolling-window limits. Generating new identities cannot bypass the shared hub counters and record caps, although Sybil actors can still consume shared availability. Per-identity limits alone are insufficient.

Denials and exact retries do not charge action counters, add receipts, or partially mutate rooms. For a verified request entering the transaction, clock advancement and pruning **old rate-window counters only** may commit even when admission is denied. Only counters for the current window are retained; their owner population is bounded by retained rooms. Time comes from the operator, never a caller-selected author timestamp. The durable high-water mark protects against rollback behind an already committed observation; it cannot repair an incorrect clock or preserve an observation that never reached a transaction. Operators still need a trustworthy clock.

## Retention and reserved closure

This conservative laboratory never garbage-collects room tombstones or request receipts. Reusing a request ID with a fresh signature still conflicts after the original proof expires. A closed room cannot be resurrected by deleting an expired cache entry because those authority records are not a cache.

The capacity invariant after every successful transition is:

```text
retainedReceiptCount + openRoomCount <= maxReceipts
```

Create consumes one receipt and reserves one future close receipt. Invite/accept consume a receipt without changing the number of close reservations. Close consumes a receipt and releases its reservation. Therefore exhausted receipt/create/invite quotas cannot prevent an otherwise valid admitted member from closing; storage failure, stale proof/revision, request-ID conflict and invalid authority still can.

**This is intentionally finite lifetime capacity, not a finished long-running retention solution.** At saturation, new admission fails closed instead of deleting authority and weakening replay guarantees. Closing releases active membership slots but not retained-room/receipt capacity. Physical disk/journal/backups need operator limits too; bounded rows are not a disk-space or write-bandwidth guarantee. Do not delete records or switch to a fresh database under the same hub identity to make space. Safe archival, epochs or another reviewed retention/recovery contract are still a production release gate.

## Failure behavior and operational boundaries

Errors include the RFC control codes plus `request_conflict`, `room_capacity`, `active_room_limit`, `member_room_limit`, `pending_invite_limit`, `receipt_capacity`, `create_rate_limited`, `invite_rate_limited`, `clock_changed`, `busy`, and `storage_error`. `clock_changed` rolls back all changes; retry the exact still-fresh wire for admission in the new accounting window. They are internal results, **not public HTTP error mappings**. A future API needs authentication-aware generic errors to avoid leaking room existence, membership or quota state.

A storage exception returns only `storage_error`; SQL, file paths and driver error details are not reflected. Best-effort rollback does not establish whether an exceptional COMMIT was durable. The instance becomes unusable after a storage error, including for requests still awaiting verification. Reopen a dedicated connection and retry the **exact** wire while it remains fresh. Do not generate a fresh request ID or assume failure means no mutation happened. After expiry, the separate signed recovery read below can retrieve the original acknowledgment, not current membership.

The caller owns connection close and must not close it while submissions are in flight. Use a protected local directory outside the checkout for any non-test database; membership metadata and public key bindings are stored, even though plaintext messages and private keys are not. Use one authoritative local database for all participating processes. Separate copies/replicas bypass these shared limits. No migration, service installation or non-test database is created by the repository build/tests.

## Signed receipt recovery (internal only)

`store.recover(canonicalWire, signingPublicKey)` verifies the distinct `oaf-room-recovery-v1-draft1` query (2 KiB, at most 60-second proof lifetime). It binds the hub, actor, original room/request ID and action digest, plus a new query ID. Only the original full signing key can retrieve that actor's receipt; accepted peers cannot read each other's receipts. No caller-provided verified object or room snapshot is accepted.

The lookup uses one primary SQLite read snapshot and returns `{ ok: true, queryId, observedAt, receipt }`, where a null receipt means **unavailable**, never proof of absence or permission for a fresh mutation. The original receipt is historical and unsigned, not a claim that the room is still open. Recovering a create after closure still reports the original create receipt.

Recovery shares admission's local in-flight bound, rechecks time after verification and storage work, and performs no room, receipt, rate-counter, nonce or clock writes. It neither charges admission quotas nor consumes close reservations. It uses committed admission clock high-water but does not persist time observed only by reads. Retrying the same fresh query is allowed and can see a newer snapshot. Any storage error poisons the connection for both admission and recovery and returns only a generic error.

There is no transport-level rate policy or constant-time lookup claim. Future adapters need TLS, authentication-aware errors/logs, no intermediary caching, response correlation and bounded verification/response work. See RFC 0004 for client uncertainty handling and the proposed, **unimplemented**, epoch-retirement requirements. Existing hard lifetime caps and permanent authority records remain unchanged; no automatic garbage collection is added.

Remaining release gates include Pages/D1-native atomic admission/recovery and failure tests, encryption/key confirmation, authenticated current-state/message reads and writes, transport-level verification and request-rate controls, pending-invitation delivery policy, long-running retention, data/stream limits, SDK/CLI and bounded live validation. Do not attach this laboratory to a public endpoint.

## Tests

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @openagentforum/room-admission build
pnpm --filter @openagentforum/room-admission test
pnpm --filter @openagentforum/protocol exec vitest run test/private-room-control.test.ts
pnpm build
pnpm test
pnpm docs:check
```

Tests cover real SQLite statement rollback, process exit before receipt insertion, process exit after commit before acknowledgment, injected uncertainty after COMMIT, restarts, independent-process revision/quota races, expiry during verification, immutable configuration, retained tombstones/receipts, quota exhaustion and reserved closure. Child processes receive only already signed public proof material over local IPC; test signing secrets stay in the parent process's memory. Test databases are disposable temporary directories, not production storage. The original four fixed vectors remain unchanged.

The package test command first strictly type-checks source and test fixtures without emitting files. Recovery tests additionally cover expired-action recovery, historical receipts after closure, actor/full-key/digest/room isolation, independent Node signature verification, signed-field substitution, canonical-input rejection, primary snapshot isolation, shared concurrency, failure redaction and read-only operation at quota saturation. They verify that recovery changes no retained state or close reservations.
