import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyPublish, mirrorDecision, holdDelayMs, describeOutcomes,
  HOLD_BACKOFF_BASE_MS, HOLD_BACKOFF_MAX_MS, type RelayOutcome,
} from '../src/nostr-mirror.js';
import { envelopeToEvent, verifyCarriedEnvelope, generateSecretKey } from '../src/nostr.js';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/nostr-mirror.mjs', import.meta.url));
const relays = ['wss://a.example', 'wss://b.example', 'wss://c.example'];
const settled = (...rs: Array<['ok', unknown] | ['err', unknown]>): PromiseSettledResult<unknown>[] =>
  rs.map(([k, v]) => (k === 'ok' ? { status: 'fulfilled', value: v } : { status: 'rejected', reason: v }));

describe('hub->Nostr mirror decisions (0.4.5)', () => {
  it('separates relay refusals from local and transient failures', () => {
    const out = classifyPublish(relays, settled(
      ['ok', 'duplicate: have it'],
      ['err', new Error('invalid: event too old')],
      ['err', 'connection failure: connection failed'],
    ));
    expect(out.map((o) => o.status)).toEqual(['accepted', 'refused', 'unavailable']);
    expect(out[1].reason).toBe('invalid: event too old');
    for (const local of ['publish timed out', 'auth timed out', 'relay connection closed', 'relay connection closed by us', 'relay connection failed', 'relay connection timed out', "Tried to send message '[\"EVENT\"] on a closed connection to wss://a.example.", 'rate-limited: slow down', 'error: database busy']) {
      expect(classifyPublish(relays, settled(['err', new Error(local)]))[0].status, local).toBe('unavailable');
    }
    for (const refusal of ['blocked: banned', 'pow: difficulty 20 required', 'restricted: members only', 'auth-required: login', 'spam detected']) {
      expect(classifyPublish(relays, settled(['err', new Error(refusal)]))[0].status, refusal).toBe('refused');
    }
  });

  it('holds without limit while every relay is unavailable, even after an earlier refusal', () => {
    const outage: RelayOutcome[] = relays.map((relay) => ({ relay, status: 'unavailable', reason: 'connection failure' }));
    expect(mirrorDecision(outage, undefined, 1e12, 1000)).toBe('hold');
    expect(mirrorDecision(outage, 0, 1e12, 1000)).toBe('hold');
  });

  it('skips a refused message only after the deadline, and any acceptance mirrors it', () => {
    const refused: RelayOutcome[] = [
      { relay: relays[0], status: 'refused', reason: 'invalid: too old' },
      { relay: relays[1], status: 'unavailable', reason: 'connection failure' },
    ];
    expect(mirrorDecision(refused, undefined, 5000, 1000)).toBe('hold'); // first refusal starts the clock
    expect(mirrorDecision(refused, 5000, 5999, 1000)).toBe('hold');
    expect(mirrorDecision(refused, 5000, 6000, 1000)).toBe('skip');
    expect(mirrorDecision([...refused, { relay: relays[2], status: 'accepted' }], 0, 1e12, 1000)).toBe('mirrored');
  });

  it('backs off exponentially with equal jitter, capped at five minutes', () => {
    expect(holdDelayMs(1, () => 0)).toBe(HOLD_BACKOFF_BASE_MS / 2);
    expect(holdDelayMs(1, () => 0.999999)).toBeLessThanOrEqual(HOLD_BACKOFF_BASE_MS);
    expect(holdDelayMs(2, () => 0)).toBe(HOLD_BACKOFF_BASE_MS);
    expect(holdDelayMs(3, () => 0)).toBe(2 * HOLD_BACKOFF_BASE_MS);
    expect(holdDelayMs(0, () => 0)).toBe(HOLD_BACKOFF_BASE_MS / 2);
    for (const n of [7, 8, 50, 10_000]) expect(holdDelayMs(n, () => 0.999999)).toBeLessThanOrEqual(HOLD_BACKOFF_MAX_MS);
    expect(holdDelayMs(10_000, () => 0)).toBe(HOLD_BACKOFF_MAX_MS / 2);
  });

  it('describes outcomes on one bounded line', () => {
    const line = describeOutcomes([{ relay: 'wss://nos.lol', status: 'refused', reason: 'x'.repeat(500) }, { relay: 'wss://relay.damus.io', status: 'unavailable' }]);
    expect(line.startsWith('nos.lol=refused(' + 'x'.repeat(160) + ')')).toBe(true);
    expect(line.endsWith(' relay.damus.io=unavailable')).toBe(true);
  });

  it('dates the event when it is relayed, keeps the signed timestamp inside, and repeats the same event on retry', async () => {
    const agent = await generateAgentKeyPair();
    const signed = await signEnvelope({ channel: 'general', sender: agent.agentId, type: 'intel', sequence: 0, payload: { message: 'late' } }, agent.signingPrivateKey);
    const late = { ...signed, timestamp: Date.now() - 10 * 3600_000 };
    const sk = generateSecretKey();
    const before = Math.floor(Date.now() / 1000);
    const ev = envelopeToEvent(late as any, agent.signingPublicKey, sk);
    expect(ev.created_at).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(ev.content).envelope.timestamp).toBe(late.timestamp);
    const again = envelopeToEvent(late as any, agent.signingPublicKey, sk, ev.created_at);
    expect(again.id).toBe(ev.id);
    const fresh = envelopeToEvent(signed, agent.signingPublicKey, sk, ev.created_at);
    expect((await verifyCarriedEnvelope(fresh)).valid).toBe(true);
  });
});

describe('hub->Nostr mirror against real loopback sockets (0.4.5)', () => {
  const expected: Record<string, string> = {
    ok: 'accepted', duplicate: 'accepted',
    invalid: 'refused', blocked: 'refused', 'auth-required': 'refused', 'free-text': 'refused',
    'rate-limited': 'unavailable', error: 'unavailable', silent: 'unavailable', drop: 'unavailable', 'closed-port': 'unavailable',
  };
  for (const [name, status] of Object.entries(expected)) {
    it(`classifies a ${name} relay as ${status}`, async () => {
      const { stdout, stderr } = await run(process.execPath, [fixture, `classify:${name}`], { timeout: 12_000, maxBuffer: 64 * 1024 });
      expect(stderr).toBe('');
      expect(stdout.trim()).toMatch(new RegExp(`^ok classify:${name} ${status} `));
    }, 15_000);
  }

  for (const name of ['age-limited', 'refusing']) {
    it(`bridge: ${name} relay`, async () => {
      const { stdout, stderr } = await run(process.execPath, [fixture, `bridge:${name}`], { timeout: 20_000, maxBuffer: 256 * 1024 });
      expect(stderr).toBe('');
      expect(stdout.trim()).toBe(`ok bridge:${name}`);
    }, 25_000);
  }
});
