import type { DeliveryJob, DeliveryResult } from './job.js';
import { AttemptLedger } from './ledger.js';
import type { PullControl } from './pull-control.js';
import { PullJournal } from './pull-journal.js';
import { cleanResult, INDETERMINATE } from './pull-protocol.js';
import { deliver } from './transport.js';

export interface PullRunnerOptions {
  control: PullControl;
  journal: PullJournal;
  ledger: AttemptLedger;
  /** Test seam only. Production always uses the existing checked-IP sender. */
  deliver?: (job: DeliveryJob) => Promise<DeliveryResult>;
}

/** Sequential reference → fresh authorization → reservation → send → durable result → ack. */
export function createPullRunner(options: PullRunnerOptions) {
  const { control, journal, ledger } = options;
  let active = false;
  const report = async (signal: AbortSignal) => {
    const pending = journal.read().pending;
    if (!pending?.result) throw new Error('missing pull outcome');
    await control.complete(pending.ref, pending.result, signal);
    journal.clear(pending.ref);
  };
  return {
    async step(signal: AbortSignal): Promise<'idle' | 'cancelled' | 'reported'> {
      if (active) throw new Error('pull step already running');
      active = true;
      try {
        signal.throwIfAborted();
        const state = journal.read();
        if (state.pending) {
          // A previous invocation stopped somewhere after claim. Never authorize/send
          // from this recovery branch, even if no local reservation is found.
          if (!state.pending.result) journal.result(state.pending.ref,
            cleanResult(ledger.recordedResult(state.pending.ref.jobId), state.pending.ref.kind) ?? INDETERMINATE);
          await report(signal);
          return 'reported';
        }
        const reply = await control.poll(state.after, signal);
        // Commit reference and continuation together BEFORE authorization/callback work.
        journal.accept(reply);
        if (!reply.ref) return 'idle';
        signal.throwIfAborted();
        const job = await control.authorize(reply.ref, signal);
        signal.throwIfAborted();
        if (!job) { journal.clear(reply.ref); return 'cancelled'; }
        const reservation = ledger.reserve(job, Date.now());
        let result: DeliveryResult = INDETERMINATE;
        if (reservation.kind === 'duplicate') result = cleanResult(reservation.result, reply.ref.kind) ?? INDETERMINATE;
        else if (reservation.kind === 'reserved') {
          // No sleeping, buffering or callback retries after authorization. Shutdown
          // lets this bounded (5-second) transport finish; bytes cannot be recalled.
          try { result = cleanResult(await (options.deliver ?? deliver)(job), reply.ref.kind) ?? INDETERMINATE; }
          catch { /* Could have reached the receiver; retain uncertainty, not network_error. */ }
          ledger.complete(job.jobId, result);
        }
        // Conflicts/limits are not transient callback failures and cannot earn a retry.
        journal.result(reply.ref, result);
        signal.throwIfAborted();
        await report(signal);
        return 'reported';
      } finally { active = false; }
    },
  };
}

export function reconnectDelay(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(5, Math.max(0, failures - 1)));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** At most one cycle/second, with bounded backoff. Not a retry-deadline guarantee. */
export async function runPullLoop(runner: ReturnType<typeof createPullRunner>, signal: AbortSignal,
  observe: (event: 'cycle' | 'control_unavailable') => void = () => {}): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    const started = performance.now();
    let pause = 1000;
    try { await runner.step(signal); failures = 0; observe('cycle'); }
    catch {
      if (signal.aborted) break;
      failures = Math.min(6, failures + 1);
      pause = reconnectDelay(failures);
      observe('control_unavailable');
    }
    if (signal.aborted) break;
    // Backoff is after a failed request; healthy cycles are start-to-start limited.
    const wait = failures ? pause : Math.max(0, pause - (performance.now() - started));
    await delay(wait, signal);
  }
}
