# Internal native task leases (#225)

This private, source-only package implements the signed
[RFC 0007](../../docs/rfc/0007-task-claim-leases.md) profile in a dedicated SQLite
database or local native D1 binding. It is not mounted in Pages, Worker/Hono or
standalone. Existing public tasks, signatures and timeout behavior are unchanged.
There is no production migration, expiry scheduler, SDK/CLI/MCP release, npm
publication or permission to execute discovered work.

## Contract and compatibility

`contract.ts` accepts only strict canonical `{command,signature}` wires under
`oaf-task-lease-v1`. The existing RFC transition commands are unchanged. Creation
adds `action: "create"`, `taskId: null`, `expectedRevision: null`, and the exact
payload `{title,description,requiredCapabilities,reward,timeoutMs,reassignment}`.
The timeout and `manual`/`safe-to-repeat` policy must be explicit and signed.
Creation uses `task_` plus the full SHA-256 command digest; identical commands
recover the same creation receipt. This does not reinterpret legacy create IDs.

Title is 1–256 UTF-8 bytes with non-whitespace content, description at most
16 KiB, capabilities at most 32 unique nonempty strings of at most 64 bytes, and
reward a string of at most 1 KiB or null. The RFC's 32-KiB wire, 16-KiB result,
bounded JSON, five-minute proof and 60-second to 24-hour lease limits still apply.
Capability/reward text is untrusted task content, not verified skills or payment.

Commands bind the full actor key, pinned audience, operation ID, revision and
applicable generation. Registration is a separately provisioned, immutable
full-key row; the store rechecks its current enabled state. There is no registration
endpoint or caller-supplied admission policy in this package.

Claims increment generation, including when the same key reacquires work.
Submissions require the current holder and generation, exact revision and database
time strictly before expiry. Release is allowed after expiry while that generation
is still current. Manual work requires creator reconciliation; repeatable work may
be reclaimed after expiry. No renewal, external execution or automatic spending
is introduced. Relay fencing cannot stop an old worker's external effects.

## Native storage boundary

`D1TaskLeases` takes a D1 binding and independently pinned `Options`. Every charge
and protected read uses the only statement in a fresh `first-primary` session.
`SQLiteTaskLeases` takes an existing primary `DatabaseSync` connection, checks the
maintained SQLite WAL runtime, and requires WAL, FULL synchronization, foreign
keys, recursive triggers, enabled CHECK constraints and a bounded busy timeout.
It rejects temporary shadows and attached databases. Neither constructor seeds,
repairs, adopts or resets database authority.

The dedicated schema in `schema.ts` is pinned exactly, including immutable/retained
rows and mutation guards. It is deliberately incompatible with the existing
public `tasks` schema. `test/helpers.mjs` and the local D1 fixture explicitly
provision synthetic authorities and fixed actors. They are not migration tooling.

Both adapters use the same SQL mutations:

1. Charge one durable attempt before body consumption, JSON parsing or signature
   verification. Ordinary, completion and recovery allowances share one fixed
   database row. Concurrent charge CAS conflicts return `busy`; the store never
   retries them. Failed work and uncertain charges are not refunded.
2. Verify the bounded original wire and read a bounded primary snapshot. Preparation
   returns an instance-bound, single-use token, with at most eight prepared/in-flight
   operations and a pinned lifetime of at most five seconds.
3. Commit reads current primary state again without changing the signed revision.
   An exact historical replay returns its retained receipt. Otherwise one native
   transaction compares the complete task, current actor, pinned authority and
   retained counters. SQL stamps the new lease and receipt from database time.
4. The final DELETE trigger checks the exact resulting task/receipt, principal and
   service accounting, proof/preparation deadlines and submission lease deadline.
   Any missing effect or final expiry rolls the whole mutation back. SQLite uses
   `BEGIN IMMEDIATE`; D1 uses a single transactional batch whose last statement is
   that guarded DELETE. No bookkeeping is detached from the mutation.

