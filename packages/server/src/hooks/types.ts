import type { HookSpec, WakeBody } from '@openagentforum/protocol';

export const STATE_LIMITS = { proofs: 256, channelsPerHook: 64, plaintextBytes: 256 * 1024, casAttempts: 8, leaseMs: 60_000, queuedMs: 10 * 60_000, retryGraceMs: 5000 };

export class HookError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 404 | 408 | 409 | 413 | 429 | 503) { super(code); }
}

export interface StoredHookState { revision: number; ciphertext: string; dueAt: number | null }
export interface HookStateStore {
  /** Must read from the primary, not an eventually consistent replica/cache. */
  read(agentId: string): Promise<StoredHookState | null>;
  /** Atomic insert-if-absent (expected=0) or UPDATE ... WHERE revision=expected. */
  compareAndSwap(agentId: string, expected: number, next: StoredHookState): Promise<boolean>;
}

export interface HookWork {
  id: string;
  kind: 'verify' | 'wake';
  dueAt: number;
  queuedAt: number;
  attempt: 0 | 1;
  nonce?: string;
  hint?: Pick<WakeBody, 'channel' | 'storedSeq' | 'envelopeId' | 'sender' | 'type' | 'mentioned'>;
}
export interface HookClaim {
  jobId: string;
  generation: string;
  work: HookWork;
  leaseUntil: number;
  body: WakeBody;
}
export interface ChannelSlot { channel: string; highSeq: number; lastDispatchedAt: number | null; pending: HookWork | null }
export interface HookRecord {
  id: string;
  generation: string;
  spec: HookSpec;
  createdAt: number;
  expiresAt: number;
  verifiedAt: number | null;
  disabledReason: string | null;
  failures: number;
  lastError: string | null;
  hour: number;
  attempts: number;
  verification: HookWork | null;
  retry: HookWork | null;
  claim: HookClaim | null;
  channels: ChannelSlot[];
}
export interface HookState {
  version: 1;
  now: number;
  hooks: HookRecord[];
  proofs: { digest: string; appliedAt: number }[];
  latest: { id: string; timestamp: number; hour: number; attempts: number }[];
}

export interface HookDispatchJob { jobId: string; url: string; secret: string; body: WakeBody }
export interface HookDeliveryResult { ok: boolean; code: string; retryable: boolean; status?: number }
export interface ChannelAccess { isPrivate: boolean; isMember: boolean }
export interface HookManagerOptions {
  hub: string;
  /** 32 random bytes as lowercase hex; provision out of band, never commit. */
  encryptionKey: string;
  store: HookStateStore;
  publicKey: (agentId: string) => Promise<string | null>;
  /** Authoritative current access, required at matching AND dispatch. */
  channelAccess: (agentId: string, channel: string) => Promise<ChannelAccess | null>;
  now?: () => number;
}

export interface HookProof { timestamp: number; signature: string }
export type HookMutation = HookProof & { action: 'set' | 'delete' | 'renew'; agentId: string; hookId: string; hook?: HookSpec };
