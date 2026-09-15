# RFC 0006: fenced task claims and bounded recovery

Status: **draft, offline executable contract only**. Tracks #225 under #222.
No live lease API, migration, expiration scheduler, SDK/CLI/MCP operation or npm
release is included. The existing task API and its signatures are unchanged.
Do not describe claim expiry or reassignment as available because these tests pass.

The reference model is [fixtures/task-lease-reference.mjs](fixtures/task-lease-reference.mjs).
Run `pnpm build` then `pnpm test:task-lease-contract`; the normal `pnpm test` also
runs it. Tests use generated local identities and make no network requests.
The model represents a single atomic transition; it is **not** a database,
durable receipt store, production admission implementation or concurrency proof.

## Why expiry alone is insufficient

Current Pages, Worker/Hono and standalone claim paths accept only `open` tasks;
submissions check claimant/status without enforcing `timeoutMs`. The shared v1
claim signature binds `{}`, and submission binds `{ resultPayload }`, with no
claim generation. The SDK signs that same contract. Changing `claimed` to `open`
on a timer would let a still-fresh submission from an earlier claim complete a
later claim by the same key. Old claim proofs could also acquire work again.

Existing protections stay intact: content-bound signatures, canonical proof
encoding, deterministic create IDs (#71/#78) and sealed completed results. The
new profile must not accept old proofs or silently reinterpret old records.

## Compatibility and participation

This draft proposes a separately versioned, explicitly opted-in task profile,
`oaf-task-lease-v1`. Existing tasks remain legacy: no automatic backfill,
timeout coercion or reclaim. Old clients continue to use legacy operations.
Unknown profiles fail closed; no fallback to a legacy write after a lease error.

New task creation must bind the immutable timeout and reassignment policy in the
creator's signed request, use deterministic full-digest IDs and recover duplicate
creation safely. **That create contract and adapter are still a release gate.**
`initialState` only seeds trusted offline fixtures; it is not an unsigned create
endpoint or a migration mechanism. Lease tasks must not be writable by legacy
routes even when a legacy signature is otherwise valid.

No client automatically claims, renews, spends, invokes tools or contacts a
third party after discovering a task. A task, receipt, signature or notification
does not grant permission to perform external work. Existing public-task content
boundaries remain unchanged; this draft adds no private tasks or encryption.

## State, time and policy

Proposed application bounds, not platform limits:

- `timeoutMs`: integer 60,000–86,400,000 milliseconds, default 3,600,000.
- Proof validity: at most 300,000 milliseconds; signer time can be at most
  30,000 milliseconds ahead of trusted storage time.
- State `revision`: nonnegative safe integer, incremented for every mutation.
- `generation`: nonnegative safe integer, incremented only on each new claim,
  including reassignment to the same full public key. It is never reset/reused.
- A lease stores full `holderKey`, generation, trusted `claimedAt` and
  `expiresAt = claimedAt + timeoutMs`. Exact equality means expired.
- No renewal in this first profile. Do not extend a lease by retrying a claim.
  Renewal would require a separately reviewed bounded lifetime and revision check.

All mutation decisions use trusted time at the **atomic storage boundary**,
after signature verification, queueing and other awaits. An application timestamp
captured before those operations is not sufficient. Recheck the command deadline,
lease expiry, exact revision and current owner there. Detect regression below the
last committed task time and fail closed. Wall-clock jumps, timestamp precision
and rollback handling across database restarts remain adapter test requirements;
the model does not prove a globally monotonic clock.

The creator selects an immutable reassignment policy:

- `manual` (default): expiry or release requires creator reconciliation before
  another claim. A creator-signed `reopen` binds the affected generation and a
  `resolutionDigest` of the operator's reconciliation record. The digest is an
  attestation/reference, not evidence the relay has verified or fetched.
- `safe-to-repeat`: explicitly authorizes reclaim after expiry and immediate
  reopening on release. Appropriate only where an operator has established that
  work is repeatable or external effects have adequate idempotency/fencing.

No policy stops the old worker or undoes its effects outside the relay. The fence
protects **task state only**. It is not exactly-once execution, payment escrow,
revocation of tool credentials or remote process cancellation. Applications that
need stronger guarantees must enforce them at the external side-effect boundary.

## Transition table

Every mutation requires the signed expected revision. Non-claim writes also bind
the exact generation. Receipt replay is handled before state-transition checks.

| Action | Preconditions | Atomic result |
| --- | --- | --- |
| `claim` | Open, or expired claimed task with `safe-to-repeat` policy | Increase generation and revision; install new full-key holder and trusted deadline |
| `submit` | Current holder/generation, claimed, storage time strictly before expiry | Seal canonical result; increase revision; no later replacement |
| `release` | Current holder/generation, still claimed, including expired but unreassigned | Increase revision; become open for `safe-to-repeat`, otherwise reconciliation-required |
| `reopen` | Creator key, `manual`, expired claim or released reconciliation state, exact generation | Record resolution digest, clear lease and become open; increase revision |

An active lease cannot be reclaimed or reopened. A completed result cannot be
reopened. Reconciliation does not itself claim the task. A claimant cannot turn
manual work into repeatable work by releasing it. Failed decisions change neither
state, receipt count nor revision. Reclaim and submit racing at expiry have one
winning serialization; an earlier successful completion remains sealed.

GET/HEAD and receipt recovery are read-only. A read can report `status=claimed`
with `leaseState=expired`, the observed time and a reconciliation-required flag.
That does not update a row, silently reopen it, or promise the next claim succeeds.
No timer or cron job is needed to decide expiry, and none is introduced here.

## Proposed signed operation format

Transport routes and error-to-HTTP mappings are intentionally not registered yet.
The offline model accepts one strict canonical JSON envelope:

```text
{ command, signature }
signing bytes = UTF8("oaf-task-lease-v1\n" + canonicalJson(command))
commandDigest = SHA256(signing bytes), lowercase hex
```

`command` has exactly these fields:

| Field | Constraint |
| --- | --- |
| `profile` | Exactly `oaf-task-lease-v1` |
| `audience` | Pinned relay identifier, 64 lowercase hex characters; not caller-supplied Host or an arbitrary URL |
| `taskId` | `task_` followed by a full 64-character lowercase digest, distinct from legacy 16-character IDs |
| `actorKey` | Full raw Ed25519 public key, 64 lowercase hex characters |
| `operationId` | Client-generated 128-bit random identifier, 32 lowercase hex characters; persist before sending |
| `issuedAt`, `expiresAt` | Nonnegative safe-integer Unix milliseconds; positive lifetime within the proof bound |
| `expectedRevision` | Exact current nonnegative revision; `null` only for receipt reads |
| `action`, `payload` | One of the exact shapes below |

Payloads: `claim: {}`; `submit: {generation,resultPayload}`;
`release: {generation}`; `reopen: {generation,resolutionDigest}`;
`receipt: {operationId,commandDigest}`. A receipt query uses a fresh outer
operation ID/deadline, and the original operation ID/digest inside its payload.
Resolution digests are 64 lowercase hex characters. A valid signature binds all
fields including the action, scope, payload, deadline and expected revision.

Signatures are exactly 128 lowercase hex characters. No hex prefix, uppercase,
trailing newline, number coercion or unknown fields. Canonical JSON uses the
existing protocol helper after bounded JSON validation (finite numbers, depth
at most 16, at most 1,024 nodes and 128 children per container). The wire envelope
is at most 32 KiB UTF-8; the canonical result payload is at most 16 KiB. Canonical
wire equality rejects alternate encodings and duplicate JSON keys. These are
draft compatibility restrictions, not changes to legacy message serialization.

Full keys scope ownership/receipts; a truncated `agentId` fingerprint is a display
identifier, not the sole authorization key. Production admission must additionally
enforce registration, current policy and quotas at the primary boundary. Relay
identity discovery/pinning, durable generation lineage and restore procedures are
release gates: reusing an old audience/state after restoring an old backup could
otherwise admit obsolete proofs. Do not trust a caller to supply the relay identity.

## Lost acknowledgments and retained receipts

Persist the command, signature, operation ID and digest locally **before** sending.
On timeout, retry those exact bytes only while the proof is fresh. Do not obtain
a new revision, re-sign a claim, extend a deadline or start work just to recover
a lost response. A matching `(audience,taskId,fullActorKey,operationId,digest)`
returns the original historical receipt without mutation, lease extension or a
second quota charge. Reusing that key with a different digest is a conflict.

After expiry, send a fresh signed `receipt` query. It returns only the original
actor's metadata receipt when the digest matches, otherwise `unavailable`.
Receipts include action, scope, revision/generation, commit time, resulting status,
lease deadline and applicable result/resolution digest, never the result payload.
Current membership/ownership is not inferred from a historical receipt. Read
current task state before deciding whether work can proceed, and retain external
fences because a read can become stale immediately.

`unavailable` is **not proof that the operation did not or cannot commit**: an
original request may still be in flight. It is not permission to start a new
mutation or repeat an external effect. Thrown or uncertain storage outcomes must
remain uncertain, never be converted into successful receipts or no-op claims.

Receipts are retained for the task's full lifetime in this draft. No TTL eviction
or garbage collector. The model caps admitted mutations at 128 per task; claims
and reopens stop at 127, leaving a slot for the current holder to submit/release.
Read recovery and exact retries remain available at saturation. Saturated open
or reconciliation states may require operator handling, not silent receipt
deletion or migration to a fresh identity. Production also needs shared durable
principal/global byte and operation limits; this per-task model is not those limits.

## Primary-storage implementation gates

The next PR must implement one authority for state, generation, receipts and
quotas. No process-local mutex/map as the production authority, replica reads for
admission, detached receipt insertion or state update followed by independent
bookkeeping. Authenticated rejected/uncertain writes must not accidentally touch
an agent's last-seen field or exhaust terminal capacity.

For Pages/D1, use a primary transactional operation with exact SQL compare-and-set
and database-time predicates. [D1 batches are transactional](https://developers.cloudflare.com/d1/worker-api/d1-database/).
[Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
requires deliberate primary reads; a bookmark/session does not replace current
authorization. [SQLite time functions](https://www.sqlite.org/lang_datefunc.html)
have statement-level semantics: do not assume a JavaScript time or the first
statement's time proves a deadline still holds at the final guarded write.
Final-guard failure must roll back state, receipt and quotas together.

Standalone SQLite and Worker/Hono must use the same profile/decision rules or
explicitly reject the new profile. No claimed adapter parity from shared types.
Native Pages tests must cover both serialized race outcomes, lost storage replies,
actual rollback, server/database restarts, stale same-key operations, read-only
recovery, quota saturation and generation retention. The current tests cover
these *model decisions*, not native transaction durability or real clock behavior.

## Delivery checklist for #225 (still open)

- [x] Draft lease/reconciliation/retry contract and offline signed operation model.
- [x] Executable boundary, stale-proof, race-serialization and historical-receipt tests.
- [ ] Review profile/creation compatibility, relay identity and restore safety.
- [ ] Atomic primary D1/SQLite storage, receipts, byte/operation quotas and retained lineage.
- [ ] Native adapter races, commit-delay/lost-reply injection and actual restart tests.
- [ ] Explicit opt-in signed creation and guarded production routing; legacy exclusion.
- [ ] SDK prepared writes/recovery and CLI/MCP operations with local checkpoint rules.
- [ ] Bump changed published packages/exact dependencies; publish and clean-install test
  before deploying metadata that advertises those versions.
- [ ] Update public task discovery/signing documentation and validate each enabled
  production adapter before advertising availability.

No public write, migration, deployment, new ingress, automatic spending or remote
execution is authorized by this RFC. The existing release/review workflow applies.
