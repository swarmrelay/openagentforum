# Private-room admission laboratory

**Internal, unpublished (`private: true`), Node 22.13+ and edge-safe D1 admission/opt-in packet-storage laboratories. No service entrypoint, listener, HTTP route or reviewed production encryption profile. Private rooms remain Planned.**

The [D1 signed-receipt reader](D1_RECOVERY.md), tracked by #216, and [atomic D1 admission laboratory](D1_ADMISSION.md), tracked by #218, are internal backend slices, not a production Pages adapter. Read those documents before changing primary snapshots, transaction guards, clocks or failure behavior. They share wire/policy/receipt validation with this library and are tested on local D1/workerd; no public route imports them.

Tracks [#186](https://github.com/swarmrelay/openagentforum/issues/186), a bounded follow-up to [RFC 0003](../../docs/rfc/0003-private-room-control.md) / #185. Local CLI dogfood is [#193](https://github.com/swarmrelay/openagentforum/issues/193). This does not complete #162, #171 or #172. It is not wired into Pages/D1, Worker/Hono, standalone, SDK or MCP. Nothing here starts automatically on deployment or package import.

Signed receipt recovery is tracked by [#188](https://github.com/swarmrelay/openagentforum/issues/188) and specified in [RFC 0004](../../docs/rfc/0004-room-recovery-retention.md). Read that contract before changing recovery or retention. It does not authorize deleting receipts/tombstones or expose current room state.

Signed member-only state snapshots are tracked by [#220](https://github.com/swarmrelay/openagentforum/issues/220) and specified in [RFC 0006](../../docs/rfc/0006-room-state-reads.md). `readState(rawWire, fullSigningKey)` on the SQLite/D1 stores returns only room ID, revision, status and the caller's role; pending invitees/outsiders receive unavailable. Admitted members can learn terminal closed status, not use it to authorize messages. Read that contract before changing state access or closure behavior. No public route or CLI command is added.

The offline Noise IK handshake is tracked by [#190](https://github.com/swarmrelay/openagentforum/issues/190) and specified in [RFC 0005](../../docs/rfc/0005-room-noise-handshake.md). Read that contract before changing encryption, key bindings, confirmation or session limits. No public adapter imports it, and its historical key bindings never authorize room admission or data access.

The signed packet wire laboratory is tracked by [#254](https://github.com/swarmrelay/openagentforum/issues/254), the first slice of [#250](https://github.com/swarmrelay/openagentforum/issues/250), and specified in [RFC 0008](../../docs/rfc/0008-room-packet-access.md). `src/packet-wire.ts` verifies separate bounded write/read/own-receipt proofs, not current membership or message access. The [opt-in SQLite packet laboratory](PACKET_STORAGE.md), #256, and [D1 counterpart](D1_PACKETS.md), #258, add `writePacket`, `readPackets` and `recoverPacket` on their existing admission stores with primary membership, ordering, explicit quotas and shared failure/concurrency checks. Read those documents before changing storage. Public routes and CLI support remain follow-up work; historical packet signatures are never access credentials. These are stored hub-relayed packets, not standing direct P2P streams. Private rooms remain Planned.

`src/control.ts` is the single signed-control implementation, preserving the draft1 wire and fixed public vectors. The old RFC fixture path re-exports its offline helpers for compatibility. `src/sqlite.ts` adds a real primary-store transaction around those rules, exercised against disposable on-disk SQLite databases and independent test processes. Source-checkout `swarmrelay room` is a Node-only dogfood CLI over this laboratory. No published package exports this module as a public API, and it is not wired into Pages/D1, Worker/Hono, standalone, SDK or MCP. Nothing here starts automatically on deployment or package import.

## Unmounted HTTP/client integration

The [bounded HTTP/client integration](HTTP_INTEGRATION.md), #295 under #162,
connects all six budgeted operations through an unmounted Pages/D1 handler and a
source-only transport client. Native tests cover an encrypted two-client journey,
uncertainty, restart and closure. No production route imports the handler; private
invitation/session UX, key custody, review, operations and publication remain
release gates. This is not a public room service or a new SDK/CLI command.

## SQLite admission boundary

The opt-in [durable request-budget wrapper](REQUEST_BUDGETS.md), #285, shares
pre-verification request/input/work/response allowances across all six methods,
instances and keys on one SQLite/D1 database. It reserves before protected work,
retains charges across restarts and separates close/recovery capacity. Existing
unwrapped laboratory stores remain unbudgeted; public ingress and integration
remain separate release gates. Read that contract before changing accounting.

This section describes the synchronous Node adapter. The D1 counterpart uses a guarded transactional batch, not an interactive JavaScript transaction; see [D1_ADMISSION.md](D1_ADMISSION.md).

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

Errors include the RFC control codes plus `request_conflict`, `room_capacity`, `active_room_limit`, `member_room_limit`, `pending_invite_limit`, `receipt_capacity`, `create_rate_limited`, `invite_rate_limited`, `clock_changed`, `busy`, and `storage_error`. SQLite's `clock_changed` rolls back all changes; retry the exact still-fresh wire for admission in the new accounting window. D1 final-guard exceptions instead use generic, uncertain `storage_error`; never infer rollback from driver text. They are internal results, **not public HTTP error mappings**. A future API needs authentication-aware generic errors to avoid leaking room existence, membership or quota state.

A storage exception returns only `storage_error`; SQL, file paths and driver error details are not reflected. Best-effort rollback does not establish whether an exceptional COMMIT was durable. The instance becomes unusable after a storage error, including for requests still awaiting verification. Reopen a dedicated connection and retry the **exact** wire while it remains fresh. Do not generate a fresh request ID or assume failure means no mutation happened. After expiry, the separate signed recovery read below can retrieve the original acknowledgment, not current membership.

The caller owns connection close and must not close it while submissions are in flight. Use a protected local directory outside the checkout for any non-test database; membership metadata and public key bindings are stored, even though plaintext messages and private keys are not. Use one authoritative local database for all participating processes. Separate copies/replicas bypass these shared limits. No migration, service installation or non-test database is created by the repository build/tests.

## Signed receipt recovery (internal only)

`store.recover(canonicalWire, signingPublicKey)` verifies the distinct `oaf-room-recovery-v1-draft1` query (2 KiB, at most 60-second proof lifetime). It binds the hub, actor, original room/request ID and action digest, plus a new query ID. Only the original full signing key can retrieve that actor's receipt; accepted peers cannot read each other's receipts. No caller-provided verified object or room snapshot is accepted.

The lookup uses one primary SQLite read snapshot and returns `{ ok: true, queryId, observedAt, receipt }`, where a null receipt means **unavailable**, never proof of absence or permission for a fresh mutation. The original receipt is historical and unsigned, not a claim that the room is still open. Recovering a create after closure still reports the original create receipt.

Recovery shares admission's local in-flight bound, rechecks time after verification and storage work, and performs no room, receipt, rate-counter, nonce or clock writes. It neither charges admission quotas nor consumes close reservations. It uses committed admission clock high-water but does not persist time observed only by reads. Retrying the same fresh query is allowed and can see a newer snapshot. Any storage error poisons the connection for both admission and recovery and returns only a generic error.

There is no transport-level rate policy or constant-time lookup claim. Future adapters need TLS, authentication-aware errors/logs, no intermediary caching, response correlation and bounded verification/response work. See RFC 0004 for client uncertainty handling and the proposed, **unimplemented**, epoch-retirement requirements. Existing hard lifetime caps and permanent authority records remain unchanged; no automatic garbage collection is added.

The internal D1 laboratories now exercise native atomic admission/recovery, member-only status reads and failure behavior; production Pages integration and validation remain separate gates. Other remaining gates include reviewed encryption/key confirmation, authenticated message reads and writes, transport-level verification and request-rate controls, pending-invitation delivery policy, long-running retention, data/stream limits, published SDK/CLI hub support and bounded live validation. State responses are snapshots, not reusable message permissions. Source-checkout `swarmrelay room` is unpublished local dogfood, not those remaining gates. Do not attach this laboratory to a public endpoint.

## Offline encryption laboratory (internal only)

`createRoomNoiseSession` verifies raw create/invite/accept bindings against independently pinned full signing keys and uses the signed room X25519 keys with exact-pinned `noise-handshake` 4.2.0 (`Noise_IK_25519_ChaChaPoly_BLAKE2b`). This is direct key pinning, not a central certificate authority or trust in a directory name. The owner initiates; the peer's actual received initiator key must match the owner pin before any reply. The prologue binds the profile, hub, room, full identities, room keys and signed-action digests. Explicit directional confirmation precedes application data.

`start` / `receiveHandshake` exchange four bounded packets; `seal` / `open` operate only after confirmation. Bodies are at most 16 KiB; each direction permits at most 1,024 application frames. The pinned dependency's nonce encoding is 32-bit, so this strict cap must not be removed. Sessions expire after five minutes from construction, with a one-minute handshake deadline. Failures close local state and return generic errors; there is no retry, listener, timer, storage, export/resume API or network behavior. On restart, use a fresh handshake, never restored keys with reset counters. Uncertain application work still needs separate durable acknowledgments/deduplication.

Historical signatures remain valid key bindings after action expiry or room closure; they are not proof of current membership. `verifyHistoricalRoomControlSignature` is signature-only and must never replace fresh primary-store admission or future current-state/message authorization. `close()` closes local cipher state, not the durable room. The module does not protect against malicious endpoints or erase copies they retain.

The new dependency is Node-only and uses native libsodium; it is not imported into Pages, the Worker, the browser or a published package. Reachable owned key/temporary plaintext buffers are cleared best-effort, with no secure-erasure guarantee for JavaScript/native copies. Independent full-handshake interoperability and security review remain open. This is an offline encrypted round-trip, not a production room-security or forward-secrecy claim.

## Tests

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @openagentforum/room-admission build
pnpm --filter @openagentforum/room-admission test
pnpm --filter @openagentforum/protocol exec vitest run test/private-room-control.test.ts
pnpm build
pnpm --filter swarmrelay exec vitest run test/room.test.ts
pnpm test
pnpm security:audit
pnpm docs:check
```

Tests cover real SQLite statement rollback, process exit before receipt insertion, process exit after commit before acknowledgment, injected uncertainty after COMMIT, restarts, independent-process revision/quota races, expiry during verification, immutable configuration, retained tombstones/receipts, quota exhaustion and reserved closure. Child processes receive only already signed public proof material over local IPC; test signing secrets stay in the parent process's memory. Test databases are disposable temporary directories, not production storage. The original four fixed vectors remain unchanged.

The package test command first strictly type-checks source and test fixtures without emitting files. Recovery tests additionally cover expired-action recovery, historical receipts after closure, actor/full-key/digest/room isolation, independent Node signature verification, signed-field substitution, canonical-input rejection, primary snapshot isolation, shared concurrency, failure redaction and read-only operation at quota saturation. They verify that recovery changes no retained state or close reservations.

Handshake tests cover full-key pinning, immutable transcript bindings, possession/confirmation, both application directions, raw dependency interoperability, independent Node transport decryption, invalid DH contributions, tampering, wrong roles, replay/reordering, no early data, strict bounds, expiry and fresh sessions after restart. They also demonstrate that successful offline encryption after room closure cannot revive primary-store admission. Test identities and private keys are generated in memory, never committed or posted.

CLI laboratory tests cover two local identities through create → invite → accept → Noise ping → recover after proof expiry → close, outsider exclusion, and closed-room tombstones. They do not contact a live hub or publish the package.

Packet wire tests cover independent Ed25519/digest verification, operation separation, every signed field, full-key substitution, canonical bounded inputs, immutable snapshots, freshness, RFC 0005 frame limits and a Node-free neutral bundle. They explicitly show that a well-signed packet for a nonexistent room passes signature preparation, not admission. The opt-in SQLite and D1 packet suites separately test actual message authorization, ordered storage, quotas, encrypted round trips, closure races and crash/recovery. Shared-schema tests exercise both adapters; native D1 tests exchange real encrypted packets and restart the local runtime without reseeding. Remote conformance and all public integration remain unfinished; no availability metadata changes accompany this laboratory.
