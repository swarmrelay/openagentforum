import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';

const CLI = resolve('dist/bin.js');
let server: Server | undefined;
afterEach(async () => { await new Promise<void>(done => server ? server.close(() => done()) : done()); server = undefined; });

/** A loopback hub serving one channel record and the author's key; no public traffic. */
async function stubHub(records: Array<Record<string, unknown>>, keys: Map<string, string>) {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/v1/channels/general/messages') {
      const after = Number(url.searchParams.get('after') ?? 0);
      res.end(JSON.stringify({ messages: records.filter(m => (m.storedSeq as number) > after) }));
      return;
    }
    const agent = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname)?.[1];
    if (agent && keys.has(agent)) { res.end(JSON.stringify({ agent: { agentId: agent, publicKey: keys.get(agent) } })); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function run(args: string[]) {
  return new Promise<{ code: number | null; out: string }>(done => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    child.stderr.on('data', chunk => { out += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', code => { clearTimeout(timer); done({ code, out }); });
  });
}

describe('verify with an author-chosen counter far above the record (#377)', () => {
  it('finishes, reports the exact missing count with a bounded preview, and exits 1 for gaps', async () => {
    // The live #general record has an author whose signed sequence jumped from 2 to
    // a Unix timestamp; the published 2.2.0 audit enumerated every missing counter
    // and crashed with "RangeError: Invalid array length".
    const k = await generateAgentKeyPair();
    const records = await Promise.all([0, 1, 2, 4_000_000_000].map(async (sequence, index) => ({
      ...(await signEnvelope({ channel: 'general', sender: k.agentId, type: 'intel', sequence, payload: { message: `m${index}` } }, k.signingPrivateKey)),
      storedSeq: index + 1,
    })));
    const hub = await stubHub(records, new Map([[k.agentId, k.signingPublicKey]]));
    const started = Date.now();
    const text = await run(['verify', 'general', '--hub', hub]);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(text.out).not.toMatch(/RangeError|Invalid array length/);
    expect(text.out).toContain(`observed 0..4000000000  missing 3,999,999,997: 3, 4, 5`);
    expect(text.out).toContain('… 3,999,999,977 more (--json lists the first 1000)');
    expect(text.out.length).toBeLessThan(5000);
    expect(text.code).toBe(1);

    const json = await run(['verify', 'general', '--hub', hub, '--json']);
    const report = JSON.parse(json.out);
    expect(report.gaps[0]).toMatchObject({ observedMin: 0, observedMax: 4_000_000_000, missingCount: 3_999_999_997, missingTruncated: true });
    expect(report.gaps[0].missing).toHaveLength(1000);
    expect(json.code).toBe(1);
  }, 60_000);
});
