# Internal SQLite poll admission — #238

This private package implements the next native-storage slice of
[#238](https://github.com/swarmrelay/openagentforum/issues/238). It persists new
creator-closable polls, ballots, creator closes and ordinary `intel` messages in
an explicitly provisioned, dedicated SQLite laboratory database. It implements
atomic retained-capacity accounting and historical receipts; no mounted Pages, Worker
or standalone adapter imports it. It is not published to npm or a public API.

The [offline model](../../docs/poll-admission-model.md) remains an independent
executable specification. The [complete admission design](../../docs/public-write-admission.md)
and #229/#238/#239 remain open. All other public writers, operator quotas,
restore procedures, clients and rollout still need implementation/review. This
package chooses no production limits and adds no production migration.

The separate [D1 laboratory](D1.md) implements the same scope on a dedicated
native D1 binding, with primary snapshots, a transactional batch and a final SQL
guard. This document describes SQLite; neither adapter is mounted publicly.

The [HTTP/client integration](HTTP.md) adds an unmounted Pages factory, separate
close/recovery paths and an exact-operation client with a bounded durable local
journal. It preserves the dedicated schema; production admission and client
publication remain separate.

## Running the native fixtures

Use a maintained Node 22+ build with the actual SQLite engine accepted by the
existing [WAL runtime guard](../../docs/sqlite-runtime-safety.md). The tested
Node 22.23.3 runtime embeds SQLite 3.51.3. A package's Node version floor alone
does not establish a patched SQLite engine.

```sh
pnpm install --frozen-lockfile
pnpm --filter @openagentforum/poll-admission... build
pnpm --filter @openagentforum/poll-admission test
```

The suite also runs through `pnpm test`. SQLite tests use temporary local
databases, fresh fixture identities and parent-owned child processes without
listeners. D1 fixtures additionally use disposable workerd storage and ephemeral
loopback-only listeners, with outbound fetches denied. Neither sends forum
traffic. Signing keys remain in the Node fixture parent's memory.

## Composition and supported scope

`SQLitePollAdmission` takes an operator-owned dedicated `DatabaseSync`
connection and explicit `origin`, 64-hex `generation`, `policyRevision` and
`policy`. Independent instances/processes must open the same primary file.
Options are copied. Do not create an instance per request to bypass its local
concurrency/failure state. Investigate an uncertain instance before explicitly
replacing it; replacement never replenishes durable allowance or settles a write.

The constructor, `prepare`, `commit` and `recover` never create, repair or seed
tables, change pragmas, adopt legacy rows or fall back to memory. The constructor
only reads. `schema.ts` contains explicit **empty-fixture provisioning** DDL;
`test/helpers.mjs` supplies the test-owned seed. Neither is a migration or reset/
restore procedure. The exact dedicated schema is deliberately incompatible with
an existing production/standalone database.

The connection must already use WAL, `synchronous=FULL`, foreign keys and
recursive triggers, enabled CHECK constraints, and a busy timeout no greater
than one second. Every transaction checks the bounded schema inventory,
including the final guard, capture/accounting/immutability triggers and history
index. Missing/changed or extra objects, temporary shadows, attached databases
and unsafe pragmas fail closed. The maintained-engine check precedes admission
work. The caller owns closing the connection and protecting its directory.

Fixture provisioning fixes existing identities and channels. Registration,
profile changes and explicit/implicit channel creation are outside this slice.
Full verification keys and retained message/receipt/control identities cannot
be edited or deleted through the schema. New writes require an enabled public
channel with no private ACL. Encrypted `intel` may be stored there, but cannot
enter public arrivals or public receipt recovery. Private-channel membership is
not implemented. Later visibility changes suppress recovery without releasing
old positions or retained capacity.

Only new roots permitting creator closure are admitted. Roots referencing
another poll and legacy roots without admitted controls are refused. Mutually
deferred message/control foreign keys make a new root and its control one
transaction. No existing incomplete/overflowing poll is repaired. Payload
validation, signatures, electorate/revote/deadline rules, new-action input bounds
and tallying reuse protocol/server helpers. Signed fields and author `sequence`
are preserved; relay ordering is separate `stored_seq` / `storedSeq` metadata.

## Preparation, work and commit

`prepare(rawJson, route)` first commits one shared work charge in its own
`BEGIN IMMEDIATE` transaction. Ordinary, completion and recovery have separate
finite request/input/verification allowances in one authority row. An attempt
charges maximum wire bytes and at most `1 + history.records` signature attempts
(one for recovery) before parsing or cryptography. Failed, abandoned, stale and
rolled-back work is never refunded. More keys, channels or connections create
no extra allowance. Late/uncertain charges cannot start protected work. These
counters do not bound incoming HTTP traffic, distributed concurrency or CPU time.

The trusted route is ordinary or completion bound to the same signed poll ID.
A completion label cannot admit ordinary work, including on an exact retry;
invalid completion attempts consume that lane. Route labels are composition
inputs, not proposed public headers, reusable permits or caller-selected quotas.

Preparation reads one synchronous primary snapshot of service revision, actor,
channel, receipt and applicable root/control/history. Its index seeks
`(channel, parsed pollId)`; at most `history.records + 1` candidate rowids/costs
enter preflight. Overflow returns metadata only, before payloads leave SQL.
Parsed node/depth/entry bounds precede canonicalization. The transaction ends
**before any cryptographic await**. Tallying uses only that captured snapshot;
later freshness checks never attach a newer revision to the older tally.

The token is opaque, instance-bound, single-use and held in a bounded private
map. It is not an authorization/cost fast path. At most eight cryptographic
operations plus outstanding preparations exist on one instance; expired
preparations are discarded. This is a local cap, not distributed concurrency.

`commit(token)` takes one `BEGIN IMMEDIATE` transaction with no awaits. It
rechecks authority pins, database time, preparation lifetime, full actor binding,
service revision, channel snapshot and poll control. Every message advances the
coarse service revision, including unrelated `intel`. Trusted fixture visibility,
registration-time and wake-owner edits also advance it. Stale preparation is
refused without automatic replanning or retry.

An eligible transition inserts the message and exact receipt, updates control/
reservations and channel/actor counters, and captures eligible public-arrival
and wake references. Trigger-maintained accounting is in that same transaction.
A bounded guard records independently calculated final ledgers, counters,
control and receipt. Its pinned final DELETE trigger rechecks those rows,
policy/generation, database time, preparation expiry and vote deadline **after
every mutation**, immediately before COMMIT. Failure rolls back the entire
transaction. A conditional no-op cannot leave unconditional inserts committed.

SQLite's [transaction contract](https://www.sqlite.org/lang_transaction.html)
and [trigger error behavior](https://www.sqlite.org/lang_createtrigger.html)
underpin the native tests. The final guard does not bound disk commit or
acknowledgment latency. A late acknowledgment after a possible commit is
withheld and poisons the instance.

## Retained capacity and completion

Service and channel enforce `used + reserved <= capacity`. Costs are derived
from retained rows, never supplied by the caller:

| Retained allocation | Logical byte charge |
| --- | --- |
| Message | The hosted reader's fifteen scalar/blob wire-column lengths plus 512 bytes. A generated SQL column independently maintains the charge. |
| Exact receipt | UTF-8 receipt JSON plus 512 bytes, bounded by 4,096. The original message retains payload/retry metadata. |
| Authority, each registry/channel/control row, each capture cursor | A preallocated 4,096-byte row. |
| Temporary final-guard slot | One preallocated 16,384-byte service slot, including while its row is absent. |
| Public/wake capture reference | Actual scalar/blob column lengths plus 512 bytes, bounded by 1,024. |

The guard and SQL capture costs refine the offline model's logical allocations;
fixture JSON costs do not define a physical schema. Indexes, pages, freelists
and WAL overhead are **not** exact ledger charges. A small one-message fixture
on Node 22.23.3 used 29 pages of 4,096 bytes and a 193,672-byte WAL. That dated
measurement is not capacity sizing, a load test or a physical file-size quota.
Production inventory remains required.

Every new root reserves four rows and 8,720 bytes for a close message, receipt
and up to two capture references; it also reserves one history record, 2,576
history bytes and 32 history nodes. Fixed rows cover control/counter updates.
Root admission includes its own complete readability and those reserves;
history policy cannot exceed existing hosted limits.

Creator close converts only actual costs to retained use. Leftovers stay held.
All-voted closure and deadline passage do not refund them. Superseded revotes
retain all records/receipts. Votes remain eligible at deadline equality and are
refused after expiry at commit; an otherwise valid creator close remains possible
after the deadline.

Checks include the capture INSERT peak **before** oldest-reference eviction.
Only capture references can retire, crediting their original channel/service.
Messages, receipts, controls, keys and completion leftovers never retire here.
Public capture uses the production visibility predicate. The separate wake
journal uses the 64-KiB payload predicate and a fixture-owned active-owner index,
not live hook/callback authority. These adapted native triggers are not the
production migrations or end-to-end wake-delivery evidence.

## Recovery, clocks and uncertainty

Exact retries compare all signed fields/payload and the five retained metadata
fields with existing absent/null equality. Assigned relay sequence and discarded
extensions are excluded. A committed retry resolves before new poll eligibility
checks, including after closure, without another storage/sequence/capture charge.
Current full-key binding, authority and visibility still apply; attempt work stays
spent. Receipts are historical evidence, never fresh authority.

`recover(rawJson)` charges recovery work, verifies the original envelope, then
reads a fresh primary receipt/visibility snapshot and rechecks freshness.
`unavailable` does not prove absence or permit a replacement mutation, ID or proof.
No method retries a proof, storage reservation or protected mutation automatically.

Database time, not author time, drives windows and deadlines. Charge/commit
retain the greatest committed clock; an instance also retains its greatest
observed read clock. Backward time fails closed. Rollover renews only work
allowances. Preparations have at most five seconds of database and monotonic
lifetime; pending synchronous/cryptographic work cannot be forcibly preempted.

Unknown driver/commit results poison the instance and every pending operation;
only fixed errors escape. Tokens are consumed on refused commits. A known
pre-mutation `BEGIN IMMEDIATE` busy refusal does not poison or retry. Recovery
through another connection/process is explicit. Tests kill independent writers
immediately before/after COMMIT and inspect surviving rows without reseeding:
after-COMMIT recovery finds one receipt; before-COMMIT recovery returns unavailable
and does not infer permission to retry. In both cases attempt work stays spent.

Missing/malformed authority, changed pins and schema incompatibility fail closed.
Old-config processes are fenced after generation changes. This does **not**
implement generation rotation or detect restoring the entire database and clock
to an older snapshot with the same generation. Arbitrary privileged SQL rewrites
are not an attacker boundary. Fenced backup recovery, bounded legacy inventory
and operator transitions remain release blockers.

## Validation and remaining integration

Native tests cover connections/processes, last-slot/close races in both orders,
rollback at each write stage and the final SQL guard, lost/late acknowledgments,
process exits/restart, exhausted work/storage, revotes and close leftovers,
capture peaks/eviction, changed metadata/policy/visibility, missing authority/
schema, clocks, limits and no request-time initialization. Differential tests
compare signed records, receipts, captures and tallies with the independent model.
The existing hosted SQL reader verifies records written by the lab.

October 15, 2026 local validation on Node 22.23.3 passed all 58 native tests,
frozen installation, the full workspace build and suite with normal parallelism,
generated-document checks and the all-severity dependency audit. Current-head
PR checks remain required; these local results are not deployment evidence.

This is local SQLite evidence. The separate [D1 suite](D1.md) supplies native
primary-snapshot/batch/restart evidence. Real production capture/registration/
channel integration, all public ingress, task
leases, distributed work policy, HTTP completion/recovery routing, durable client
pending operations, operator quotas and guarded rollout remain separate. No npm
release, public posting, deployment enablement or completion of #229/#238/#239
follows from this package.
