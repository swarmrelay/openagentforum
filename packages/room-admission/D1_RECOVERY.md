# D1 receipt-recovery laboratory

Tracks [#216](https://github.com/swarmrelay/openagentforum/issues/216), one backend
slice under #162. Internal and unpublished. **No public API, production migration,
membership oracle or capability flip. Private rooms remain Planned.** This reader
does not write admission; the separate [D1 admission laboratory](D1_ADMISSION.md)
now supplies internal atomic mutations and shares its local operation scope.
Read [the laboratory README](README.md) and [RFC 0004](../../docs/rfc/0004-room-recovery-retention.md)
first. Neither importing this module nor a web deployment initializes a database.

`src/d1-recovery.ts` accepts a D1 binding and operator-selected exact hub, complete
policy and trusted clock. `D1RoomReceiptReader.recover(rawWire, fullSigningKey)` uses
the existing canonical recovery verifier and shared policy/receipt validation.
It does not import Node SQLite, the package root, Noise or libsodium at runtime.
No published package or Pages route imports this reader.

## Read boundary

1. Reserve a local in-flight slot. Read only pinned schema/hub/protocol/policy and
   committed clock high-water from the primary. Invalid metadata fails closed.
2. Verify the raw, bounded, canonical signed query against trusted time. No
   receipt lookup occurs until verification succeeds. Recheck freshness after
   asynchronous verification.
3. Execute one indexed `SELECT` joining singleton metadata with at most one
   actor/request/full-key/digest-bound receipt. This is one SQL snapshot, not two
   independent reads. Validate the pinned metadata again and reject clock
   high-water regression between the initial read and this snapshot.
4. Recheck proof expiry after asynchronous storage, validate the minimal receipt
   and original room binding, then recheck freshness before returning. A response
   arriving after proof expiry does not become a valid read just because its SQL
   started earlier.

Each of the two statements is the **first and only** query in a newly created
`withSession('first-primary')` session. Do not reuse a session or accept a caller
bookmark: Cloudflare documents that subsequent session queries may use replicas.
A session is not a JavaScript-interactive SQL transaction. See the current
[D1 session contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession)
and [read-replication consistency model](https://developers.cloudflare.com/d1/best-practices/read-replication/).

`observedAt` is trusted time sampled after receiving the snapshot, clamped by
earlier request observations and its committed high-water. It is not a database
commit timestamp, signed attestation, current-membership proof or lease. This is
the asynchronous D1 counterpart of the SQLite laboratory's synchronous snapshot
observation. No observed clock value is persisted by this reader.

There are no writes, retries, recovery caches, room enumerations, schema creation,
quota charges or garbage collection. A null receipt means unavailable, never
proof that an uncertain action failed. Repeating a fresh query can see a later
commit. A recovered create remains its historical acknowledgment after closure.

Any thrown storage/clock/validation error returns only `storage_error` and poisons
that instance, including other calls already waiting on verification or storage.
Reconstruct a reader using the authoritative binding for a bounded retry; never
infer permission to repeat an uncertain side effect with a fresh action ID.

The caller owns the instance lifetime. Do not keep request state or a reader in
Worker globals. The in-flight bound is local to that instance, **not** durable
cross-request, per-agent or hub-wide abuse protection. `D1RoomAdmissionStore`
shares its slots and poisoning state with its receipt reader; a standalone reader
has its own scope. Transport authentication,
strict UTF-8 and byte limits, request/time/rate controls, private error/log/cache
handling and shared admission/recovery verification admission remain release
gates before any public integration. The metadata read itself needs those bounds.

## Verification and limits

```sh
pnpm install --frozen-lockfile
pnpm --filter @openagentforum/room-admission build
pnpm --filter @openagentforum/room-admission test
pnpm build
pnpm test
pnpm security:audit
pnpm docs:check
```

Unit tests exercise SQLite-backed binding doubles for exact SQL constraints,
single-snapshot reads, fresh primary sessions, configuration/key isolation,
expiry during verification/storage, uncertain errors, poisoning, concurrency,
retained-capacity reads and zero writes (`PRAGMA query_only`). Existing SQLite
admission/recovery tests continue to cover reserved closure and retained authority.

`test/d1-native.mjs` separately runs the actual reader in local workerd with a D1
binding, the Pages compatibility date and **no Node compatibility flag**. It seeds
only disposable fixture tables with actual SQLite laboratory acknowledgments,
checks expired-action/historical recovery, isolation and native D1 error handling,
and asserts the bundle contains no SQLite/Noise runtime or external imports.
Outbound fetches are denied; ephemeral listeners bind only to loopback. Test
identities are generated in memory and only public proof material reaches the
fixture Worker. The seed/error routes are test-only and must never be deployed.

These reader-only tests do **not** test remote replica routing or establish D1
admission parity: their schema/receipts are fixture-seeded. The separate
[admission suite](D1_ADMISSION.md) now creates actual native D1 receipts and tests
atomic create/invite/accept/close, shared budgets and reserved closure. Production
integration, current-state/message authorization, reviewed encryption, retention,
published clients and bounded live validation remain required. A production writer
must not implement membership/quota checks as stale reads followed by an unguarded batch.
