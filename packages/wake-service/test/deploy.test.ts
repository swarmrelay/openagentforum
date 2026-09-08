import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRelease } from '../../../deploy/wake/check-release.mjs';
import { buildRelease } from '../../../deploy/wake/build-release.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), 'oaf-wake-artifact-test-')); dirs.push(dir); return dir; }
function artifact() {
  const root = temp();
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'node_modules/dependency'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@openagentforum/wake-service', private: true, dependencies: { dependency: '1.0.0' } }));
  writeFileSync(join(root, 'dist/main.js'), 'throw new Error("must not execute during content checks");');
  writeFileSync(join(root, 'dist/pull-main.js'), 'throw new Error("must not execute during content checks");');
  writeFileSync(join(root, 'node_modules/dependency/package.json'), JSON.stringify({ name: 'dependency', main: 'index.js' }));
  writeFileSync(join(root, 'node_modules/dependency/index.js'), 'module.exports = {};');
  return root;
}
const readTemplate = (name: string) => readFileSync(new URL(`../../../deploy/wake/${name}`, import.meta.url), 'utf8');

describe('opt-in deployment artifacts', () => {
  it('provides a separate listener-free unit with no proxy, port or startup installation', () => {
    const unit = readTemplate('oaf-wake-pull.service');
    for (const setting of ['Conflicts=oaf-wake.service', 'SocketBindDeny=any', 'User=oaf-wake', 'ProtectSystem=strict',
      'StateDirectory=oaf-wake', 'StateDirectoryMode=0700', 'LoadCredential=control-token:/etc/oaf-wake/control-token']) expect(unit.split('\n')).toContain(setting);
    expect(unit).toMatch(/^ExecStart=.*\/dist\/pull-main.js$/m);
    expect(unit).not.toMatch(/^Environment=OAF_WAKE_PORT=|^ExecStart=.*(?:npx|pnpm|\/root\/|curl)/m);
    expect(unit).toContain('OAF_WAKE_CONTROL_ENDPOINT=https://openagentforum.com/internal/wake-control');
  });

  it('builds the real two-package runtime without source, workspace links or development dependencies', () => {
    const root = join(temp(), 'release');
    buildRelease(root);
    expect(() => checkRelease(root)).not.toThrow();
    const wake = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const protocol = JSON.parse(readFileSync(join(root, 'node_modules/@openagentforum/protocol/package.json'), 'utf8'));
    expect(wake.dependencies).toEqual({ '@openagentforum/protocol': protocol.version });
    expect(wake).not.toHaveProperty('devDependencies');
    expect(protocol).not.toHaveProperty('devDependencies');
    expect(readFileSync(join(root, 'PULL.md'), 'utf8')).toContain('never starts a listening socket');
  });

  it('never overwrites an existing output directory', () => {
    const root = temp();
    writeFileSync(join(root, 'preserve'), 'existing data');
    expect(() => buildRelease(root)).toThrow('target must not exist');
    expect(readFileSync(join(root, 'preserve'), 'utf8')).toBe('existing data');
  });

  it('accepts a self-contained package without starting its entrypoint', () => {
    const root = artifact();
    expect(checkRelease(root).root).toContain('oaf-wake-artifact-test-');
  });

  it('allows relative internal dependency links but rejects escaping and dangling links', () => {
    const root = artifact();
    symlinkSync('dependency', join(root, 'node_modules/internal'));
    expect(() => checkRelease(root)).not.toThrow();
    symlinkSync(temp(), join(root, 'node_modules/external'));
    expect(() => checkRelease(root)).toThrow('dependency link escapes artifact');
    const broken = artifact();
    symlinkSync('missing', join(broken, 'node_modules/dangling'));
    expect(() => checkRelease(broken)).toThrow();
  });

  it.each(['.env', 'test', 'src', 'identity.json'])('rejects unexpected top-level %s', name => {
    const root = artifact();
    writeFileSync(join(root, name), 'not a runtime artifact');
    expect(() => checkRelease(root)).toThrow('unexpected top-level content');
  });

  it('rejects an unrelated package or missing entrypoint', () => {
    const root = artifact();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'unrelated', private: true }));
    expect(() => checkRelease(root)).toThrow('wrong package');
    const missing = artifact();
    rmSync(join(missing, 'dist/main.js'));
    expect(() => checkRelease(missing)).toThrow();
  });

  it('ships only runtime output and documentation, not development source', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.private).toBe(true);
    expect(pkg.files).toEqual(['dist', 'README.md', 'PULL.md']);
  });

  it('keeps a static non-root identity, private persistent state and file-backed credentials', () => {
    const unit = readTemplate('oaf-wake.service');
    for (const setting of [
      'User=oaf-wake', 'Group=oaf-wake', 'StateDirectory=oaf-wake', 'StateDirectoryMode=0700',
      'UMask=0077', 'LoadCredential=egress-token:/etc/oaf-wake/egress-token',
      'Environment=OAF_WAKE_TOKEN_FILE=%d/egress-token', 'ProtectSystem=strict', 'ProtectHome=yes',
      'NoNewPrivileges=yes', 'MemoryMax=256M', 'CPUQuota=50%', 'TasksMax=64', 'LimitCORE=0',
    ]) expect(unit.split('\n')).toContain(setting);
    expect(unit).not.toMatch(/^DynamicUser=yes|^MemoryDenyWriteExecute=yes|^PrivateNetwork=yes/m);
    expect(unit).not.toMatch(/^ExecStart=.*(?:npx|pnpm|\/root\/|curl)/m);
    expect(unit).not.toMatch(/^SetCredential=|^Environment=.*Bearer/m);
  });

  it('keeps the proxy deny-by-default, exact-path, single-backend and secret-safe', () => {
    const proxy = readTemplate('apache-vhost.conf.example');
    expect(proxy).toContain('ServerName wake-egress.example.invalid');
    expect(proxy).toContain('ProxyRequests Off');
    expect(proxy).toContain('ProxyPassInherit Off');
    expect(proxy).toContain('ProxyErrorOverride Off');
    expect(proxy).toContain('CustomLog /dev/null combined');
    expect(proxy).toContain('SecAuditEngine Off');
    expect(proxy).toContain('SecRequestBodyAccess Off');
    expect(proxy).toContain('SecResponseBodyAccess Off');
    expect(proxy).toContain('<LocationMatch "^/internal/deliver$">');
    expect(proxy).toContain('<LimitExcept POST>');
    expect(proxy).not.toContain('Require all granted');
    expect(proxy).toContain('disablereuse=On');
    expect(proxy).not.toMatch(/^\s*(?:ProxyPass\s|ProxyPassMatch\s.*healthz|BalancerMember|ProxyRemote|CacheEnable)/m);
    expect(proxy.match(/^\s*ProxyPassMatch /gm)).toHaveLength(1);
    const port = readTemplate('oaf-wake.service').match(/^Environment=OAF_WAKE_PORT=(\d+)$/m)![1];
    expect(proxy).toContain(`http://127.0.0.1:${port}/internal/deliver`);
  });
});
