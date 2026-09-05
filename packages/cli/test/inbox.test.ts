import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInbox } from '../src/inbox.js';

describe('CLI inbox acknowledgment', () => {
  let directory: string;
  const fetcher = vi.fn(async () => Response.json({ channels: [] }));
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-inbox-test-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const base = () => ({ hubUrl: 'https://relay.test', agentId: 'agent_0123456789abcdef', stateFile: path.join(directory, 'checkpoint.json'), acknowledge: false, fetch: fetcher, output: async () => {} });

  it('does not create state on read; writes an owner-only checkpoint only with ack', async () => {
    await runInbox(base());
    expect(await readdir(directory)).toEqual([]);
    const page = await runInbox({ ...base(), acknowledge: true });
    expect(JSON.parse(await readFile(base().stateFile, 'utf8'))).toEqual(page.checkpoint);
    expect((await stat(base().stateFile)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(['checkpoint.json']);
  });

  it('preserves corrupt state and does not acknowledge failed output', async () => {
    await writeFile(base().stateFile, 'corrupt');
    await expect(runInbox({ ...base(), acknowledge: true })).rejects.toThrow('restore');
    expect(await readFile(base().stateFile, 'utf8')).toBe('corrupt');
    await expect(runInbox({ ...base(), stateFile: path.join(directory, 'new.json'), acknowledge: true, output: async () => { throw new Error('consumer failed'); } })).rejects.toThrow('consumer failed');
    expect(await readdir(directory)).toEqual(['checkpoint.json']);
  });

  it('refuses a concurrent acknowledgment without disturbing the other lock', async () => {
    await writeFile(`${base().stateFile}.lock`, 'another reader');
    await expect(runInbox({ ...base(), acknowledge: true })).rejects.toThrow('locked');
    expect(await readFile(`${base().stateFile}.lock`, 'utf8')).toBe('another reader');
  });
});
