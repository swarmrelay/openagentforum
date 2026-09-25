# Native Pages/MCP compiler lifecycle — #296

`pages-bundle.test.mjs` still compiles the actual Pages Functions, inspects the
metafile for the workerd shim and forbidden imports, and executes the resulting
router, four MCP tools, discovery and CORS checks in local workerd/D1. The
fixture's privileged SQL endpoint is local test infrastructure; never deploy it.

The compiler is now the installed Wrangler CLI entry launched with the current
Node executable, rather than a pnpm process wrapping Wrangler's own bin-wrapper
process. No package version, compiler flag, production config or timeout is
changed. The `MINIFLARE_WORKERD_PATH` override is omitted from the compiler's
environment and set only for the subsequent native execution. The previous
environment is restored even if fixture cleanup throws.

`helpers/compiler-process.mjs` provides a 45-second deadline, 1 MiB combined
stdout/stderr cap, parent-test cancellation and separate exit/pipe-close checks.
A logged `Compiled Worker successfully` marker is a diagnostic observation, not
permission to proceed. Only a natural zero exit with closed pipes succeeds; the
existing bundle and real-router assertions still have to pass afterward.

Failures retain only a fixed reason, compilation/exit/close booleans, exit code
and signal, saturated byte counters and elapsed milliseconds. No command line,
environment, raw compiler text or underlying error object is returned to the
test reporter. This does not change Wrangler's own separately configured logging.

On macOS/Linux, the child owns a new process group. Failure first sends TERM to
that group, then KILL after 500 ms, including descendants that inherited pipes
after a zero-exited parent. A further 500 ms bounds waiting for pipe closure;
incomplete cleanup remains a failure with `closed: false`, never a pass. Windows
has an exact-PID taskkill fallback but is not a verified runner for this fixture.
This is a test harness for repository-owned commands, not a sandbox for hostile
executables that can deliberately escape process groups.

`compiler-process.test.mjs` exercises ordinary completion, split log markers,
spawn/nonzero failures, output saturation, abort, pre/post-compilation timeouts,
TERM refusal and a descendant holding pipes after its parent exits. It verifies
redaction and that the fixture descendant stops writing its temporary heartbeat.
These regressions run through the package's existing `node --test test/*.test.mjs`
command and workspace CI; the real native fixture is not skipped or mocked away.

## Evidence boundary

The original intermittent macOS compiler-exit hang remains unexplained. The
unchanged baseline also passed locally on 2026-09-24; a later passing run is not
proof that the runtime override caused the earlier hang. This work repairs
environment scope, diagnostics and failure cleanup so a recurrence can be
identified without accepting a killed compiler or exposing raw output. Keep
#296 open until new diagnostics establish a cause and a targeted fix is verified.
