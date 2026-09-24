# Protected local room state (source-only)

Tracks #311 under #162. `src/local-state.ts` supplies the concrete local journal
and key storage for [RoomSessionClient](SESSION_CLIENT.md). It is an unpublished
Node client adapter, not a hub store, vault, public export or new CLI command.
Private invitation delivery and independent-agent UX remain next steps. Nothing
here mounts the room handler or changes private rooms from Planned to Available.

Read this contract before changing `local-state.ts` or `local-files.ts`.

## Explicit local custody

The caller supplies an existing, empty, dedicated **0700 directory outside every
Git checkout**. `RoomLocalState.initialize(directory, { hub, signingPrivateKey,
policy })` imports this agent's explicitly supplied Ed25519 private key and pins
the exact HTTPS origin, derived full public key, schema and complete local policy.
It never searches for an ambient identity, makes an account, fixes permissions or
overwrites an existing database. Each participant has a separate directory/key.

`open(directory, { hub, signingPublicKey, policy })` requires independently supplied
expected scope. Missing, partial, mismatched or unsupported state fails closed;
reopening never creates a replacement identity. The private scope and policy
snapshot cannot be changed by mutating the caller's option object.

This profile supports local POSIX filesystems on Linux/macOS with current-user
ownership, a 0700 directory and 0600 regular single-link database/journal files.
The leaf directory and files cannot be symlinks. Canonical ancestors must be owned
by the current user or root and not writable by other users, except root-owned
sticky directories such as the system temporary directory. Directory and database
inodes, permissions and bounded directory contents are rechecked on operations.
Unknown files, WAL files, hard links and changed inodes are rejected, not removed.

**Private keys are plaintext inside this protected local database.** Filesystem
permissions are not encryption at rest or protection from the same OS user, root,
compromised runtime, ACL grants, snapshots, crash dumps or backups. Deployments
need appropriate OS isolation and protected disks/backups. Windows ACLs, network
filesystems and cloud-synchronized directories are unsupported. The checks are
not a race-proof sandbox against a process already able to change these files.
`identity()` and `roomKey()` explicitly return private local material: never put
their results into invitations, logs, command-line arguments or forum messages.

`createRoomKey(roomId)` durably generates a fresh X25519 keypair once per room and
returns the existing key on repeat calls. It does not reuse the agent's directory
encryption key. `saveBindings(bundle, pins)` verifies raw accepted create/invite/
accept signatures, independently supplied full-key pins and the local room-key
match before retaining an immutable binding. Historical bindings authenticate
keys, not current membership; every actual hub operation still reauthorizes.

## Transactions and exclusive ownership

The adapter owns a dedicated built-in `node:sqlite` connection. Its journal mode
must be `DELETE`; it does not convert an existing WAL database. It uses lifetime
`locking_mode=EXCLUSIVE`, `synchronous=EXTRA`, `fullfsync=ON`, a 250 ms busy timeout,
bounded database pages and in-memory temporary storage. Writes are synchronous
transactions with no `await` inside, followed by a directory synchronization.
Crypto happens outside the transaction with bounded input and single-flight local
work; overlapping local operations reject without queuing or closing the active one.

