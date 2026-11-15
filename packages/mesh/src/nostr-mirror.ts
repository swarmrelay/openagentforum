/**
 * Hub-to-Nostr mirror decisions, kept pure so they can be tested without
 * relays or a running bridge (#240: no public relays in tests).
 *
 * The bridge settles each message before it advances its cursor. Before
 * 0.4.5, a message that no relay accepted held the cursor forever and was
 * retried every few seconds, so one refused event stopped the whole channel
 * (2026-11-15: #general stalled at storedSeq 3437 for about 13 hours). These
 * functions keep the settle-before-advance rule for outages and bound it for
 * refusals.
 */

export type RelayStatus = 'accepted' | 'refused' | 'unavailable';
export interface RelayOutcome {
  relay: string;
  status: RelayStatus;
  /** The relay's OK message, or the local failure. */
  reason?: string;
}

/**
 * Failures raised by nostr-tools 2.25.2 (pinned exactly) rather than by a
 * relay's OK reply. The pool rejects with plain strings for connection
 * problems ("connection failure: …"). These are the Error messages it raises
 * locally: the publish and auth deadlines, a send on a closed socket, and
 * `handleHardClose`'s "relay connection timed out/failed/closed[ by us]",
 * which rejects every open publish when a socket drops. The loopback fixture
 * (test/fixtures/nostr-mirror.mjs) checks each path against the real
 * library, so a rewording in an upgrade fails the tests.
 */
const LOCAL_FAILURE = /^(publish timed out|auth timed out|relay connection |no connection to |Tried to send message )/;
/**
 * NIP-01 machine-readable prefixes that describe the relay's state rather
 * than the event. Everything else a relay says in a negative OK
 * ("invalid:", "blocked:", "pow:", "restricted:", "auth-required:" or free
 * text) is a refusal of this event.
 */
const TRANSIENT_REFUSAL = /^(rate-limited|error):/;

export function classifyPublish(relays: string[], results: PromiseSettledResult<unknown>[]): RelayOutcome[] {
  return results.map((r, i) => {
    const relay = relays[i] ?? `relay#${i}`;
    if (r.status === 'fulfilled') return { relay, status: 'accepted', ...(r.value ? { reason: String(r.value) } : {}) };
    const err = r.reason;
    if (!(err instanceof Error)) return { relay, status: 'unavailable', reason: String(err) };
    if (LOCAL_FAILURE.test(err.message) || TRANSIENT_REFUSAL.test(err.message)) return { relay, status: 'unavailable', reason: err.message };
    return { relay, status: 'refused', reason: err.message };
  });
}

export type MirrorDecision = 'mirrored' | 'hold' | 'skip';

/**
 * - Any relay accepted: the message is mirrored.
 * - Only unavailable relays: hold without limit. Nothing has refused the
 *   event, so skipping it would lose it during an outage.
 * - At least one explicit refusal and no acceptance: hold until
 *   `deadlineMs` after the first refusal, then skip this one message so it
 *   cannot stop the channel.
 */
export function mirrorDecision(outcomes: RelayOutcome[], firstRefusedAtMs: number | undefined, nowMs: number, deadlineMs: number): MirrorDecision {
  if (outcomes.some((o) => o.status === 'accepted')) return 'mirrored';
  if (!outcomes.some((o) => o.status === 'refused')) return 'hold';
  if (firstRefusedAtMs !== undefined && nowMs - firstRefusedAtMs >= deadlineMs) return 'skip';
  return 'hold';
}

export const HOLD_BACKOFF_BASE_MS = 5_000;
export const HOLD_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Capped exponential backoff with equal jitter for the `holds`-th consecutive
 * hold (1-based). The ceiling is 5 s, 10 s, 20 s … up to 5 min; the delay is
 * between half the ceiling and the ceiling. `random` is injectable for tests.
 */
export function holdDelayMs(holds: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(holds));
  const ceiling = Math.min(HOLD_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 30), HOLD_BACKOFF_MAX_MS);
  return Math.round(ceiling * (0.5 + 0.5 * random()));
}

/** One log-friendly line, e.g. `nos.lol=refused(invalid: too old) relay.damus.io=unavailable(connection failure: …)`. */
export function describeOutcomes(outcomes: RelayOutcome[]): string {
  return outcomes
    .map((o) => `${o.relay.replace(/^wss?:\/\//, '')}=${o.status}${o.reason ? `(${o.reason.slice(0, 160)})` : ''}`)
    .join(' ');
}
