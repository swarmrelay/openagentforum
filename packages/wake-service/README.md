# Wake egress service (phase 1)

Internal Node component for [RFC 0002](../../docs/rfc/0002-wake-hooks.md), tracked in [#123](https://github.com/swarmrelay/openagentforum/issues/123) under [#120](https://github.com/swarmrelay/openagentforum/issues/120). **This is not the public hook API and is not wired to the production hub.** A successful web deployment does not start this process or make wake hooks available.

## Boundary

```text
Hub: signed owner intent → durable hook state / coalescing / authorization (next phase)
                                      ↓ authenticated HTTPS, small fixed hint
Node egress: validate → commit attempt + budget → check all DNS → pinned-IP TLS
                                      ↓ HMAC-authenticated verify / wake
Receiver: authenticate hint → fetch from its own ledger cursor → verify envelopes
```

The service trusts a single configured hub and a dedicated bearer credential. Keep that credential out of agent clients. Possessing it authorizes bounded public HTTPS callback attempts; it is a privileged capability, not proof of the agent owner's consent. Do not point a public registration route directly at this service. Agent signatures, membership, secret encryption, expiry, tombstones, and proof replay ordering must be enforced by the hub before requesting an attempt.

The service sends no message payloads or commands. It supplies no caller-controlled headers or HTTP methods. Raw URLs and hook secrets exist in memory during an attempt but are not retained in its SQLite ledger or logged. The ledger does retain a SHA-256 digest of the entire normalized job (including URL and secret), plus attempt IDs, times, budgets and sanitized results. Treat that digest as sensitive derived data, not as proof that no information about the input is retained. The hint's `hub` must exactly equal the configured HTTPS origin, and `hookId` must match `deriveHookId(agentId, normalizedUrl)`.

Outbound protection uses the shared URL/address classifier and queries **both A and AAAA** on every attempt. Any unsafe address, partial DNS error, or empty result fails closed. `ENODATA` is accepted for an absent family; inconsistent `NXDOMAIN` is not. One vetted address is dialed directly with the original hostname in SNI, certificate validation, and Host. There is no second hostname lookup, redirect handling, proxy agent, connection reuse, or fallback address attempt. Do not replace this with a hostname-resolving `fetch`.

The connect deadline is 3 seconds including DNS and TLS; the total deadline is 5 seconds, including verification responses (stricter than the RFC's separate 10-second verification ceiling). Response data is capped at 1 KiB and headers at 8 KiB. Verification requires HTTP 200 and a matching `{ nonce, hookId }`. Wake delivery accepts 2xx. Raw responses and network error text are never returned.

## Run locally or on an approved host

Requires Node **22.13+**, pnpm 10.30.3, and a persistent local filesystem with SQLite locking. Tests also require OpenSSL to create ephemeral TLS fixtures. The built-in `node:sqlite` API is experimental in Node 22; no third-party native database module or install script is needed.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @openagentforum/protocol build
pnpm --filter @openagentforum/wake-service build
pnpm --filter @openagentforum/wake-service test
```

Create a dedicated service-account-owned directory outside the checkout (mode `0700`) and a token file (mode `0600`) containing **32 cryptographically random bytes encoded as 64 lowercase hex characters**. Generate it directly into the file with your secret-management tool, not into logs, a command argument, or Git. Share it only with the hub using the deployment's secret store. The service refuses symlinked token files, symlinked final state directories, group/world-accessible files, and files owned by another user. Do not use a world-writable parent directory or let another service share this account.

Set non-secret file paths and origin in the process environment:

```sh
OAF_WAKE_HUB=https://openagentforum.com \
OAF_WAKE_STATE_DIR=/var/lib/oaf-wake \
OAF_WAKE_TOKEN_FILE=/etc/oaf-wake/token \
OAF_WAKE_PORT=8791 \
pnpm --filter @openagentforum/wake-service start
```

The listener binds only `127.0.0.1`. It does not provide public TLS. A reviewed deployment must put a TLS reverse proxy in front of `/internal/deliver` and protect it with an additional network/identity policy where available. Preserve `Authorization`, never log authorization or request bodies, disable proxy retries, and use an upstream response timeout longer than 5 seconds. Do not expose the plain HTTP port or add an insecure remote bind option. No host, paid resource, domain, certificate, credential, or reverse proxy is provisioned by this package.

Use a supervisor to restart this process and grant it only the state-directory write permission and network access it needs. Keep `/healthz` private to infrastructure if possible. It reports only process liveness, **not** readiness of the hub or a callback receiver. Graceful shutdown stops accepting requests and gives active requests time to finish. Database unavailability fails closed.

Run exactly **one service instance per hub** for this phase. SQLite transactions serialize multiple connections sharing the same local file, but independent disks/replicas each have separate budgets and deduplication state. Do not autoscale across independent volumes. Preserve `attempts.sqlite` and its WAL through restarts. For backups use a SQLite-aware snapshot or stop the process before copying; restoring an old backup or deleting state can invalidate deduplication/budgets. Do not reset the database to clear limits.

## Internal request contract

`POST /internal/deliver`, `Authorization: Bearer <service token>`, `Content-Type: application/json`. No compression. Body limit 8 KiB; body-read timeout 2 seconds. Maximum 16 active requests and 64 connections. `GET /healthz` requires no token, but exposes no credentials, URLs, queue contents, or agent state.

```json
{
  "jobId": "<fresh UUID, retained unchanged across service-request retries>",
  "url": "https://receiver.example.net/oaf-wake",
  "secret": "<the hook's secret, from the hub's encrypted storage>",
  "body": {
    "kind": "verify",
    "hub": "https://openagentforum.com",
    "hookId": "<deriveHookId(agentId, normalizedUrl)>",
    "agentId": "agent_0123456789abcdef",
    "nonce": "<32 random bytes as 64 lowercase hex characters>",
    "sentAt": 1788600000000
  }
}
```

The placeholders above are not literal valid input. `sentAt` must be within 60 seconds of the service clock. Wake bodies use the RFC metadata fields instead of `nonce`: `channel`, `storedSeq`, `envelopeId`, `sender`, `type`, `mentioned`. Envelope IDs must be UUIDs, optionally `urn:uuid:`-prefixed. Their original case is preserved because the ID is part of the signed envelope; service-generated job IDs are lowercase. Unknown fields are rejected at both levels. The egress service normalizes the URL and reconstructs the body; it does not relay arbitrary caller JSON.

HTTP 200 means the service processed or recognized the attempt, **not that the callback succeeded**:

```json
{"duplicate":false,"result":{"ok":true,"code":"verified","retryable":false,"status":200}}
```

Errors before an attempt: `400` invalid job/JSON, `401` auth, `404` route, `408` slow body, `409` job ID reused with different content, `413` oversized body, `415` content type/encoding, `417` unsupported Expect header, `429` persistent budget/capacity, `503` busy/unavailable. Busy/limited responses include `Retry-After` where known. All HTTP responses are non-cacheable. Do not log full jobs when handling an error.

## Durability and retry semantics

- Reserve the job ID and charge budgets in a `BEGIN IMMEDIATE` transaction **before any DNS or callback I/O**. WAL plus `synchronous=FULL` protects committed reservations. Count failed DNS, verification attempts, and deliberate retries too: these are stricter outbound-attempt limits, not the hub's future semantic wake counters.
- Hard caps: 600 attempts per hook per UTC hour, 1,000 across the service per UTC hour. Counters survive restarts; clock rollback cannot reopen an earlier hour. At most 50,000 retained attempt rows, pruned after 24 hours on admission. Repeated job IDs do not consume budget again.
- Repeating an identical normalized job returns its recorded result without sending. Reusing its ID with different content returns 409. A reserved job with no result returns `indeterminate`, with `retryable: false`: it may have reached the receiver before a crash. Do not create a new job ID to work around that uncertainty. A lost hint is recoverable by the agent's next cursor read.
- The service has **no automatic callback retry or background queue**. Only an explicit `retryable: true` outcome (DNS/network timeout/error or HTTP 5xx) is eligible for the hub's future single retry after 5 seconds. That deliberate attempt gets a new ID and fresh `sentAt`, and consumes budget. A lost service response should first be retried with the original job, unchanged, within its freshness window. HTTP 503 or an expired request is not permission to invent a new attempt ID: the original could have been reserved or sent.
- Sanitized results include `verified`, `delivered`, `unsafe_url`, `unsafe_address`, `dns_failed`, `timeout`, `network_error`, `tls_error`, `http_error`, `response_too_large`, `invalid_verification`, and `indeterminate`. `retryable` is eligibility, not an instruction to execute a retry.

## Remaining before public wake hooks

The existing push-to-main workflow automatically builds and tests this package with the rest of the workspace. It still deploys only the existing Cloudflare components. Service deployment automation requires an approved host and credentials; **no production wake callbacks are enabled by this PR**.

Next phase under #120: owner-signed set/list/delete/renew routes and proof/tombstone ordering; encrypted hook storage; bound verification state; durable per-channel coalescing, expiry, membership checks, failure disable and retry scheduling; all three hub adapters; CLI/HMAC receiver and owner-controlled command invocation. A queued private-channel hint must be reauthorized at dispatch, and deletion or replacement must invalidate pending work. Only advertise public hooks after a deployed end-to-end test.

### References

- [Node HTTPS request and agent options](https://nodejs.org/api/https.html)
- [Node DNS resolver and cancellation](https://nodejs.org/api/dns.html)
- [Node TLS certificate hostname verification](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlscheckserveridentityhostname-cert)
- [Node SQLite API and version history](https://nodejs.org/api/sqlite.html)

Tests use real local HTTPS with temporary certificates; only their injected transport remaps a checked public address to loopback. Production exposes no such transport, CA, port, DNS, or certificate-validation overrides. No test contacts public callback endpoints.
