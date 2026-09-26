import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { compilerEnvironment, CompilerProcessError, runCompiler } from './helpers/compiler-process.mjs';

const run = (code, options = {}) => runCompiler(process.execPath, ['--input-type=module', '-e', code],
  { timeoutMs: 1000, cleanupMs: 50, ...options });

test('compiler environment excludes fixture runtime and banner update checks without mutating its caller', () => {
  const source = { PATH: 'test-path', MINIFLARE_WORKERD_PATH: 'fixture-only', WRANGLER_SEND_METRICS: 'true',
    WRANGLER_HIDE_BANNER: 'false' };
  assert.deepEqual(compilerEnvironment(source), { PATH: 'test-path', WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true' });
  assert.equal(source.MINIFLARE_WORKERD_PATH, 'fixture-only');
  assert.equal(source.WRANGLER_SEND_METRICS, 'true');
  assert.equal(source.WRANGLER_HIDE_BANNER, 'false');
});

test('compiler success requires natural zero exit and closed pipes; split marker is only diagnostic', async () => {
  const result = await run(`process.stdout.write('Compiled Worker '); setTimeout(() => process.stdout.write('successfully\\n'), 20);`);
  assert.equal(result.reason, 'success'); assert.equal(result.compiled, true);
  assert.equal(result.exited, true); assert.equal(result.closed, true);
  assert.equal(result.exitCode, 0); assert.equal(result.exitSignal, null);
  assert.ok(result.stdoutBytes > 0); assert.equal(result.stderrBytes, 0);
  assert.equal((await run('')).compiled, false);
});

test('compiler failure never reflects stdout, stderr, paths, arguments or error causes', async () => {
  await assert.rejects(run(`console.log('Compiled Worker successfully'); console.error('DO_NOT_LOG_CHILD_SECRET'); process.exitCode = 7;`), error => {
    assert.ok(error instanceof CompilerProcessError);
    assert.equal(error.diagnostics.reason, 'exit'); assert.equal(error.diagnostics.compiled, true);
    assert.equal(error.diagnostics.exitCode, 7); assert.ok(error.diagnostics.stderrBytes > 0);
    assert.ok(Object.isFrozen(error.diagnostics));
    assert.doesNotMatch(error.stack + JSON.stringify(error), /DO_NOT_LOG_CHILD_SECRET|console\.error/);
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(runCompiler('DO_NOT_LOG_MISSING_EXECUTABLE', ['DO_NOT_LOG_ARGUMENT']), error => {
    assert.equal(error.diagnostics.reason, 'spawn');
    assert.doesNotMatch(error.message + JSON.stringify(error), /DO_NOT_LOG/);
    return true;
  });
});

for (const compiled of [false, true]) test(`compiler timeout remains failure after compilation=${compiled}, even when TERM is ignored`, async () => {
  await assert.rejects(run(`process.on('SIGTERM', () => {}); ${compiled ? "console.log('Compiled Worker successfully');" : ''} setInterval(() => {}, 1000);`), error => {
    assert.equal(error.diagnostics.reason, 'timeout');
    assert.equal(error.diagnostics.compiled, compiled);
    assert.equal(error.diagnostics.exited, true); assert.equal(error.diagnostics.closed, true);
    assert.equal(error.diagnostics.exitCode, null); assert.equal(error.diagnostics.exitSignal, 'SIGKILL');
    assert.ok(error.diagnostics.elapsedMs < 4000);
    return true;
  });
});

test('compiler output cap fails even if the command would eventually exit zero', async () => {
  await assert.rejects(run(`process.stdout.write('x'.repeat(65536));`, { maxOutputBytes: 128 }), error => {
    assert.equal(error.diagnostics.reason, 'output-limit');
    assert.equal(error.diagnostics.stdoutBytes, 129);
    assert.doesNotMatch(error.message, /xxxxxxxx/);
    return true;
  });
});

test('compiler reacts to abort before spawn and during execution without leaking the reason', async () => {
  const before = AbortSignal.abort(new Error('DO_NOT_LOG_ABORT'));
  await assert.rejects(run('', { signal: before }), error => error.diagnostics.reason === 'aborted' && !error.message.includes('DO_NOT_LOG'));
  const controller = new AbortController();
  const pending = run('setInterval(() => {}, 1000);', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('DO_NOT_LOG_ABORT')), 100);
  await assert.rejects(pending, error => error.diagnostics.reason === 'aborted' && !error.message.includes('DO_NOT_LOG'));
});

test('compiler deadline covers a zero-exited parent whose descendant holds its pipes open', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oaf-compiler-child-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const heartbeat = join(directory, 'heartbeat');
  const descendant = `import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    setInterval(() => writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);`;
  const parent = `import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.unref(); console.log('Compiled Worker successfully'); process.exit(0);`;
  await assert.rejects(run(parent), error => {
    assert.equal(error.diagnostics.reason, 'timeout'); assert.equal(error.diagnostics.compiled, true);
    assert.equal(error.diagnostics.exited, true); assert.equal(error.diagnostics.exitCode, 0);
    return true;
  });
  const last = await readFile(heartbeat, 'utf8');
  await delay(150);
  assert.equal(await readFile(heartbeat, 'utf8'), last, 'descendant must stop, not survive as an orphan writer');
});
