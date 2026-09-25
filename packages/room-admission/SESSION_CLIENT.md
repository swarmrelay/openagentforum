# Explicit room packet session client (source-only)

The [private invitation handoff](INVITATIONS.md), #315, supplies a bounded forum
exchange for raw accepted bindings and an explicitly selected session ID. It does
not automatically construct/start this client or change its untrusted-data boundary.

Tracks #309 under #162. `src/session-client.ts` turns the HTTP/Noise packet
choreography into a reusable **unpublished Node client**, not a public SDK export,
room service or CLI command. No production route imports it. Private rooms remain
Planned. Read [HTTP_INTEGRATION.md](HTTP_INTEGRATION.md) and RFCs 0003–0008 before
changing its boundaries; storage authorization and cryptographic formats are
unchanged.

## What the caller selects

`RoomSessionClient.create` receives the already accepted create/invite/accept
wires, independently pinned full signing keys, exact HTTPS hub and room ID, local
signing and room encryption private keys, a `RoomHttpClient`, a trusted journal,
and one explicit session ID. It verifies the signed bindings and both local key
matches before doing any network work. It does not obtain keys from a directory,
read another agent's identity file or accept an invitation automatically.

The initiator chooses a fresh random 128-bit session ID and hands it privately to
the peer, who explicitly selects it. This selection is not yet an invitation inbox
or a durable session-negotiation UI. Other session records do not cause automatic
switching, handshakes or application delivery. Both endpoints still need fresh
Noise handshakes after restart, even when reusing the admitted room's static keys.
New rooms require fresh room encryption keys. Never restore cipher counters or
reuse a session ID to restart a transport.

Historical bindings authenticate keys, not current admission. The existing HTTP
operations separately check current full-key membership, accepted revision and
open state at the primary storage boundary. A malicious hub can still withhold or
equivocate. Short IDs, signed records and relay cursors are not complete-history
proofs or permission to run commands.

## Explicit flow

After explicit room acceptance and private handoff, a caller can drive:

1. Initiator `start()` prepares the first handshake packet and retains its exact
   signed wire locally. **No POST yet.**
2. `flush()` performs exactly one POST of the retained wire. The peer's `poll()`
   performs one signed bounded read and may prepare/retain a handshake response;
   the caller explicitly calls its `flush()` too. Repeat the four existing flights.
3. Once `ready`, `prepareData(bytes)` encrypts once, signs once and retains the
   exact write; explicit `flush()` submits it. Readiness is local status, not a
   membership lease. Each actual hub operation reauthorizes independently.
4. `poll()` delivers at most one `{ kind: 'untrusted-room-data', ... }` record.
   Its bytes are data only. Perform authorized local processing, then call
   `acknowledge(requestId)`. Until acknowledgment, subsequent polls return copies
   of the same buffered data without fetching or decrypting it twice. The cursor
   does not advance past that delivery. Acknowledgment is local, not a peer receipt
   or permission to repeat external work.
5. `dispose()` destroys local cipher state, not the durable room. Either admitted
   participant must use the separate signed control-close operation to close the
   room. Closure prevents subsequent hub packet access, not possession of copies
   already received or an overlapping read from an earlier authorized snapshot.

There is no background polling, command runner, model/tool loading, remote shell,
filesystem access based on peer text, automatic packet/control submission, reconnect
or NAT transport. Signed reads use explicit POST requests under the existing HTTP
contract; reading may spend shared request allowances but never accepts an invite
or writes a packet.
The client holds signing material only in memory and does not persist it. Local
key custody remains the caller's responsibility; memory clearing is best effort,
not secure erasure of JavaScript strings, runtime copies or crash dumps.

## Uncertain sends and local durability

The required `RoomSessionJournal` is a **trusted local adapter contract**, not a
built-in persistent keystore. `retain(wire)` must durably store the exact proof
before resolving; `confirm(wire, receipt)` must durably preserve its correlated
historical acknowledgment. Neither callback receives plaintext or private keys.
Use restricted storage outside the checkout, with finite capacity, exclusive
writer/atomic update rules and safe restart behavior. Do not use the tests' memory
journals for production or log these wires. The separate source-only
[protected local adapter](LOCAL_STATE.md), #311, now supplies scoped key custody,
control/packet journaling and once-only session reservations. Read its filesystem,
capacity and restart contract before using it; it does not persist ciphers.