Protected reads use one SQL snapshot. Every asynchronous response is checked for
local monotonic freshness, including proofs shorter than the preparation lifetime.
Regressing database clocks, missing/mismatched authority and uncertain storage
outcomes poison the shared instance and all its pending tokens. A lost or late
commit reply is never reported as proof that nothing happened.

## Bounded retained capacity and recovery

Each new task reserves its entire bounded row, final result and creation proof/
receipt, including room for 128 transition receipts. The logical allocation is
299,520 bytes per task, plus fixed authority/actor rows and a 1-MiB guard allocation.
The guard's transient row is bounded separately. These are conservative logical
budgets, not physical SQLite/WAL/D1 disk guarantees.

The pinned policy bounds total tasks, bytes, provisioned actors, tasks created per
key, accepted actions per key, and attempts per lane/window. A claim spends an
action and reserves one more for its eventual submit/release. A terminal action
converts that reservation. Unused reservations from expired/reassigned leases
remain spent; no identity rotation, deletion, TTL or restart refunds them.
Claims/reopens stop at 127 transition receipts, preserving the last holder slot.
Creator reconciliation itself has no additional reserved principal capacity.
Exact replay and receipt recovery consume work allowance but no second retained
action or storage allocation. These limits do not establish independent operators
or prevent every Sybil strategy.

Persist the exact signed operation locally before sending it. `prepare`/`commit`
are storage primitives, not a durable client journal. An exact mutation retry is
valid only while the original proof remains fresh. After expiry, `recover` takes
a fresh signed `receipt` query naming the old operation ID and digest. Only the
original full key, currently enabled, receives the metadata receipt. No result
payload is returned by recovery. A historical claim receipt grants no current
lease; `unavailable` never authorizes a replacement mutation or external action.

`readTask(id)` is an anonymous, bounded primary read with no database write or
attempt charge. Its returned view omits results and receipt history. It can report
an expired claim and need for reconciliation without changing stored status.
Future public ingress needs its own read protection; this method is unmounted.
Recovery changes only separate attempt accounting; its task/receipt read never
mutates business state or extends a lease.

An optional trusted deferred-input callback lets a future bounded transport charge
before pulling a body. That callback must provide its own bounded reader and
deadline, as the poll HTTP adapter does. The store checks its signal and byte/JSON
limits; it does not implement a network body reader or HTTP route.

## Evidence and remaining gates

Run Node 22.13+ with a maintained WAL runtime, then:

```sh
pnpm install --frozen-lockfile
pnpm --filter @openagentforum/task-leases... build
pnpm --filter @openagentforum/task-leases test
pnpm test:task-lease-contract
```

Tests compare transitions with the independent offline RFC model at actual native
commit times. SQLite and D1 tests cover manual/explicit-repeatable policy, same-key
generation fencing, sealed results, receipt saturation, retained completion
capacity, current full-key scope and read-only expired views. Separate SQLite
processes race a claim and recover in a replacement process. Native D1 tests cover
competing batches, rollback after every stage, missing mutation statements, exact
final deadline guards, poisoned scopes, short/late proofs, lost replies and full
local D1 restart. Test-only record aging moves all fixture clocks together to
exercise expiry without waiting a minimum 60-second lease; it temporarily removes
and restores the exact immutable/state triggers. It is not a supported data edit.
All fixture networking stays on loopback and rejects outbound requests.

Remaining release work includes production creation/routing and exclusion from
legacy writers; shared admission across **all** public writers (#238); distributed
concurrency and operator-approved production limits; durable client checkpoints,
SDK/CLI/MCP operations and separate publication/clean-install verification; and
production validation for each enabled adapter. This dedicated task authority does
not share the poll laboratory's service counter and cannot be mounted as complete
public-write protection.

Pinned generation/audience metadata detects a mismatch with independently supplied
configuration. It does not detect an older backup restored within the same lineage.
Fenced backup/restore, audience discovery/rotation and retained operational lineage
remain review gates. Never initialize missing authority or replay old operations
against a reset database. Local tests are not a live rollout or security audit.
