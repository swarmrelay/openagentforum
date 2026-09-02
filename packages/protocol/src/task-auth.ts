/**
 * Signed task actions (#30 leftover). Creating, claiming, and submitting a
 * bounty are identity-bearing writes: the relay must prove the caller holds
 * the key behind `agentId`, and the signature must bind the content so a
 * captured proof cannot be replayed onto a different task or result.
 *
 *   sign string: task|<action>|<taskId>|<agentId>|<timestamp>|<checksum>
 *   checksum    = sha256(canonicalJson(payload)) where payload is
 *     create: { title, description, requiredCapabilities, timeoutMs, reward }
 *     claim:  {}
 *     submit: { resultPayload }
 *   taskId for `create` is '-' (the relay assigns the id after verifying).
 */
import { canonicalizeJson, sha256Hex, bytesToHex, hexToBytes, importEdPrivateKey, importEdPublicKey, deriveAgentId } from './crypto.js';

export type TaskAction = 'create' | 'claim' | 'submit';

export interface TaskActionParams {
  action: TaskAction;
  /** '-' for create */
  taskId: string;
  agentId: string;
  timestamp: number;
  /** content bound by the signature; see file header for the shape per action */
  payload: Record<string, unknown>;
}

export const TASK_ACTION_SKEW_MS = 5 * 60 * 1000;

export async function taskActionChecksum(payload: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalizeJson(payload));
}

export async function taskActionString(p: TaskActionParams): Promise<string> {
  const checksum = await taskActionChecksum(p.payload);
  return `task|${p.action}|${p.taskId}|${p.agentId}|${p.timestamp}|${checksum}`;
}

export async function signTaskAction(p: TaskActionParams, signingPrivateKeyHex: string): Promise<string> {
  const str = await taskActionString(p);
  const key = await importEdPrivateKey(signingPrivateKeyHex);
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(str));
  return bytesToHex(new Uint8Array(sig));
}

export async function verifyTaskAction(
  p: TaskActionParams & { signature: string },
  publicKeyHex: string,
  opts: { now?: number; skewMs?: number } = {}
): Promise<{ valid: boolean; error?: string }> {
  try {
    const now = opts.now ?? Date.now();
    const skew = opts.skewMs ?? TASK_ACTION_SKEW_MS;
    if (!Number.isFinite(p.timestamp) || Math.abs(now - p.timestamp) > skew) return { valid: false, error: 'timestamp outside the allowed window' };
    if ((await deriveAgentId(publicKeyHex)).toLowerCase() !== p.agentId.toLowerCase()) return { valid: false, error: 'agentId is not the fingerprint of this key' };
    const str = await taskActionString(p);
    const key = await importEdPublicKey(publicKeyHex);
    const ok = await crypto.subtle.verify('Ed25519', key, hexToBytes(p.signature) as BufferSource, new TextEncoder().encode(str));
    return ok ? { valid: true } : { valid: false, error: 'signature does not verify' };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}
