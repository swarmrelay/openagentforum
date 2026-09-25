// Test infrastructure only. Commands/arguments are repository-owned, never peer data.
import { spawn } from 'node:child_process';

export function compilerEnvironment(source = process.env) {
  const env = { ...source, WRANGLER_SEND_METRICS: 'false' };
  // This override belongs to the subsequent native fixture, not compilation.
  delete env.MINIFLARE_WORKERD_PATH;
  return env;
}

export class CompilerProcessError extends Error {
  constructor(diagnostics) {
    super(`Pages compiler failed: ${JSON.stringify(diagnostics)}`);
    this.name = 'CompilerProcessError';
    this.diagnostics = Object.freeze(diagnostics);
  }
}

/** Require natural zero exit AND closed pipes. A success-looking log is not success.
 * POSIX children get an owned process group, so timeout cleanup includes descendants.
 * Windows uses taskkill on that exact child PID; Windows is not a verified runner.
 */
export function runCompiler(command, args, {
  cwd, env = compilerEnvironment(), signal, timeoutMs = 45_000,
  maxOutputBytes = 1024 * 1024, cleanupMs = 500,
} = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let child, timer, killTimer, cleanupTimer, settled = false, failure;
    let closed = false, exited = false, exitCode = null, exitSignal = null;
    let compiled = false, tail = '', stdoutBytes = 0, stderrBytes = 0;
    const marker = 'Compiled Worker successfully';
    const diagnostics = reason => ({ reason, compiled, exited, closed, exitCode, exitSignal,
      stdoutBytes, stderrBytes, elapsedMs: Math.round(performance.now() - started) });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      if (failure) {
        // Never return command arguments, environment, raw output or underlying errors.
        child?.unref();
        reject(new CompilerProcessError(diagnostics(failure)));
      } else resolve(diagnostics('success'));
    };
    const killOwned = force => {
      if (!child?.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        else if (force) {
          // No shell or broad image-name matching. This PID came from our spawn.
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          const deadline = setTimeout(() => killer.kill('SIGKILL'), cleanupMs);
          killer.once('error', () => { clearTimeout(deadline); child.kill('SIGKILL'); });
          killer.once('close', () => clearTimeout(deadline));
        } else child.kill('SIGTERM');
      } catch { /* Already exited, or cleanup could not complete; never turn that into success. */ }
    };
    const fail = reason => {
      if (failure || settled) return;
      failure = reason;
      clearTimeout(timer);
      if (!child?.pid) { finish(); return; }
      killOwned(false);
      // Keep this timer even if the parent exits: descendants may still hold pipes.
      killTimer = setTimeout(() => {
        killOwned(true);
        if (closed) finish();
        else cleanupTimer = setTimeout(finish, cleanupMs);
      }, cleanupMs);
    };
    const abort = () => fail('aborted');
    const output = (chunk, stdout) => {
      if (settled || failure) return;
      if (stdout) stdoutBytes = Math.min(maxOutputBytes + 1, stdoutBytes + chunk.length);
      else stderrBytes = Math.min(maxOutputBytes + 1, stderrBytes + chunk.length);
      if (stdoutBytes + stderrBytes > maxOutputBytes) { fail('output-limit'); return; }
      if (stdout && !compiled) {
        const text = tail + chunk.toString('utf8');
        compiled = text.includes(marker);
        tail = compiled ? '' : text.slice(-(marker.length - 1));
      }
    };
    if (signal?.aborted) { fail('aborted'); return; }
    try {
      child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch { fail('spawn'); return; }
    child.stdout.on('data', chunk => output(chunk, true));
    child.stderr.on('data', chunk => output(chunk, false));
    child.once('error', () => fail('spawn'));
    child.once('exit', (code, receivedSignal) => {
      exited = true; exitCode = code; exitSignal = receivedSignal;
      if (code !== 0 || receivedSignal) fail('exit');
    });
    child.once('close', () => {
      closed = true;
      if (!failure) {
        if (exited && exitCode === 0 && !exitSignal) finish();
        else fail('exit');
      }
    });
    timer = setTimeout(() => fail('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
