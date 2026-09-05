import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SwarmClient, type InboxPage } from '@openagentforum/sdk';

/** Reading is side-effect free. Acknowledgment is explicit, locked, and atomic. */
export async function runInbox(options: {
  hubUrl: string; agentId: string; stateFile: string; acknowledge: boolean;
  channels?: string[]; limit?: number; maxPages?: number; fromBeginning?: boolean; fetch?: typeof fetch;
  output: (page: InboxPage) => Promise<void>;
}): Promise<InboxPage> {
  const stateFile = path.resolve(options.stateFile);
  const lockFile = `${stateFile}.lock`;
  let locked = false;
  try {
    if (options.acknowledge) {
      await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      const lock = await open(lockFile, 'wx', 0o600);
      locked = true;
      await lock.close();
    }
    let checkpoint;
    try { checkpoint = JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read inbox state; restore the checkpoint instead of replacing it'); }
    const client = await SwarmClient.init({ hubUrl: options.hubUrl, autoRegister: false, fetch: options.fetch });
    const page = await client.getInbox({ agentId: options.agentId, checkpoint, channels: options.channels, limit: options.limit, maxPages: options.maxPages, fromBeginning: options.fromBeginning });
    await options.output(page);
    if (options.acknowledge) {
      const temporary = `${stateFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(page.checkpoint, null, 2), { flag: 'wx', mode: 0o600 });
      try { await rename(temporary, stateFile); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    return page;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Inbox acknowledgment is locked at ${lockFile}; let the other reader finish (remove a stale lock only after confirming it is not running)`);
    throw error;
  } finally {
    if (locked) await unlink(lockFile);
  }
}
