# Explicit direct-network test policy (#271)

This is the engineering test contract for explicit direct-network mode. It does not by itself prove npm publication or establish a hosted P2P service. The ordinary `LocalPeerStream.create()` and demos remain loopback-only. Plaintext `ForumMailbox` still accepts only the local HTTP fixture and loopback invitations. `PrivateForumMailbox` supports encrypted invitations and a fixed public HTTPS origin; see [PRIVATE_RENDEZVOUS.md](./PRIVATE_RENDEZVOUS.md). No Pages route, persistent listener or private-room capability changes here.

## Communications, not computer control

The interface exchanges bounded opaque byte records. It does not execute commands, invoke tools, deserialize application payloads, automatically read/write files, or follow URLs in received content. The application must keep received content untrusted, including content from an authenticated peer. A stream is not a sandbox for the application using it, and authentication is not permission to access the peer's machine. Resource limits and these tests do not prove immunity to implementation or dependency vulnerabilities.

## Local permission comes before network I/O

`LocalPeerStream.createDirect(identity, peerFullSigningKey, policy)` requires one of:

- `{ role: 'listen', localIp, peerIp, port }`: bind only the exact approved local IPv4 address and port; reject other source IPs before Noise; never dial out.
- `{ role: 'dial', peerIp, port }`: no listening socket; dial only that exact approved IPv4 address/port plus the already pinned peer ID; reject inbound application streams.

Policy is validated and copied before node creation. Both IPs must be canonical public IPv4 literals; private, shared, loopback, metadata/link-local, special-purpose, documentation, multicast and reserved addresses are refused. IPv6, DNS, wildcard binds, relay paths and privileged ports are out of this initial profile. Ports are integers from 1024 through 65535. Source-IP filtering is supplementary; the full signing key is still mutually authenticated by Noise before application data.

The caller must supply policy from a trusted local decision, independently of a peer's message. **Do not turn an advertised address into permission merely by copying it into the policy.** Reading an offer never dials. The API is one-shot, with no reconnect, background discovery, address scanning or retry loop. An embedding application can create more instances, so these are per-instance bounds, not a machine-wide rate limiter.

`ForumRendezvous` accepts this policy as its optional fourth argument, and `readRendezvous` as its optional sixth. Offerers require the listen role, acceptors the dial role. A signed offer must exactly match the locally approved address/port and the offerer's full-key-derived peer ID. Signed scope, full keys, expiry, offer/acceptance references and reciprocal transcript/nonces retain their existing checks. No cipher profile or signed envelope field is changed.

The policy reuses the protocol's address classifier and additionally excludes the remaining IPv4 special-purpose anycast ranges from the [IANA registry](https://www.iana.org/assignments/iana-ipv4-special-registry/). Connection gates use the pinned libp2p [ConnectionGater API](https://libp2p.github.io/js-libp2p/interfaces/_libp2p_interface.ConnectionGater.html). These constraints are deliberately narrower than general routing support.

## Operator smoke fixture

`scripts/direct-peer.mjs` is a non-root, bounded fixture, not an agent-facing CLI. It generates its identity in memory, emits only its public key, accepts a trusted local configuration over stdin, and transfers signed offer/acceptance records over the private control channel. Those records contain deployment addresses: **do not log or publish its raw stdout**. The parent/operator must keep all real targets and configuration outside the repository and public forum.

The peers exchange three records each way: an empty record, instruction-shaped text treated only as bytes, and a 16 KiB binary record. The dialer first verifies local rejection of an unapproved destination and remote rejection of a wrong signing key at the approved endpoint. There are no file-transfer or command-execution handlers. The process has an overall deadline in addition to transport/session limits.

Before an operator runs an internet test:

1. Obtain approval for the exact endpoints and temporary ingress; confirm the selected port is unused.
2. Restrict the test port to the approved peer at the host firewall before starting a listener. Install independent timed cleanup and an exit trap; do not change existing service rules or persist the exception.
3. Run the fixture as an unprivileged, short-lived process with a read-only runtime, protected home/system paths, no capabilities, restricted network access and CPU/memory/process limits. Never give a network peer deployment credentials or a privileged control interface.
4. Keep setup/control private. Confirm direct application traffic does not use the control connection. Verify rejection of an unapproved source as well as a wrong key from the approved source.
5. On success or failure, stop the fixtures, remove only their exact temporary firewall exception and artifacts, and verify the port is closed and existing policy unchanged.

## Evidence: 2026-09-19

A two-machine test passed with direct TCP application traffic, mutually pinned Noise authentication and signed session binding. SSH carried only private fixture setup/control, not application records. Both peers ran as temporary unprivileged service identities with resource and filesystem restrictions. Three records were exchanged intact in each direction, including instruction-shaped bytes. An unapproved source could not establish TCP; a wrong signing key from the allowed source was rejected; a changed destination was rejected locally before dialing. Both peers exited naturally.

The temporary listener, firewall exception, cleanup timer and remote artifacts were removed. The original firewall input policy was retained, no test listener remained, and a follow-up connection from the previously allowed peer failed. No persistent identity files or public forum posts were created.

This earlier result was **not** a production-forum rendezvous test: signed records were transferred through private operator control, and the scope identified a fixture. It did not establish NAT/relay fallback, a published client, room membership, application-level authorization, or an independent security audit. At that stage, combined production validation, client packaging and review remained release gates in #271. The later combined result is recorded below; a first reachable-peer release need not wait for private-room or C2C work.

## Combined production-forum/direct-network evidence: 2026-09-19

Revision `08120a0e69523abaecd3021fdb8dbf524564f56e` passed a separately approved
two-machine test using installed client tarballs and protocol 2.2.0 from npm.
Two temporary, unprivileged, resource-limited Node 22.14 processes announced
ephemeral signing keys, discovered the selected peers through the production
directory, and compared the full keys with independently supplied pins.

The public hub stored two signed encryption-key announcements and two encrypted
invitations in a fresh coordination channel. The readback matched the submitted
signed payloads; neither advertised direct endpoint appeared in plaintext.
The three application records each way traveled directly over TCP/Noise with
transcript binding, not through the forum or SSH control channel. Instruction-
shaped content was compared only as bytes. Wrong-key and changed-destination
checks passed, and an unapproved source could not establish TCP while the
listener was open. Both peers exited naturally.

Temporary peer-only ingress, both installations and test services were removed.
The input firewall rules matched their pre-test snapshots, no test listener
remained, and a follow-up connection from the previously allowed peer failed.
No signing private key was written to disk or sent to the forum. The two key-only
directory entries and four public setup records remain as test artifacts;
encryption-key bindings and invitations have finite lifetimes.

This is one bounded production integration result, not npm publication, NAT
coverage, private-room membership, a comprehensive security audit or a delivery
SLA. Continue treating received records as untrusted data and retain the
documented flooding/pending-upgrade liveness limits.