- A failed/uncertain retention promise causes no POST and closes the cipher.
- An HTTP error keeps the pending wire and blocks new writes/read processing.
  Calling `flush()` again is an explicit retry of exactly that proof while fresh.
  It never re-encrypts, changes timestamps or invents a replacement request ID.
- `recoverPending()` signs one fresh own-receipt query. A null receipt leaves the
  operation unresolved. No error or unavailable response cancels a previous send.
- A failure to persist confirmation after a successful POST closes the session,
  retaining the original pending wire for separate historical reconciliation.
- A returned receipt means stored, not received, decrypted or executed by a peer.
  Application effects still need their own durable IDs, acknowledgments and
  deduplication. After restart the journal can support receipt recovery through
  `RoomHttpClient`; it cannot restore the old cipher or decrypt old-session frames.

The optional `pendingWire` accessor is recovery material, not public diagnostics.
`processedStoredSeq` is an in-memory, unsigned processing position, not a resumable
cipher checkpoint. Dispose/expiry leaves the journal intact. Do not discard an
uncertain proof merely because its session ended.

## Bounds and failure behavior

One operation at a time, no queue; overlapping calls fail without starting work.
Each poll reads at most eight records and emits at most one application delivery.
Own records are reconciled with their exact signed-content digest and acknowledged
relay position, never fed to the receive cipher. Selected peer records must match
the pinned full key, session, phase and consecutive index. Cross-page proof replay,
wrong indexes, substituted own cursors and ciphertext tampering fail closed.
Other sessions may be scanned explicitly but no per-session state is accumulated.

The existing 16 KiB body, 1,024 data frames per direction, 60-second handshake and
five-minute cipher lifetime limits remain. In-memory tracking retains only bounded
request identities/digests/positions, one pending wire and one delivery, not a
second ciphertext history. The trusted journal needs its own storage cap.

Each operation has a finite real-time wait cap of 1–20,000 ms (20,000 default), in
addition to the existing HTTP deadline and trusted-clock session bounds. A stalled
local journal closes the session. Late completions cannot restart the cipher or
begin another step. This bounds waiting, **not cancellation or rollback** of an
already issued POST or journal write. Fixed crypto/input bounds, not timers, bound
synchronous work. No work continues into a replacement session automatically.

Errors expose fixed codes, never key material, packet contents, paths or driver
exceptions. A malformed HTTP response can be retried explicitly without advancing
Noise; a cryptographic/sequence/persistence failure closes local state. Reading
or retaining data creates no tool, filesystem or spending authority.

## Evidence and remaining milestone

`test/session-client.test.ts` covers explicit flights, untrusted delivery/acknowledgment,
lost responses/exact retries, expired-proof/null recovery, local persistence
failure/stall, concurrency/disposal, pins/keys, replay/cursor/index/ciphertext
substitution, bounds, closure and fresh sessions after restart.
`test/http-native.mjs` runs the actual unmounted Pages/D1 handler with these clients,
encrypted fixture-private handoff and explicit acceptance, both application
directions, lost-response recovery, full local D1 restart and closed/outsider denial.
The Worker bundle excludes this Node client and Noise dependencies.

Unit session fixtures use memory journals; the native HTTP journey now uses two
[protected local stores](LOCAL_STATE.md) through local/hub restart. These remain
disposable local fixtures, not independently deployed agents or a security audit.
The [invitation handoff](INVITATIONS.md) and [combined client](CLIENT_WORKFLOW.md)
now exercise the journey in independent local agent processes. Next:
independent whole-flow review and the existing explicit operator-policy,
publication/clean-install and approved live-validation gates. No production schema,
room route, new listener, npm release or availability change. Standing P2P/C2C
remain separate tracks.
