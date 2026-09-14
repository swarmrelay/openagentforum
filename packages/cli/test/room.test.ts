import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import * as admission from '@openagentforum/room-admission';
import { ROOM_HELP, runRoom } from '../src/room.js';

const START = 1_800_000_000_000;
const HUB = 'https://relay.example.com';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

async function identities(dir: string) {
  const [owner, peer, outsider] = await Promise.all([
    generateAgentKeyPair(), generateAgentKeyPair(), generateAgentKeyPair(),
  ]);
  const write = (name: string, keys: typeof owner) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    return file;
  };
  return {
    owner, peer, outsider,
    ownerFile: write('owner.json', owner),
    peerFile: write('peer.json', peer),
    outsiderFile: write('outsider.json', outsider),
  };
}
async function labFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-cli-room-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o700);
  const lab = join(dir, 'lab');
  const ids = await identities(dir);
  const now = (...extra: string[]) => ['--lab', lab, '--now', String(START), ...extra];
  return { dir, lab, ...ids, now };
}

describe('unpublished swarmrelay room laboratory', () => {
  it('does not publish room-admission or treat historical signatures as admission', () => {
    const cli = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lab = JSON.parse(readFileSync(new URL('../../room-admission/package.json', import.meta.url), 'utf8'));
    expect(cli.dependencies['@openagentforum/room-admission']).toBeUndefined();
    expect(lab.private).toBe(true);
    expect(admission).not.toHaveProperty('authenticateRoomControl');
    expect(typeof admission.verifyHistoricalRoomControlSignature).toBe('function');
    expect(ROOM_HELP).toMatch(/remain Planned/);
    expect(ROOM_HELP).toMatch(/unpublished/);
    expect(ROOM_HELP).not.toMatch(/Available/);
  });

  it('completes two-agent create, invite, accept, Noise round-trip, recovery after expiry, and close', async () => {
    const f = await labFixture();
    const init = await runRoom(['init', ...f.now(), '--hub', HUB]) as { ok: true; planned: true };
    expect(init).toMatchObject({ ok: true, laboratory: true, planned: true, action: 'init' });
    const created = await runRoom(['create', ...f.now(), '--identity', f.ownerFile]) as {
      ok: true; receipt: { roomId: string; action: string; revision: number; status: string };
    };
    expect(created.ok).toBe(true);
    expect(created.receipt).toMatchObject({ action: 'create', revision: 1, status: 'open' });
    const roomId = created.receipt.roomId;
    const invited = await runRoom(['invite', ...f.now(), '--identity', f.ownerFile, '--room', roomId,
      '--recipient-identity', f.peerFile]) as { ok: true; receipt: { action: string; revision: number } };
    expect(invited).toMatchObject({ ok: true, receipt: { action: 'invite', revision: 2 } });
    const accepted = await runRoom(['accept', ...f.now(), '--identity', f.peerFile, '--room', roomId]) as {
      ok: true; receipt: { action: string; status: string };
    };
    expect(accepted).toMatchObject({ ok: true, receipt: { action: 'accept', status: 'open' } });
    const ping = await runRoom(['ping', ...f.now(), '--identity', f.ownerFile, '--peer-identity', f.peerFile,
      '--room', roomId, '--message', 'lab-ping']) as { ok: true; matched: boolean };
    expect(ping).toMatchObject({ ok: true, matched: true, planned: true });
    const recovered = await runRoom(['recover', '--lab', f.lab, '--now', String(START + 120_000),
      '--identity', f.ownerFile, '--room', roomId, '--action', 'create']) as {
      ok: true; receipt: { action: string; status: string; roomId: string }; receiptIsNotCurrentMembership: boolean;
    };
    expect(recovered).toMatchObject({
      ok: true, receiptIsNotCurrentMembership: true,
      receipt: { action: 'create', status: 'open', roomId },
    });
    const closed = await runRoom(['close', '--lab', f.lab, '--now', String(START + 120_000),
      '--identity', f.ownerFile, '--room', roomId]) as { ok: true; receipt: { action: string; status: string } };
    expect(closed).toMatchObject({ ok: true, receipt: { action: 'close', status: 'closed' } });
    const sidecar = JSON.parse(readFileSync(join(f.lab, 'rooms', `${roomId}.json`), 'utf8'));
    expect(sidecar.status).toBe('closed');
    expect(JSON.stringify(sidecar)).not.toContain(f.owner.signingPrivateKey);
    expect(JSON.stringify(sidecar)).not.toContain(f.owner.encryptionPrivateKey);
    expect(JSON.stringify(init)).not.toContain(f.owner.signingPrivateKey);
  });

  it('excludes an outsider from accept, close and ping, and returns unavailable recovery', async () => {
    const f = await labFixture();
    await runRoom(['init', ...f.now(), '--hub', HUB]);
    const created = await runRoom(['create', ...f.now(), '--identity', f.ownerFile]) as { ok: true; receipt: { roomId: string } };
    const roomId = created.receipt.roomId;
    await runRoom(['invite', ...f.now(), '--identity', f.ownerFile, '--room', roomId, '--recipient-identity', f.peerFile]);
    const accept = await runRoom(['accept', ...f.now(), '--identity', f.outsiderFile, '--room', roomId]) as { ok: false; reason: string };
    expect(accept).toMatchObject({ ok: false, reason: 'not_authorized', planned: true });
    await runRoom(['accept', ...f.now(), '--identity', f.peerFile, '--room', roomId]);
    const close = await runRoom(['close', ...f.now(), '--identity', f.outsiderFile, '--room', roomId]) as { ok: false; reason: string };
    expect(close).toMatchObject({ ok: false, reason: 'not_authorized' });
    const ping = await runRoom(['ping', ...f.now(), '--identity', f.ownerFile, '--peer-identity', f.outsiderFile,
      '--room', roomId]) as { ok: false; reason: string };
    expect(ping).toMatchObject({ ok: false, reason: 'not_authorized' });
    const recovered = await runRoom(['recover', ...f.now(), '--identity', f.outsiderFile, '--room', roomId,
      '--action', 'create']) as { ok: true; receipt: null };
    expect(recovered).toMatchObject({ ok: true, receipt: null, receiptIsNotCurrentMembership: true });
  });

  it('keeps a closed tombstone: later invite fails and historical create recovery still works', async () => {
    const f = await labFixture();
    await runRoom(['init', ...f.now(), '--hub', HUB]);
    const created = await runRoom(['create', ...f.now(), '--identity', f.ownerFile]) as { ok: true; receipt: { roomId: string } };
    const roomId = created.receipt.roomId;
    await runRoom(['invite', ...f.now(), '--identity', f.ownerFile, '--room', roomId, '--recipient-identity', f.peerFile]);
    await runRoom(['accept', ...f.now(), '--identity', f.peerFile, '--room', roomId]);
    const closed = await runRoom(['close', ...f.now(), '--identity', f.peerFile, '--room', roomId]) as {
      ok: true; receipt: { status: string; revision: number };
    };
    expect(closed.receipt.status).toBe('closed');
    const invite = await runRoom(['invite', ...f.now(), '--identity', f.ownerFile, '--room', roomId,
      '--recipient-identity', f.peerFile]) as { ok: false; reason: string };
    expect(invite).toMatchObject({ ok: false, reason: 'room_closed' });
    await expect(runRoom(['accept', ...f.now(), '--identity', f.peerFile, '--room', roomId]))
      .rejects.toThrow('No invitation');
    const recovered = await runRoom(['recover', '--lab', f.lab, '--now', String(START + 120_000),
      '--identity', f.ownerFile, '--room', roomId, '--action', 'create']) as {
      ok: true; receipt: { action: string; status: string };
    };
    expect(recovered.receipt).toMatchObject({ action: 'create', status: 'open' });
  });

  it('refuses unknown options and identity creation, and the built CLI exposes laboratory help', async () => {
    const f = await labFixture();
    await expect(runRoom(['init', '--lab', f.lab, '--hub', HUB, '--exec', 'never-run-this'])).rejects.toThrow(/Unknown or repeated/);
    await expect(runRoom(['create', '--lab', f.lab, '--identity', join(f.dir, 'missing.json')])).rejects.toThrow();
    expect(existsSync(join(f.dir, 'missing.json'))).toBe(false);
    const run = (args: string[]) => spawnSync(process.execPath, ['dist/bin.js', 'room', ...args], { encoding: 'utf8', timeout: 10_000 });
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/remain Planned/);
    expect(help.stdout).toMatch(/unpublished/);
    expect(help.stdout + help.stderr).not.toContain('never-run-this');
    const rejected = run(['init', '--lab', f.lab, '--hub', HUB, '--exec', 'never-run-this']);
    expect(rejected.status).toBe(1);
    expect(rejected.stdout + rejected.stderr).not.toContain('never-run-this');
    expect(existsSync(f.lab)).toBe(false);
  });
});
