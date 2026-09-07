import { bytesToHex, hexToBytes } from '@openagentforum/protocol';
import { HookError, STATE_LIMITS, type HookState, type StoredHookState } from './types.js';

const encoder = new TextEncoder();

export class HookCipher {
  private constructor(private readonly key: CryptoKey, private readonly hub: string) {}
  static async create(key: string, hub: string): Promise<HookCipher> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new HookError('invalid_encryption_key', 503);
    const parsed = new URL(hub);
    if (parsed.origin !== hub || parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new HookError('invalid_hub_origin', 503);
    return new HookCipher(await crypto.subtle.importKey('raw', hexToBytes(key) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']), hub);
  }

  private aad(agentId: string, revision: number) { return encoder.encode(`oaf-hook-state|1|${this.hub}|${agentId}|${revision}`); }

  async seal(agentId: string, revision: number, state: HookState): Promise<string> {
    const plain = encoder.encode(JSON.stringify(state));
    if (plain.byteLength > STATE_LIMITS.plaintextBytes) throw new HookError('hook_state_full', 429);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad(agentId, revision), tagLength: 128 }, this.key, plain);
    return `v1:${bytesToHex(iv)}:${bytesToHex(new Uint8Array(data))}`;
  }

  async open(agentId: string, row: StoredHookState): Promise<HookState> {
    try {
      if (!Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.ciphertext !== 'string' || row.ciphertext.length > STATE_LIMITS.plaintextBytes * 2 + 64) throw new Error();
      const parts = row.ciphertext.match(/^v1:([a-f0-9]{24}):([a-f0-9]+)$/);
      if (!parts || parts[2].length % 2 !== 0) throw new Error();
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(parts[1]) as BufferSource, additionalData: this.aad(agentId, row.revision), tagLength: 128 }, this.key, hexToBytes(parts[2]) as BufferSource);
      const state: HookState = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
      // This is authenticated internal state, not caller JSON. Reject unsupported
      // versions and gross corruption instead of silently starting fresh.
      if (state.version !== 1 || !Number.isSafeInteger(state.now) || !Array.isArray(state.hooks) || state.hooks.length > 3 || !Array.isArray(state.proofs) || state.proofs.length > STATE_LIMITS.proofs + 3 || !Array.isArray(state.latest)) throw new Error();
      return state;
    } catch { throw new HookError('hook_state_unreadable', 503); }
  }
}
