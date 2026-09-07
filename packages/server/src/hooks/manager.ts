import {
  HOOK_LIMITS, bytesToHex, validateHookSpec, verifyHookAction, verifyEnvelope, hookMatches,
  type HookSpec, type StoredEnvelope, type WakeBody,
} from '@openagentforum/protocol';
import { HookCipher } from './cipher.js';
import {
  HookError, STATE_LIMITS, type HookState, type HookRecord, type HookWork, type HookManagerOptions,
  type HookMutation, type HookProof, type HookDispatchJob, type HookDeliveryResult,
} from './types.js';

const HOUR = 3600_000;
const EXPIRY = HOOK_LIMITS.expiryDays * 24 * HOUR;
const idPattern = /^agent_[a-f0-9]{16}$/;

function disable(hook: HookRecord, reason: string) {
  hook.disabledReason = reason;
  hook.lastError = reason;
  hook.verification = null;
  hook.retry = null;
  hook.claim = null;
  for (const slot of hook.channels) slot.pending = null;
}

function failed(hook: HookRecord, work: HookWork, reason: string) {
  hook.failures++;
  hook.lastError = reason;
  if (work.kind === 'verify') disable(hook, reason);
  else if (hook.failures >= HOOK_LIMITS.failuresToDisable) disable(hook, 'consecutive_failures');
}

function clean(state: HookState, now: number) {
  state.now = now;
  state.proofs = state.proofs.filter(proof => now - proof.appliedAt < HOOK_LIMITS.proofHorizonMs);
  state.latest = state.latest.filter(slot => state.hooks.some(hook => hook.id === slot.id) || now - slot.timestamp <= HOOK_LIMITS.proofSkewMs || slot.hour >= Math.floor(now / HOUR));
  for (const hook of state.hooks) {
    if (hook.disabledReason) continue;
    if (now >= hook.expiresAt) { disable(hook, 'expired'); continue; }
    if (hook.claim && now >= hook.claim.leaseUntil) {
      const work = hook.claim.work;
      hook.claim = null;
      failed(hook, work, 'indeterminate'); // reservation may have reached egress; never resend
    }
    if (hook.disabledReason) continue;
    if (hook.retry && now > hook.retry.dueAt + STATE_LIMITS.retryGraceMs) {
      const retry = hook.retry;
      hook.retry = null;
      failed(hook, retry, 'retry_expired');
    }
    if (hook.verification && now - hook.verification.queuedAt > STATE_LIMITS.queuedMs) disable(hook, 'verification_expired');
    for (const slot of hook.channels) if (slot.pending && now - slot.pending.queuedAt > STATE_LIMITS.queuedMs) slot.pending = null;
    const hour = Math.floor(now / HOUR);
    if (hook.hour !== hour) { hook.hour = hour; hook.attempts = 0; }
  }
}

function dueAt(state: HookState): number | null {
  const due: number[] = [];
  for (const hook of state.hooks) {
    if (hook.disabledReason) continue;
    due.push(hook.expiresAt);
    if (hook.claim) { due.push(hook.claim.leaseUntil); continue; }
    const work = hook.retry ? [hook.retry] : hook.verification ? [hook.verification] : hook.channels.flatMap(slot => slot.pending ? [slot.pending] : []);
    const budgetAt = hook.attempts >= HOOK_LIMITS.budgetPerHour ? (hook.hour + 1) * HOUR : 0;
    for (const pending of work) due.push(Math.max(budgetAt, pending.dueAt));
  }
  return due.length ? Math.min(...due) : null;
}

function summary(hook: HookRecord, now: number) {
  const { secret: _secret, ...spec } = hook.spec;
  return {
    hookId: hook.id, ...spec, secretSet: true,
    status: hook.disabledReason ? 'disabled' : hook.verifiedAt === null ? 'pending_verification' : 'active',
    verifiedAt: hook.verifiedAt, expiresAt: hook.expiresAt, createdAt: hook.createdAt,
    disabledReason: hook.disabledReason, failures: hook.failures, lastError: hook.lastError,
    paused: !hook.disabledReason && hook.attempts >= HOOK_LIMITS.budgetPerHour,
    pausedUntil: !hook.disabledReason && hook.attempts >= HOOK_LIMITS.budgetPerHour ? (hook.hour + 1) * HOUR : null,
    pending: Boolean(hook.verification || hook.retry || hook.claim || hook.channels.some(slot => slot.pending)),
    checkedAt: now,
  };
}

/** Shared durable lifecycle. No timers, fetches, automatic dispatch, or in-memory fallback. */
export class HookManager {
  private constructor(private readonly options: HookManagerOptions, private readonly cipher: HookCipher) {}
  static async create(options: HookManagerOptions): Promise<HookManager> {
    return new HookManager(options, await HookCipher.create(options.encryptionKey, options.hub));
  }

