import type { HookManager } from './manager.js';
import { HookError } from './types.js';
import { MAX_DUE_BATCH, validateDueScan, type HookDueCursor, type HookDueStore } from './due.js';
import type { HookEgressClient } from './egress.js';

export interface HookDispatchOptions {
  manager: Pick<HookManager, 'claim' | 'authorizeDispatch' | 'complete'>;
  store: HookDueStore;
  /** Construct with createHookEgressClient; not receiver/agent-supplied results. */
  egress: HookEgressClient;
  after?: HookDueCursor | null;
  limit?: number;
  concurrency?: number;
  maxRunMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}
export interface HookDispatchReport {
  scanned: number; visited: number; claimed: number; submitted: number;
  completed: number; cancelled: number; uncertain: number; errors: number;
  stopped: boolean;
  /** Persist this advisory scan position, including after per-owner failures. Null restarts the sweep. */
  nextCursor: HookDueCursor | null;
}

/** One bounded sweep page; no timer registration, background loop or process-local queue. */
export async function runHookDispatchBatch(options: HookDispatchOptions): Promise<HookDispatchReport> {
  const now = (options.now ?? Date.now)();
  const limit = options.limit ?? 25;
  const concurrency = options.concurrency ?? 4;
  const maxRunMs = options.maxRunMs ?? 25_000;
  validateDueScan(now, limit, options.after);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
      !Number.isSafeInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 25_000) throw new HookError('invalid_dispatch_bounds', 400);
  const report: HookDispatchReport = { scanned: 0, visited: 0, claimed: 0, submitted: 0, completed: 0, cancelled: 0, uncertain: 0, errors: 0, stopped: false, nextCursor: options.after ?? null };
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, maxRunMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    if (controller.signal.aborted) { report.stopped = true; return report; }
    let entries: HookDueCursor[];
    try { entries = await options.store.scanDue(now, limit, options.after); }
    catch { throw new HookError('hook_due_unavailable', 503); }
    // A broken adapter must not turn a bounded invocation into unbounded work.
    if (!Array.isArray(entries) || entries.length > limit || entries.length > MAX_DUE_BATCH) throw new HookError('invalid_due_page', 503);
    let previous = options.after;
    for (const entry of entries) {
      try { validateDueScan(now, limit, entry); } catch { throw new HookError('invalid_due_page', 503); }
      if (!entry || entry.dueAt > now || (previous && (entry.dueAt < previous.dueAt || (entry.dueAt === previous.dueAt && entry.agentId <= previous.agentId)))) throw new HookError('invalid_due_page', 503);
      previous = entry;
    }
    report.scanned = entries.length;
    let index = 0;
    const worker = async () => {
      while (!controller.signal.aborted && index < entries.length) {
        const entry = entries[index++];
        report.visited++;
        try {
          const claim = await options.manager.claim(entry.agentId);
          if (!claim) continue;
          report.claimed++;
          let completed = false;
          for (let attempt = 0; attempt < 2 && !controller.signal.aborted; attempt++) {
            const job = await options.manager.authorizeDispatch(entry.agentId, claim.jobId);
            if (!job) { report.cancelled++; completed = true; break; }
            if (controller.signal.aborted) break;
            report.submitted++;
            const outcome = await options.egress.submit(job, controller.signal);
            if (outcome.kind === 'result') {
              const result = await options.manager.complete(entry.agentId, job.jobId, outcome.result);
              if (result.applied) report.completed++;
              else report.cancelled++;
              completed = true;
              break;
            }
            // At most one replay to the SERVICE, reauthorized with the original
            // claim ID/body. Only complete() may schedule a deliberate callback retry.
            if (!outcome.replayable) break;
          }
          if (!completed) report.uncertain++; // leave the claim durable until lease expiry
        } catch {
          // A failed completion may already be committed. Never manufacture a
          // failure result or send another callback to compensate for a DB error.
          report.errors++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
    report.stopped = controller.signal.aborted;
    if (index > 0) report.nextCursor = index < entries.length || entries.length === limit ? entries[index - 1] : null;
    else if (entries.length === 0) report.nextCursor = null;
    return report;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
