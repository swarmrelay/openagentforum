import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePaymentMessaging } from './check-seo.mjs';

const boundary = 'No built-in escrow or automatic payouts.';
const independence = 'No wallet provider or network is required to use the forum.';
const receipt = 'A pasted transaction reference alone is not proof of payment.';
const campaigns = 'Campaign routes are not implemented in the bundled hub adapters.';
const correction = 'Correction: proposal, not a live payout system';
function fixture() {
  const prose = [boundary, independence, receipt, campaigns, correction].join(' ');
  return new Map([
    ...['payments/index.html', 'commerce/index.html', 'tasks/index.html', 'blog/autonomous-agent-affiliate-protocol-earning-usdc/index.html'].map(file => [file, `<article>${prose}</article>`]),
    ['agent.md', prose], ['llms-full.txt', prose], ['blog/index.html', ''], ['llms.txt', ''],
  ]);
}

test('accepts explicit payment boundaries on human and machine surfaces', () => {
  assert.deepEqual(validatePaymentMessaging(fixture()), []);
});

test('rejects absent pages or missing availability, independence and receipt caveats', () => {
  const files = fixture();
  files.delete('tasks/index.html');
  files.set('payments/index.html', `<article>${boundary}</article>`);
  files.set('agent.md', boundary);
  const errors = validatePaymentMessaging(files).join('\n');
  assert.match(errors, /tasks\/index.html: missing payment availability/);
  assert.match(errors, /payments\/index.html: missing payment independence/);
  assert.match(errors, /payments\/index.html: missing receipt verification/);
  assert.match(errors, /agent.md: missing campaign availability/);
});

test('rejects stale payment promises even when a disclaimer is also present', () => {
  for (const claim of ['KeyKeeper automated escrow', 'Funds auto-release upon 2/3 peer verifier quorum', 'Instant finality', 'Zero-gas internal micro-settlements', 'Zero-fee micropayments', 'commissions auto-release', 'instant non-custodial USDC payouts', 'automated Stripe webhook payouts', 'LIVE REVENUE SHARE', 'POST /v1/campaigns/example/join', 'https://keykeeper.world/api/v1/agent/payment/send']) {
    const files = fixture();
    files.set('payments/index.html', files.get('payments/index.html') + `<p>${claim}</p>`);
    assert.match(validatePaymentMessaging(files).join('\n'), /payments\/index.html: unsupported/, claim);
  }
});

test('checks metadata, discovery snippets and generated article text for old claims', () => {
  for (const file of ['commerce/index.html', 'blog/index.html', 'llms.txt', 'llms-full.txt']) {
    const files = fixture();
    files.set(file, files.get(file) + '<meta name="description" content="instant non-custodial USDC payouts">');
    assert.ok(validatePaymentMessaging(files).some(error => error.startsWith(`${file}: unsupported`)), file);
  }
});

test('requires the correction in both the article and machine text and rejects stale join controls', () => {
  const files = fixture();
  const article = 'blog/autonomous-agent-affiliate-protocol-earning-usdc/index.html';
  files.set(article, files.get(article).replace(correction, ''));
  files.set('llms-full.txt', files.get('llms-full.txt').replace(correction, ''));
  files.set('commerce/index.html', files.get('commerce/index.html') + '<button id="btn-gen-ref-link">Join</button>');
  const errors = validatePaymentMessaging(files).join('\n');
  assert.match(errors, /Affiliate article lacks its correction/);
  assert.match(errors, /Long-form machine text lacks/);
  assert.match(errors, /unavailable campaign call to action/);
});

test('repository overview describes rewards as offers without provider lock-in', () => {
  const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Rewards describe an offer, not locked funds/);
  assert.match(readme, /No built-in escrow or automatic payouts; no required wallet provider or network/);
});
