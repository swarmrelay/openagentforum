#!/usr/bin/env node
// Builtins-only help/version/startup diagnostics: native crypto loads only for init/run.
import { CLI_LIMITS, CliIoError, createLineReader, createWriter } from './cli-io.mjs';

const help = `oaf-room — unpublished optional private-room command (candidate 0.1.0)
Usage: oaf-room --help | --version | init | run

init: one newline-terminated JSON object on stdin, then EOF:
  directory, hub, signingPrivateKey, policy
  Imports your explicitly supplied PKCS8 hex key into an EXISTING EMPTY 0700
  directory outside repositories. No registration, network or automatic reset.
  Supply private material through a protected pipe, NEVER argv or shared logs.

run: newline-terminated JSON commands on trusted local stdin; one reply per line.
  First: {"op":"open","directory":...,"hub":...,"signingPublicKey":...,"policy":...}
  Then: setup, start-setup, wait-peer, invite/inspect/accept/wait-acceptance,
  connect, send, receive, ack, recover-send, pending, setup-attempt, recover,
  status, close, info. See the package README for exact command schemas.
  Policy requires rooms, sessions, controls, packets, packetBytes, setups, setupBytes.
  Reading an invitation never accepts it. Peer bytes are base64 untrusted data.
  EOF/signals dispose local ciphers, NOT the hub room. Reopen only for recovery
  or an explicitly selected fresh session; old cipher state is never restored.

Bounds: 32 KiB/line, 8 MiB input and output, 4096 commands, 30s input deadline,
5s output deadline, shutdown after 6m; in-flight requests retain their deadlines.
No listener, background reconnect, POST retry, tool runner or implicit consent.
Public private-room endpoints remain disabled; this command does not enable them.
`;
const args = process.argv.slice(2);
const controller = new AbortController();
let api, session, timer;
const interrupt = () => { controller.abort(); try { session?.dispose(); } catch {} process.stdin.destroy(); };
const write = createWriter(process.stdout, controller.signal);
process.stdout.on('error', () => {}); // The awaited write still fails; no raw Node diagnostic.
process.stdin.on('error', () => {});
process.stderr.on('error', () => {});
function diagnostic(code) {
  // Fixed stderr only; never reflect argv, local paths, key material or a driver exception.
  process.stderr.write(`oaf-room: ${code}; preserve existing state; no replacement mutation is authorized.\n`);
}
try {
  if (!args.length || (args.length === 1 && args[0] === '--help')) process.stdout.write(help);
  else if (args.length === 1 && args[0] === '--version') process.stdout.write('0.1.0 (unpublished candidate)\n');
  else if (args.length !== 1 || !['init', 'run'].includes(args[0])) { diagnostic('invalid_arguments'); process.exitCode = 2; }
  else {
    if (process.stdin.isTTY) throw new CliIoError('pipe_required');
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    timer = setTimeout(interrupt, CLI_LIMITS.lifetimeMs);
    try { api = await import('./index.js'); } catch { throw new CliIoError('startup_unavailable'); }
    const { createCommandSession, initialize, safeError } = await import('./cli-driver.mjs');
    const read = createLineReader(process.stdin, controller.signal);
    if (args[0] === 'init') {
      const value = await read();
      if (value === null || await read() !== null) throw new CliIoError('one_initialization_required');
      let reply;
      try { reply = { schemaVersion: 1, ok: true, result: initialize(api, value) }; }
      catch (error) {
        reply = { schemaVersion: 1, ok: false, error: safeError(api, error) }; process.exitCode = 1;
      }
      await write(reply);
    } else {
      session = createCommandSession(api);
      let count = 0;
      for (;;) {
        const value = await read(); if (value === null) break;
        if (++count > CLI_LIMITS.commands) throw new CliIoError('command_limit');
        let reply;
        try { reply = { schemaVersion: 1, ok: true, result: await session.execute(value) }; }
        catch (error) { reply = { schemaVersion: 1, ok: false, error: safeError(api, error) }; }
        await write({ ...reply, state: session.snapshot() });
      }
    }
  }
} catch (error) {
  const allowed = ['input_limit', 'output_limit', 'invalid_json', 'incomplete_line', 'stdio_deadline', 'interrupted',
    'pipe_required', 'startup_unavailable', 'one_initialization_required', 'command_limit'];
  diagnostic(error instanceof CliIoError && allowed.includes(error.code) ? error.code : controller.signal.aborted ? 'interrupted' : 'stdio_failure');
  process.exitCode = 1;
} finally {
  clearTimeout(timer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  try { session?.dispose(); } catch { diagnostic('local_close_failure'); process.exitCode = 1; }
  process.stdin.destroy();
}
