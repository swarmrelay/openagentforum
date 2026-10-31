import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

const CLI = resolve('dist/bin.js');

type Stub = { url: string; hits: string[]; close: () => Promise<void> };

/** A hub stub that answers the two read endpoints and records every path it saw. */
async function stubHub(port = 0): Promise<Stub> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/v1/channels')) {
      res.end(JSON.stringify({ channels: [{ name: 'stub-channel', title: 'Stub channel', messageCount: 3, isPrivate: false }] }));
      return;
    }
    if (req.url?.startsWith('/v1/tasks')) {
      res.end(JSON.stringify({ tasks: [{ id: 'stub-task', title: 'Stub task', requiredCapabilities: ['article'], status: 'open' }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`,
    hits,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** Run the real CLI with a clean hub environment, so only the arguments choose a hub. */
async function runCli(args: string[], env: Record<string, string> = {}, killAfterMs = 15_000) {
  return await new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, SWARM_HUB_URL: undefined, SWARM_IDENTITY: undefined, ...env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.on('close', (code) => { clearTimeout(timer); done({ code, out }); });
  });
}

const servers: Stub[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); });

describe('read commands choose a hub the same way every other command does (#cli-hub-default)', () => {
  it('channels honours --hub instead of assuming a relay on 127.0.0.1:8787', async () => {
    const stub = await stubHub();
    servers.push(stub);
    const { code, out } = await runCli(['channels', '--hub', stub.url]);
    expect(out).toContain('stub-channel');
    expect(out).not.toContain('ECONNREFUSED');
    expect(code).toBe(0);
    expect(stub.hits.some((h) => h.startsWith('/v1/channels'))).toBe(true);
  }, 30_000);

  it('tasks honours SWARM_HUB_URL instead of assuming a relay on 127.0.0.1:8787', async () => {
    const stub = await stubHub();
    servers.push(stub);
    const { code, out } = await runCli(['tasks'], { SWARM_HUB_URL: stub.url });
    expect(out).toContain('stub-task');
    expect(out).not.toContain('ECONNREFUSED');
    expect(code).toBe(0);
    expect(stub.hits.some((h) => h.startsWith('/v1/tasks'))).toBe(true);
  }, 30_000);

  it('does not send an unaddressed read to a local relay standing on the old default port', async () => {
    // A relay on the old default is exactly what a first run used to hit by accident.
    let onOldDefault;
    try {
      onOldDefault = await stubHub(8787);
    } catch {
      return; // port busy in this environment; the --hub and env cases above still cover it
    }
    servers.push(onOldDefault);
    await runCli(['channels'], {}, 8_000);
    expect(onOldDefault.hits).toEqual([]);
  }, 30_000);

  it('help names the public hub as the default, not a local relay', async () => {
    const { out } = await runCli(['help'], {}, 8_000);
    expect(out).toContain('SWARM_HUB_URL=https://openagentforum.com');
    expect(out).not.toContain('Hub/Relay URL (default: http://localhost:8787)');
  }, 30_000);
});