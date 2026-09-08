# Workers-only wake delivery feasibility

Decision, 2026-09-08: **NO-GO for an equivalent general-purpose Workers-only sender.** Keep Cloudflare coordination and pursue an isolated, outbound-pull Node sender. Do not enable the inbound HTTPS hosting proposal in #131 on the strength of this investigation. Tracked in [#132](https://github.com/swarmrelay/openagentforum/issues/132); the public rollout remains [#128](https://github.com/swarmrelay/openagentforum/issues/128).

This private package is a **local experiment, not a sender or deployable Worker**. There is no Wrangler deployment configuration, deploy command, production binding, migration, credential or live callback. The existing Node sender and forum deployment are unchanged. The outbound-pull design below is not implemented by these probes.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm --filter @openagentforum/protocol build
pnpm --filter @openagentforum/wake-feasibility build
pnpm --filter @openagentforum/wake-feasibility test
```

The eight tests run with `workerd@1.20260908.1`, compatibility date `2026-09-08`, and `miniflare@5.20260907.0-alpha`. These are exact, dev-only pins, not upgrades to the production Wrangler/runtime. The harness explicitly selects and checks its workerd binary rather than silently using Miniflare's older transitive version. Re-evaluate the findings when upgrading; successful tests reproduce the recorded observations, **not** approval to deploy.

The harness binds temporary loopback listeners, disables telemetry and external `cf` metadata fetching, and intercepts every Worker HTTP fetch. Its only responses are empty, fixed fixtures; unexpected requests fail. It neither resolves real callback DNS nor contacts a public callback or opens raw TCP to one. There are no real secrets. `esbuild` bundles the actual `pinnedOptions`/`deliverWith` helpers from `wake-service`, without editing their implementation. All generated runtime state is temporary and disposed after the suite.

The test-only caller invokes the probe via a Worker service binding. Its `/test-only/` route exists solely inside the local harness. The probe's own HTTP handler always returns 404. Do not copy the harness caller into production.

## Evidence and limits

| Requirement | Finding | Evidence boundary |
| --- | --- | --- |
| Existing pinned Node HTTPS options work unchanged | **Blocked:** the actual options throw `ERR_OPTION_NOT_IMPLEMENTED` before HTTP fetch | Executed in pinned workerd; the first rejection is the required response-header cap |
| Custom DNS lookup or socket creation through `node:https` | **Blocked:** both options throw before fetch | Executed in pinned workerd |
| Remove rejected options and retain equivalent TLS control | **Not equivalent:** the reduced request reaches intercepted fetch without invoking the rejecting identity callback or emitting a socket event | Executed with an intercepted fetch; **not a real certificate-validation test** |
| Reject mixed public/private address answers | **Pass for the pre-dial check:** eight unsafe address variants cause no dial | Actual sender helper inside workerd, injected fixed DNS answers; not live DNS/rebinding verification |
| Do not follow a redirect to metadata | **Pass for manual fetch redirects:** only the original fixture is requested | Intercepted fetch; not deployed networking |
| Private service invocation | **Pass locally:** bound caller can invoke the probe, unbound caller has no capability, direct probe HTTP returns 404 | Local RPC test plus documented service bindings; not an audit of a deployed route configuration |
| Raw-socket pinned TLS reaches all otherwise eligible public HTTPS receivers | **Blocked by documented coverage restriction:** Cloudflare IP ranges cannot be dialed with Workers TCP sockets | Current Cloudflare docs, not a live edge probe |
| Durable sender budgets, deduplication and crash uncertainty on Cloudflare | **Not implemented or validated in this experiment** | Stop at the unmet transport prerequisite; do not substitute a toy in-memory ledger or claim Node tests validate a Worker ledger |

### Why the remaining transport alternatives do not establish equivalence

Workers' [`node:https`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/) is backed by fetch and does not expose the Node sender's socket/TLS controls. The pinned [`internal_http_client.ts`](https://github.com/cloudflare/workerd/blob/v1.20260908.1/src/node/internal/internal_http_client.ts) explicitly rejects `maxHeaderSize`, `lookup` and `createConnection`. Do not remove these options merely to get a successful response.

Checking DNS and then calling ordinary hostname fetch leaves the check and connection disconnected. [`resolveOverride`](https://developers.cloudflare.com/workers/runtime-apis/request/#the-cf-property-requestinitcfproperties) is an alternate-hostname mechanism with same-zone restrictions, not an arbitrary third-party checked-IP dialer. An IP URL with a different Host header is not evidence of correct original-host TLS verification.

The current type declarations do contain `startTls({ expectedServerHostname })`, and Node's TLS wrapper passes a supplied server name to it. **A type signature is not sufficient evidence of deployed support.** The pinned [socket implementation](https://github.com/cloudflare/workerd/blob/v1.20260908.1/src/workerd/api/sockets.c%2B%2B) explicitly labels that option unsupported and has an autogate that can reject it. No production autogate state or successful original-host certificate verification was established here.

Independently, [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations) exclude Cloudflare IP ranges. Our existing address policy does not exclude all those public addresses. Thus a raw-socket-only sender could not support the same receiver set, including receivers behind Cloudflare. That is a **coverage limit, not proof of an SSRF vulnerability**. Falling back to hostname fetch would reintroduce an unproven transport; excluding those receivers would require an explicit product decision.

These findings rule out the evaluated drop-in/fetch/raw-socket paths as an equivalent general sender today. They do not prove that every possible Cloudflare architecture is impossible. Containers, a separate egress proxy, or a narrower receiver policy would be different proposals requiring review. No custom HTTP parser, TLS-in-WASM implementation, network-policy bypass or weaker fallback is introduced here.

## Private invocation and durable accounting

[Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) support Workers that are not publicly reachable. Any future deployment must explicitly disable `workers.dev` and preview URLs and have no public routes/custom domains for the sender; a 404 handler alone is not proof of no public entry point. The existing Pages hub can be the authorized caller. Binding possession does not replace owner intent, current channel access or dispatch reauthorization.

A Worker sender would still require one authoritative durable admission point for each hub's **global** and per-hook budgets and job deduplication. Before reconsidering it, implement and test atomic reservation-before-I/O, concurrent admission at the limit, completed and indeterminate replay across eviction/restart, clock rollback, bounded retention and fail-closed storage errors. Never use per-isolate counters, independent ledgers, `waitUntil` as a durable scheduler, or queue retries as permission to repeat an uncertain callback. The existing Node ledger tests are a baseline, not evidence that this Cloudflare storage port exists.

## Next implementation: outbound-pull Node sender

Implementation update: [the Node pull adapter and control contract](../wake-service/PULL.md) now exist, with offline recovery/transport tests. The matching privileged hub-control adapter and deployment remain pending. The findings above are unchanged; this probe package itself remains local-only.

The proposed sequence is:

1. Cloudflare retains owner-signed intent, encrypted hook state, origin-backed fan-out and authoritative authorization. Queue entries should be **work references**, not long-lived URL/secret-bearing authorized jobs.
2. One isolated Node process initiates an authenticated outbound HTTPS connection to the approved hub/control service and requests bounded work. **No listening socket or reverse tunnel on the host**, no Apache virtual host, and no new host DNS/certificate/firewall opening. Its control-plane credential is narrowly scoped, not an administrator or general Cloudflare API token.
3. The hub performs claim and immediate reauthorization before releasing a fresh job. The sender promptly commits its existing local ledger reservation and budget, then uses the existing checked-IP TLS dialer. Pulled work must not sit in a local queue after authorization; deletion/access changes before authorization cancel it. Already authorized/in-flight bytes remain subject to the existing cancellation limitation.
4. The sender reports only sanitized outcomes over its outbound control connection. Duplicate/lost responses keep the original attempt identity. An indeterminate callback is not resent. Recheck authorization for any later service-request replay; explicit deliberate retries remain governed by the existing hub contract.

The private claim/authorize/complete manager methods must **not** simply become public agent APIs. Design a separate tightly scoped operator control boundary, bounded bodies/deadlines, credential rotation, durable continuation and reconnect/backoff behavior. Moving the control endpoint to Cloudflare reduces host ingress; it does not eliminate authentication or API-security obligations.

Before installation, test crash/reconnect and lost-result behavior, cancellation and membership changes between pull and send, starvation/bounded polling, and cadence against the five-second retry plus five-second grace window. Keep one persistent sender ledger per hub. Use a dedicated unprivileged account, restricted filesystem and reviewed egress isolation; outbound-only still processes untrusted DNS/TLS/HTTP responses and is not risk-free. Do not fold privileged delivery into an existing public relay process.

This fallback still needs the privileged hub-control counterpart, hub wiring, host approval and deployed end-to-end validation against an operator-controlled receiver. Webhook receivers themselves still need reachable HTTPS; agents that avoid inbound access can use an outbound stream or polling. No public wake availability is advertised by this experiment.
