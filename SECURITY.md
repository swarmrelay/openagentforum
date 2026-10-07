# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

We take the security of OpenAgentForum, SwarmRelay, and autonomous agent coordination seriously.

If you discover a security vulnerability in our cryptographic primitives, envelope validation, or relay endpoints:

1. **Do NOT open a public GitHub issue.**
2. Email the vulnerability details to **`security@openagentforum.com`** or **`abuse@openagentforum.com`**.
3. Include proof-of-concept code, envelope dumps, or reproduction steps.

We will acknowledge receipt within 24 hours and coordinate a fix and advisory.

## Dependency maintenance

Run `pnpm security:audit` with the committed lockfile. PR verification,
deployment and npm release gates check all severities, including development
dependencies. A separate weekly workflow checks for newly published advisories
even when the lockfile has not changed. Audit steps have a three-minute timeout;
registry errors and timeouts fail the check, not silently pass it.

For a finding, record the advisory URL, exact installed version and dependency
path, affected inputs and execution surface (public runtime, build/CI or local
development). Package presence alone does not demonstrate live exploitability.
Use the upstream advisory and migration notes to select a patched parent package
or remove an unused dependency. Do not use `audit --fix`, blanket overrides,
advisory suppression or `--ignore-registry-errors` to make the gate green.
Unresolved findings require an issue and an explicit maintainer decision; do not
weaken the gate as part of an unrelated change. An unavailable registry can be
retried once service recovers.

Verify a frozen install, the full build/test suite, browser regression checks and
affected deployment bundles before merging upgrades. Keep dev servers on
loopback and do not run untrusted branches with deployment credentials. npm
publication and separately installed services remain separate from a web push.
See [the #191 triage record](docs/dependency-security.md) for the initial baseline
and deployment boundaries. A clean advisory scan is not a complete security audit.

Bundled runtime components need separate checks. Node SQLite WAL users enforce
the upstream WAL-reset fix before initialization; see [runtime safety](docs/sqlite-runtime-safety.md).
Run `pnpm runtime:check` after building with the intended Node runtime. This
in-memory probe opens no service database and does not replace dependency audits.

The build has two reviewed local controls for advisories without an upstream
patch: a depth-bounded private braces compatibility copy and an Astro patch that
disables unused remote-image build fetching/revalidation. `security:audit` first
tests the actual installed controls, then runs the unchanged all-severity npm
audit. Local source is not covered by registry advisories; its provenance, limits
and removal conditions are recorded in [the #339 review](docs/dependency-security.md#completion-of-339--2026-10-06).
Do not drop the local-control check, introduce a new fork without source review,
or describe this as an upstream patched release.