  private async load(agentId: string) {
    if (!idPattern.test(agentId)) throw new HookError('invalid_agent_id', 400);
    const row = await this.options.store.read(agentId);
    const state = row ? await this.cipher.open(agentId, row) : { version: 1 as const, now: 0, hooks: [], proofs: [], latest: [] };
    const now = Math.max((this.options.now ?? Date.now)(), state.now);
    if (!Number.isSafeInteger(now) || now < 0) throw new HookError('invalid_clock', 503);
    clean(state, now);
    return { state, revision: row?.revision ?? 0, now };
  }

  private async update<T>(agentId: string, change: (state: HookState, now: number) => Promise<{ value: T; write?: boolean }> | { value: T; write?: boolean }): Promise<T> {
    for (let attempt = 0; attempt < STATE_LIMITS.casAttempts; attempt++) {
      const { state, revision, now } = await this.load(agentId);
      const result = await change(state, now);
      if (result.write === false) return result.value;
      const nextRevision = revision + 1;
      if (!Number.isSafeInteger(nextRevision)) throw new HookError('revision_exhausted', 503);
      const next = { revision: nextRevision, ciphertext: await this.cipher.seal(agentId, nextRevision, state), dueAt: dueAt(state) };
      if (await this.options.store.compareAndSwap(agentId, revision, next)) return result.value;
    }
    throw new HookError('hook_state_busy', 503);
  }

  private async authenticate(input: Parameters<typeof verifyHookAction>[0]): Promise<string> {
    if (!idPattern.test(input.agentId) || !Number.isSafeInteger(input.timestamp)) throw new HookError('invalid_proof', 401);
    const key = await this.options.publicKey(input.agentId);
    if (!key) throw new HookError('invalid_proof', 401);
    // Authenticate first, then enforce freshness for NEW proofs under the state
    // CAS. Applied proofs remain idempotent for their complete 24-hour horizon.
    const result = await verifyHookAction(input, key, { now: input.timestamp });
    if (!result.valid) throw new HookError('invalid_proof', 401);
    return result.proofDigest;
  }

  async list(agentId: string, proof: HookProof) {
    const { timestamp, signature } = proof;
    await this.authenticate({ action: 'list', agentId, timestamp, signature });
    const { state, now } = await this.load(agentId);
    if (Math.abs(now - timestamp) > HOOK_LIMITS.proofSkewMs) throw new HookError('stale_proof', 401);
    // A read never acknowledges work or writes state; expiry is reflected in this snapshot.
    return { hooks: state.hooks.map(hook => summary(hook, now)) };
  }

  async mutate(input: HookMutation) {
    const proof = structuredClone(input);
    if (!['set', 'delete', 'renew'].includes(proof.action)) throw new HookError('invalid_action', 400);
    const digest = await this.authenticate(proof);
    let spec: HookSpec | undefined;
    if (proof.action === 'set') {
      const valid = validateHookSpec(proof.hook);
      if (!valid.ok || (valid.hook.types && (valid.hook.types.length > 16 || new Set(valid.hook.types).size !== valid.hook.types.length))) throw new HookError('invalid_hook', 400);
      spec = valid.hook;
    }
    return this.update(proof.agentId, (state, now) => {
      if (state.proofs.some(entry => entry.digest === digest)) return { value: { alreadyApplied: true, hookId: proof.hookId }, write: false };
      if (Math.abs(now - proof.timestamp) > HOOK_LIMITS.proofSkewMs) throw new HookError('stale_proof', 401);
      const previous = state.latest.find(slot => slot.id === proof.hookId);
      if (previous && proof.timestamp <= previous.timestamp) throw new HookError('superseded', 409);
      const existing = state.hooks.find(hook => hook.id === proof.hookId);
      // Bound the replay log without evicting fresh proofs. Always leave room
      // for deleting the <=3 extant hooks after ordinary writes hit the cap.
      if (state.proofs.length >= STATE_LIMITS.proofs && !(proof.action === 'delete' && existing && state.proofs.length < STATE_LIMITS.proofs + HOOK_LIMITS.perAgent)) throw new HookError('proof_budget', 429);
      if (proof.action === 'set') {
        if (!existing && state.hooks.length >= HOOK_LIMITS.perAgent) throw new HookError('hook_limit', 409);
        const next = this.newHook(proof.hookId, digest, spec!, now, existing?.createdAt);
        if (previous?.hour === next.hour) next.attempts = previous.attempts;
        state.hooks = state.hooks.filter(hook => hook.id !== proof.hookId);
        state.hooks.push(next);
      } else if (proof.action === 'delete') {
        state.hooks = state.hooks.filter(hook => hook.id !== proof.hookId);
      } else {
        if (!existing) throw new HookError('hook_not_found', 404);
        if (existing.disabledReason) throw new HookError('fresh_set_required', 409);
        // Renew repeats URL verification; no stale work survives the new generation.
        const next = this.newHook(existing.id, digest, existing.spec, now, existing.createdAt);
        if (previous?.hour === next.hour) next.attempts = previous.attempts;
        state.hooks = state.hooks.map(hook => hook.id === existing.id ? next : hook);
      }
      state.latest = state.latest.filter(slot => slot.id !== proof.hookId);
      state.latest.push({ id: proof.hookId, timestamp: proof.timestamp, hour: previous?.hour ?? Math.floor(now / HOUR), attempts: previous?.attempts ?? 0 });
      state.proofs.push({ digest, appliedAt: now });
      return { value: { alreadyApplied: false, hookId: proof.hookId } };
    });
  }

