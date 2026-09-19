import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(dependencies = true) {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-doctor-startup-')); fixtures.push(dir);
  cpSync(fileURLToPath(new URL('../dist', import.meta.url)), join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'swarmrelay', version: '0.0.0', type: 'module' }));
  if (dependencies) {
    mkdirSync(join(dir, 'node_modules', '@openagentforum'), { recursive: true });
    for (const name of ['protocol', 'sdk']) symlinkSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)),
      join(dir, 'node_modules', '@openagentforum', name), process.platform === 'win32' ? 'junction' : 'dir');
    // Mask any ancestor/global installations as well: these entries cannot load.
    for (const name of ['mcp', 'server']) {
      const unavailable = join(dir, 'node_modules', '@openagentforum', name); mkdirSync(unavailable);
      writeFileSync(join(unavailable, 'package.json'), JSON.stringify({ name: `@openagentforum/${name}`, type: 'module', exports: './unavailable.js' }));
    }
  }
  const run = (...args: string[]) => spawnSync(process.execPath,
    [join(dir, 'dist', 'bin.js'), 'doctor', ...args], { cwd: dir, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, SWARM_HUB_URL: 'https://openagentforum.com', SWARM_IDENTITY: join(dir, 'absent-identity') } });
  return { dir, run };
}

it('runs offline doctor with no MCP/server/room dependency or general command module', () => {
  const { dir, run } = fixture();
  renameSync(join(dir, 'dist', 'commands.js'), join(dir, 'dist', 'commands-unavailable.js'));
  const result = run('--offline', '--json');
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ schemaVersion: 1, mode: 'offline', exitCode: 0, status: 'warning' });
  expect(report.checks).toContainEqual(expect.objectContaining({ id: 'packages', code: 'version_unavailable' }));
  expect(run('--help').stdout).toContain('Read-only runtime');
  expect(existsSync(join(dir, 'absent-identity'))).toBe(false);
});

it('prints redacted JSON and exit 1 when doctor dependencies cannot load', () => {
  const { dir, run } = fixture(false);
  const result = run('--offline', '--json');
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, mode: 'offline', status: 'error', exitCode: 1,
    checks: [{ id: 'doctor', code: 'startup_error', status: 'error' }] });
  expect(result.stdout).not.toContain(dir);
  expect(existsSync(join(dir, 'absent-identity'))).toBe(false);
});

it('prints a text startup error when the doctor module is absent', () => {
  const { dir, run } = fixture();
  renameSync(join(dir, 'dist', 'doctor.js'), join(dir, 'dist', 'doctor-unavailable.js'));
  const result = run('--offline');
  expect(result.status).toBe(1); expect(result.stdout).toContain('startup_error');
  expect(result.stdout).toContain('complete CLI installation');
  expect(result.stdout + result.stderr).not.toContain(dir);
});

it.each(['import', 'run'])('does not leak %s failure diagnostics, arguments or private paths', phase => {
  const { dir, run } = fixture(false);
  const statement = 'throw new Error("PRIVATE_FIXTURE_MARKER")';
  writeFileSync(join(dir, 'dist', 'doctor.js'), phase === 'import' ? statement : `export async function runDoctor() { ${statement}; }`);
  const result = run('--json', '--identity', '/private-fixture-marker/secret');
  expect(result.status).toBe(1); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, mode: 'online', exitCode: 1,
    checks: [{ code: phase === 'import' ? 'startup_error' : 'unexpected_error' }] });
  expect(result.stdout).not.toContain('PRIVATE_FIXTURE_MARKER');
  expect(result.stdout).not.toContain('/private-fixture-marker'); expect(result.stdout).not.toContain(dir);
});

it('signals an output failure on stderr and exits nonzero when stdout is closed', async () => {
  const { dir } = fixture(false);
  const child = spawn(process.execPath, [join(dir, 'dist', 'bin.js'), 'doctor', '--offline', '--json'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    child.stdout.destroy();
    expect(await closed).toBe(1);
    expect(stderr).toBe('SwarmRelay doctor: could not write diagnostic output.\n');
  } finally { clearTimeout(timer); }
});