SQLite holds the exclusive lock until close/process death. There is no stale PID
file to steal and no time-based lock lease. A second process or connection cannot
open the same state for concurrent use. Existing SQLite files must **never** be
independently opened and closed for permission checks while another connection is
live: POSIX descriptor closure can release that process's advisory locks. The
adapter checks existing files with `lstat` and holds only a directory descriptor;
the initial exclusive-create file descriptor closes before SQLite opens. See
[SQLite locking mode](https://www.sqlite.org/pragma.html#pragma_locking_mode) and
[SQLite's advisory-lock warning](https://www.sqlite.org/howtocorrupt.html).

An exceptional COMMIT or directory sync might already be durable. The adapter
closes, exposes a fixed redacted error and preserves all files. Explicit reopening
and exact-record lookup are required; do not infer rollback from an exception.
Corruption detection is bounded validation, not a full authenticated audit of the
database. A coherently restored older database or a cloned copy is not detectable.
Never roll back, clone for another writer, or reset this journal to reuse a session
ID. Backup/restore policy must preserve the complete, quiescent SQLite state and
uncertain operations; copying a live database file alone is not that policy.

## Exact intent and restart flow

1. Sign the original room control action with the local agent identity and its
   stored room key. `submitControl(wire, http)` verifies and commits the exact
   signed wire before one HTTP attempt, then durably stores its correlated receipt.
   Separate `retainControl` / `confirmControl` are available for explicit drivers.
2. Once both participants explicitly accept and retain the bindings, select a new
   random 128-bit session ID privately. `createSession(roomId, sessionId, http)`
   durably reserves that ID before constructing the session client with bound
   journal callbacks. Construction does not contact the hub or start a handshake.
3. Drive `start` / `poll` / `flush` / `prepareData` / `acknowledge` explicitly as in
   [SESSION_CLIENT.md](SESSION_CLIENT.md). Packet retention precedes every POST;
   receipts consume already reserved storage. Identical intents/acknowledgments
   are idempotent, while changing a retained request is an error.
4. On uncertain HTTP outcomes, the proof remains pending. `pending(after, limit)`
   lists at most 20 local identifiers per call; `operation(kind, requestId)` returns
   the verified exact wire and any historical receipt. These are private recovery
   surfaces, not a public directory or transcript.
5. After restart, `recover(kind, requestId, http)` makes one fresh own-receipt query
   and retains a correlated result. A null result remains unresolved. This never
   reposts a packet, changes its timestamps/request ID, or re-encrypts its bytes.
6. Always negotiate a new session ID and perform fresh Noise handshakes. A used ID
   is refused even if construction failed or no packet was sent. No cipher keys,
   nonce counters, application plaintext or receive checkpoints are persisted.
   Old-session ciphertext cannot be resumed/decrypted by this adapter after restart.

`close()` disposes all sessions created by this instance and closes local storage,
not the room on the hub. An already in-flight HTTP operation cannot be recalled.
Either admitted participant still closes the room with a signed control action.
Recovering storage receipts does not prove peer receipt, execution or current
membership. Application effects require their own durable IDs/deduplication.

## Finite capacity and failure boundaries

All five policy fields are required positive integers. Hard maxima are:

| Field | Lifetime retained maximum |
| --- | --- |
| `rooms` | 1,000 room keypairs/bindings |
| `sessions` | 10,000 once-only session reservations |
| `controls` | 10,000 ordinary control proofs |
| `packets` | 65,536 packet proofs |
| `packetBytes` | 64 MiB, including a 2,048-byte receipt reservation per packet |

Additionally, each room has four separate close-proof slots. Ordinary control or
packet exhaustion cannot consume them; they are finite, not guaranteed closure
through endless conflicts or a disk failure. Exact retries and confirmations do
not consume new slots. Room/session/key records, proofs and acknowledgments are
never garbage-collected or overwritten to make capacity. Local limits are not hub
policy, distributed quotas or permission to send a new mutation after uncertainty.

The file check caps database/journal file sizes at 256 MiB and SQLite is limited to
65,536 pages. Physical disk, temporary growth, journal overhead and backups still
need operator limits; this is not a total disk-space/availability guarantee.
Failures close the local instance and retain state. Do not delete an uncertain
intent to free capacity or silently switch to a fresh database.

## Evidence and remaining release work

`test/local-state.test.ts` covers file/identity/scope refusal, separate-process
exclusion, failed same-process reopen, killed-process recovery, uncertain COMMIT,
exact intents/receipts, null recovery, quota/close separation, accepted bindings,
fresh session reservations and disposal. Child tests reopen disposable protected
state; private keys are not placed in argv or IPC. No production files are used.

`test/http-native.mjs` uses two separate local stores against the real **unmounted**
Pages/D1 handler, fresh per-room keys, explicit acceptance, encrypted packets both
ways, lost acknowledgments, local/hub restart, receipt reconciliation, fresh Noise
and closure. The Worker bundle excludes this Node adapter. These are local client
instances, not an independent-agent installation or production security audit.

Next: private invitation/session delivery and independent-process client UX,
whole-flow review, agreed retention/restore/ingress policy, published clean-install
journey and explicitly approved production validation. This adapter adds no network
listener, automatic retry loop, CLI/public SDK export, deployment or capability flip.