  private newHook(id: string, generation: string, spec: HookSpec, now: number, createdAt = now): HookRecord {
    return {
      id, generation, spec, createdAt, expiresAt: now + EXPIRY, verifiedAt: null,
      disabledReason: null, failures: 0, lastError: null, hour: Math.floor(now / HOUR), attempts: 0,
      verification: { id: crypto.randomUUID(), kind: 'verify', nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), dueAt: now, queuedAt: now, attempt: 0 },
      retry: null, claim: null, channels: [],
    };
  }

  /** Internal ingest API: the caller must supply an origin-stored sequence, never a peer SSE cursor. */
  async enqueue(agentId: string, record: StoredEnvelope): Promise<{ queued: number; limited: boolean }> {
    record = structuredClone(record);
    const storedSeq = record.storedSeq;
    if (typeof storedSeq !== 'number' || !Number.isSafeInteger(storedSeq) || storedSeq < 1 || !/^(?:urn:uuid:)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.id)) throw new HookError('invalid_record', 400);
    if (!/^[a-z0-9_-]{1,64}$/.test(record.channel) || !/^[a-z_]{1,32}$/.test(record.type) || !idPattern.test(record.sender)) throw new HookError('invalid_record', 400);
    const key = await this.options.publicKey(record.sender);
    if (!key || !(await verifyEnvelope(record, key)).valid) throw new HookError('invalid_record', 400);
    return this.update(agentId, async (state, now) => {
      let queued = 0;
      let limited = false;
      const access = await this.options.channelAccess(agentId, record.channel);
      for (const hook of state.hooks) {
        if (hook.disabledReason || hook.verifiedAt === null) continue;
        if (!access || (access.isPrivate && !access.isMember)) { this.removeChannel(hook, record.channel); continue; }
        const match = hookMatches(hook.spec, record, { agentId, channelIsPrivate: access.isPrivate, agentIsMember: access.isMember });
        if (!match) continue;
        let slot = hook.channels.find(entry => entry.channel === record.channel);
        if (!slot) {
          if (hook.channels.length >= STATE_LIMITS.channelsPerHook) { limited = true; continue; }
          slot = { channel: record.channel, highSeq: 0, lastDispatchedAt: null, pending: null };
          hook.channels.push(slot);
        }
        if (storedSeq <= slot.highSeq) continue;
        slot.highSeq = storedSeq;
        const hint = { channel: record.channel, storedSeq, envelopeId: record.id, sender: record.sender, type: record.type, mentioned: match.mentioned || Boolean(slot.pending?.hint?.mentioned) };
        const firstDue = slot.lastDispatchedAt === null ? now : Math.max(now, slot.lastDispatchedAt + (hook.spec.coalesceSeconds ?? HOOK_LIMITS.coalesceDefault) * 1000);
        slot.pending = { id: slot.pending?.id ?? crypto.randomUUID(), kind: 'wake', dueAt: slot.pending?.dueAt ?? firstDue, queuedAt: now, attempt: 0, hint };
        queued++;
      }
      return { value: { queued, limited }, write: state.hooks.length > 0 };
    });
  }

  private removeChannel(hook: HookRecord, channel: string) {
    hook.spec.channels = hook.spec.channels.filter(name => name !== channel);
    hook.channels = hook.channels.filter(slot => slot.channel !== channel);
    if (hook.retry?.hint?.channel === channel) hook.retry = null;
    hook.lastError = 'channel_access_removed';
  }

  /** Durable claim is committed before it is returned to any outbound caller. */
  async claim(agentId: string): Promise<HookDispatchJob | null> {
    return this.update(agentId, async (state, now) => {
      for (const hook of state.hooks) {
        if (hook.disabledReason || hook.claim || hook.attempts >= HOOK_LIMITS.budgetPerHour) continue;
        const work = hook.retry ?? hook.verification ?? hook.channels.filter(slot => slot.pending).map(slot => slot.pending!).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!work || work.dueAt > now) continue;
        if (work.kind === 'wake') {
          if (hook.verifiedAt === null || !work.hint?.channel) continue;
          const access = await this.options.channelAccess(agentId, work.hint.channel);
          if (!access || (access.isPrivate && (!access.isMember || !hook.spec.channels.includes(work.hint.channel)))) { this.removeChannel(hook, work.hint.channel); continue; }
        }
        const jobId = crypto.randomUUID();
        const body: WakeBody = work.kind === 'verify'
          ? { kind: 'verify', hub: this.options.hub, hookId: hook.id, agentId, nonce: work.nonce!, sentAt: now }
          : { kind: 'wake', hub: this.options.hub, hookId: hook.id, agentId, ...work.hint!, sentAt: now };
        hook.claim = { jobId, generation: hook.generation, work, body, leaseUntil: now + STATE_LIMITS.leaseMs };
        hook.attempts++;
        const budget = state.latest.find(slot => slot.id === hook.id)!;
        budget.hour = hook.hour;
        budget.attempts = hook.attempts;
        if (hook.retry?.id === work.id) hook.retry = null;
        else if (hook.verification?.id === work.id) hook.verification = null;
        else {
          const slot = hook.channels.find(entry => entry.channel === work.hint?.channel);
          if (slot) { slot.pending = null; slot.lastDispatchedAt = now; }
        }
        return { value: { jobId, url: hook.spec.url, secret: hook.spec.secret, body } };
      }
      return { value: null, write: state.hooks.length > 0 };
    });
  }

  /** Call immediately before egress I/O; a delete/replace/renew invalidates earlier claims. */
  async authorizeDispatch(agentId: string, jobId: string): Promise<HookDispatchJob | null> {
    return this.update(agentId, async (state, now) => {
      const hook = state.hooks.find(entry => entry.claim?.jobId === jobId);
      if (!hook || hook.disabledReason || !hook.claim || hook.claim.generation !== hook.generation) return { value: null, write: state.hooks.length > 0 };
      const claim = hook.claim;
      if (now - claim.body.sentAt >= STATE_LIMITS.leaseMs) return { value: null };
      if (claim.work.kind === 'wake') {
        const channel = claim.work.hint!.channel!;
        const access = await this.options.channelAccess(agentId, channel);
        if (!access || (access.isPrivate && (!access.isMember || !hook.spec.channels.includes(channel)))) {
          hook.claim = null;
          this.removeChannel(hook, channel);
          return { value: null };
        }
      }
      return { value: { jobId, url: hook.spec.url, secret: hook.spec.secret, body: claim.body } };
    });
  }

  /** Only trusted, authenticated egress outcomes belong here; never accept this from a receiver. */
  async complete(agentId: string, jobId: string, result: HookDeliveryResult): Promise<{ applied: boolean }> {
    return this.update<{ applied: boolean }>(agentId, (state, now) => {
      const hook = state.hooks.find(entry => entry.claim?.jobId === jobId);
      if (!hook || !hook.claim || hook.claim.generation !== hook.generation) return { value: { applied: false }, write: state.hooks.length > 0 };
      const { work } = hook.claim;
      const success = result.ok === true && result.retryable === false &&
        (work.kind === 'verify' ? result.code === 'verified' && result.status === 200 : result.code === 'delivered' && Number.isInteger(result.status) && result.status! >= 200 && result.status! < 300);
      const retryable = result.ok === false && result.retryable === true &&
        (['dns_failed', 'network_error', 'timeout'].includes(result.code) || (result.code === 'http_error' && Number.isInteger(result.status) && result.status! >= 500 && result.status! <= 599));
      hook.claim = null;
      if (success) {
        if (work.kind === 'verify') hook.verifiedAt = now;
        hook.failures = 0;
        hook.lastError = null;
      } else if (retryable && work.kind === 'wake' && work.attempt === 0) {
        // Verification has exactly one POST per fresh signed set/renew. A wake
        // permits one explicit retry; never retry an unknown/ambiguous outcome.
        hook.retry = { ...work, id: crypto.randomUUID(), attempt: 1, dueAt: now + 5000, queuedAt: now };
        hook.lastError = result.code;
      } else {
        const known = ['unsafe_url', 'unsafe_address', 'dns_failed', 'timeout', 'network_error', 'tls_error', 'http_error', 'response_too_large', 'invalid_verification', 'indeterminate'];
        failed(hook, work, result.ok === false && known.includes(result.code) ? result.code : 'invalid_egress_result');
      }
      return { value: { applied: true } };
    });
  }
}
