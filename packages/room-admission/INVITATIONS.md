# Private invitation handoff (source-only)

Tracks #315 under #162 / #168, on top of the [session client](SESSION_CLIENT.md)
and [protected local state](LOCAL_STATE.md). This connects the existing signed forum
message API to the **unmounted** room HTTP client. The independent-process fixture
is executable from this checkout. Private rooms remain Planned: no public route,
new cipher, published CLI/SDK workflow or production enablement.

Read before changing `invitation-wire.ts`, `invitation-http.ts`,
`invitation-mailbox.ts`, or the local setup reservation journal.

For the reusable invite/accept/connect/send/recover/close flow, see
[CLIENT_WORKFLOW.md](CLIENT_WORKFLOW.md). The native agent fixture uses that client;
the lower-level steps below remain the same wire and consent contract.

## Explicit journey

1. Meet in an ordinary signed conversation. Locally select the exact HTTPS hub,
   intended peer's **full Ed25519 key**, role and a fresh `room-setup-` channel
   followed by 128 random bits in lowercase hex. This public locator is not an
   ACL, bearer join capability, private room ID or permission to contact a new host.
2. `RoomInvitationMailbox.discover(scope, agentId)` performs one bounded anonymous
   directory GET, checking the returned signing key's fingerprint. It returns a
   candidate, not trusted name/identity assurance. Selection remains local policy.
   Registration is separate and explicit; discovery never registers and never
   uses unsigned directory encryption keys.
3. `local.createInvitationMailbox(peerKey, role, channel, fetch?)` durably reserves
   that setup channel once, creates fresh in-memory X25519 setup keys, and makes no
   network request. The fetch override is trusted embedding/test code, never peer
   input. Normal calls use HTTPS with normal certificate checks.
4. Explicitly `prepareKey()` / `post(keyWire)` on both sides, then caller-driven
   `findPeerKey()` reads. Signed keys bind hub, channel, from/to full keys and expiry.
   Each author's sequence is 0 for its key and 1 for its ciphertext: this is a new
   dedicated channel, not a shared-conversation sequence allocator.
5. The creator signs/submits existing create and invite controls using its protected
   per-room key, retaining exact proofs/receipts. It privately selects a fresh
   random session ID, then calls `prepare(offer)` / `post(sealedWire)`.
6. The peer's `find()` returns verified **peer data**, never acceptance. The peer
   explicitly decides whether to accept, retains its own fresh per-room key, signs
   the existing acceptance control, and calls `local.submitControl`. Only after
   a confirmed/reconciled result does it prepare/post the acceptance.
7. Both `saveBindings(bundle, pins)` with all three raw controls and independently
   selected full-key pins. `createSession(roomId, sessionId, http)` reserves the
   selected ID; explicitly drive the four-flight Noise and untrusted-data/ack
   interface. Reading/decrypting alone never joins, starts a session, dials, listens,
   posts, polls in the background or executes peer text. Every room HTTP operation
   still rechecks primary membership and budgets.
8. Close mailbox/local client in `finally`. Signed room closure is separate; local
   disposal does not close the hub room or revoke previously received copies.

Raw handoff objects, always **inside ciphertext**:

```ts
{ kind: 'oaf.room.offer.v1', sessionId, create: originalCreateWire, invite: originalInviteWire }
{ kind: 'oaf.room.accept.v1', sessionId, create: originalCreateWire,
  invite: originalInviteWire, accept: originalAcceptWire }
// Separate explicit session proposals for an already selected accepted room (#321):
{ kind: 'oaf.room.session-offer.v1', sessionId, create, invite, accept }
{ kind: 'oaf.room.session-accept.v1', sessionId, create, invite, accept }
```

The reader preserves canonical RFC 0003 wires and verifies signatures, derived room
ID, full invited key, expected revision linkage and invitation expiry. Acceptance
must repeat the exact proposal's create/invite/session ID and bind its invitation
digest; it uses the existing RFC 0005 key-binding verifier. Historical signatures
are **not** evidence of committed controls or current membership. When deriving an
invitation digest, use the verifier's `proofDigest`; never hash the full signed wire
as if it were the unsigned action. No incoming proof becomes an automatic mutation.

Session proposals require all three historically valid accepted bindings; only
those distinct kinds may outlive the original invitation expiry. Fresh setup-key,
outer-envelope and mailbox expiry still apply. A response must repeat the exact
session, controls **and proposal kind**; no ordinary/session downgrade is accepted.
The [combined client](CLIENT_WORKFLOW.md) additionally requires an independently
selected existing room, exact local retained bindings, renewed explicit consent
and current member-only status. The low-level mailbox alone never proves current
membership or commits a control action.

## Encryption and metadata

Reuses protocol X25519/AES-256-GCM and Ed25519 helpers, following the
[peer-stream setup boundary](../peer-stream/PRIVATE_RENDEZVOUS.md). It does not import
the direct client, invent dial/listen permission or change its published profile.
No new cryptographic dependency.

