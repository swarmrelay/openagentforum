import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { generateAgentKeyPair, signHookAction, deriveHookId, signEnvelope, bytesToHex, type HookSpec } from '@openagentforum/protocol';
import { HookManager } from '../src/hooks/manager.js';
import { HOOK_STATE_SCHEMA, d1HookStateStore } from '../src/hooks/storage.js';
import { sqliteHookStateStore } from '../src/hooks/sqlite.js';
import type { ChannelAccess, HookMutation } from '../src/hooks/types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export const HUB = 'https://openagentforum.com';

export async function fixture(backend: 'sqlite' | 'd1' = 'sqlite') {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-hook-state-'));
  const path = join(dir, 'state.sqlite');
  let db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(HOOK_STATE_SCHEMA);
  const owner = await generateAgentKeyPair();
  const sender = await generateAgentKeyPair();
  const key = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const clock = { now: Date.UTC(2026, 8, 5, 12) };
  const access = new Map<string, ChannelAccess | null>();
  const publicKeys = new Map([[owner.agentId, owner.signingPublicKey], [sender.agentId, sender.signingPublicKey]]);
  const makeStore = () => {
    if (backend === 'sqlite') return sqliteHookStateStore(db);
    // D1's primary prepared-statement contract backed by actual SQLite, not a
    // map/CAS approximation. Production D1 accepts the same statements/binds.
    const stmt = (sql: string, args: SQLInputValue[] = []): D1PreparedStatement => ({
      bind: (...values: SQLInputValue[]) => stmt(sql, values),
      first: async () => db.prepare(sql).get(...args) ?? null,
      run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    } as D1PreparedStatement);
    return d1HookStateStore({ prepare: (sql: string) => stmt(sql) } as D1Database);
  };
  const makeManager = () => HookManager.create({
    hub: HUB, encryptionKey: key, store: makeStore(), now: () => clock.now,
    publicKey: async id => publicKeys.get(id) ?? null,
    channelAccess: async (_id, channel) => access.has(channel) ? access.get(channel)! : { isPrivate: false, isMember: false },
  });
  let manager = await makeManager();
  const spec = (patch: Partial<HookSpec> = {}): HookSpec => ({ url: 'https://receiver.example.net/wake', channels: ['general'], secret: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), coalesceSeconds: 5, ...patch });
  const proof = async (action: 'set' | 'delete' | 'renew', hookId: string, hook?: HookSpec, timestamp = clock.now): Promise<HookMutation> => {
    const input = { action, agentId: owner.agentId, hookId, timestamp, ...(hook ? { hook } : {}) };
    return { ...input, signature: await signHookAction(input, owner.signingPrivateKey) };
  };
  const setProof = async (hook = spec(), timestamp = clock.now) => proof('set', await deriveHookId(owner.agentId, new URL(hook.url).toString()), hook, timestamp);
  const list = async () => {
    const input = { action: 'list' as const, agentId: owner.agentId, timestamp: clock.now };
    return manager.list(owner.agentId, { timestamp: clock.now, signature: await signHookAction(input, owner.signingPrivateKey) });
  };
  const activate = async (hook = spec()) => {
    const input = await setProof(hook);
    await manager.mutate(input);
    const job = await manager.claim(owner.agentId);
    if (!job) throw new Error('verification job missing');
    await manager.complete(owner.agentId, job.jobId, { ok: true, code: 'verified', retryable: false, status: 200 });
    return input;
  };
  const message = async (storedSeq: number, channel = 'general', payload: unknown = { message: 'test' }, encrypted = false) => ({
    ...await signEnvelope({ sender: sender.agentId, channel, sequence: storedSeq, type: 'intel', payload, ...(encrypted ? { encrypted: true } : {}) }, sender.signingPrivateKey), storedSeq,
  });
  return {
    get manager() { return manager; }, get db() { return db; }, key, clock, owner, sender, access, publicKeys,
    makeStore, makeManager, spec, proof, setProof, list, activate, message,
    async restart() { db.close(); db = new DatabaseSync(path); manager = await makeManager(); },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