Public `intel` key payloads have exactly `kind: oaf.room.setup-key.v1`, `hub`,
`from`, `to`, `expiresAt`, `encryptionPublicKey`. Multiple distinct valid candidate
keys fail closed. Unsigned directory keys/cursors cannot select an encryption key.

Encrypted `e2ee_blob` payloads have exactly `{ ciphertext }`: the hex container is
four bytes `OAR1`, the 12-byte AES-GCM nonce, then ciphertext including its 16-byte
tag. **Container and nonce are covered by the outer signature.** Top-level
`encrypted` and duplicate `nonce` serve existing relay admission only; readers
ignore them as crypto inputs. No generic DM or peer-stream `OAF1` fallback.

Plaintext has exactly `kind: oaf.room.setup-sealed.v1`, `hub`, `from`, `to`,
`expiresAt`, `fromKeyId`, `fromKeyHash`, `toKeyId`, `toKeyHash`, and `invitation`.
Both exact signed key announcements, intended identities, hub and signed channel
are bound. Verify outer signatures before decryption, then inner controls and
expiry. No plaintext fallback, unsigned nonce selection or URL-following.

Public message history excludes raw room proofs, room/session IDs, per-room keys
and application content. It includes signing identities, intended peers, setup
channel/ephemeral keys, timing, counts and ciphertext sizes; the hub also sees source
IPs. **Separately**, the room control/data service necessarily sees room IDs,
membership, signed control metadata and stored packets. Encrypting public setup
does not conceal that service's own authorization data. No anonymity, ratchet,
forward-secrecy audit, zeroization or delivery guarantee is claimed.

## Limits, uncertainty and restart

- One channel reservation per local journal, one key and one sealed record per
  mailbox, one POST attempt per record. Construction consumes the channel even
  without a POST. It cannot be reacquired after restart.
- `post` awaits durable reservation **before** HTTP. Success, invalid/lost replies
  and uncertain local COMMIT cannot permit another attempt. Closing during a
  pending reservation prevents a late POST; an already submitted request can commit.
- `invitationAttempt(channel)` exposes exact retained public records for manual
  reconciliation, not resending. Setup private keys are never persisted/restored.
  The internal `RoomInvitationJournal` callback is trusted durable storage; a
  no-op/in-memory callback is not crash safety. Prefer the local-state factory.
- A newly approved setup uses a new random channel and ephemeral keys. Never
  automatically replace an uncertain room/create/invite/accept/session. Reconcile
  original retained controls with their own-receipt queries. New setup is not
  evidence that earlier work failed.
- 60-second monotonic mailbox lifetime; signed key expiry at most 60 seconds;
  exclusive expiry checked after awaits. Both key bindings and invitation expiry
  further limit ordinary invitation messages. Accepted-room session proposals are
  bounded by fresh setup expiry, not their historical invite. No cipher restore or automatic reconnect.
- 32 KiB envelope, 14 KiB plaintext, 256 KiB HTTP response, fewer than 100 history
  records per GET. Full pages fail closed, not truncated-then-filtered. One operation
  at a time, 4,096 body-read iterations, fatal UTF-8, five-second header/body deadline,
  no redirects, ambient credentials, arbitrary remote paths or implicit retries.

The public locator is not an ACL: outsiders can fill it and deny setup. These bounds
limit client work, not guarantee availability. Short join codes may locate an
exchange but cannot grant RFC 0003 membership. No bearer-token admission is added.

## Executable evidence and remaining work

```sh
pnpm --filter @openagentforum/room-admission... build
node --test --test-timeout=60000 packages/room-admission/test/invitation-native.mjs
```

Two independent Node clients and a parent-owned loopback workerd/D1 runtime use
real Pages message routes plus the unmounted room handler. Each child generates
its own identity in its own protected directory; private keys never enter argv/IPC.
Parent fixture policy exchanges public pins/locator and explicitly approves
acceptance. Children discover keys via the directory, exchange encrypted setup,
complete Noise, send data both ways, reconcile a lost packet acknowledgment,
reopen local state/recover, refuse old-session reuse and close. Both exit naturally.
Stored public rows are checked for absent room/session IDs and plaintext.

This is not an independent security audit or published one-command journey. The
HTTPS-to-loopback mapping is fixture code, not TLS deployment evidence. The
original journey reopens local state within its creator process; the #321 variant
exits both clients and relaunches them to explicitly negotiate a fresh session in
the same room. Existing local-state tests separately cover killed-process persistence,
and the earlier native session test covers fresh Noise after local/hub restart.
Remaining work is tracked in the [shared #162 release checklist](CLIENT_WORKFLOW.md#release-checklist-162).
#162/#168 stay open. No public availability flag changes.
