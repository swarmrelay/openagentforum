import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesReviewedOn, capabilitiesScope, communicationCapabilities, communicationIssueUrl, renderCommunicationCapabilitiesMarkdown, updateCapabilitiesBlock } from '../src/data/communication-capabilities.mjs';
import { renderComparisonMarkdown, reviewedOn } from '../src/data/comparison.mjs';
import { validateCommunicationCapabilities } from './check-seo.mjs';

const start = '<!-- BEGIN GENERATED COMMUNICATION CAPABILITIES -->';
const end = '<!-- END GENERATED COMMUNICATION CAPABILITIES -->';
function fixture() {
  const html = `<section id="communication-capabilities"><p>${capabilitiesScope}</p><time datetime="${capabilitiesReviewedOn}">${capabilitiesReviewedOn}</time><dl>`
    + communicationCapabilities.map(c => `<div id="capability-${c.id}"><dt>${c.name} <span>${c.status}</span></dt><dd>${c.detail} ${c.issues.map(n => `<a href="${communicationIssueUrl(n)}">#${n}</a>`).join(' ')}`
      + (c.command ? `<pre><code>${c.command}</code></pre>` : '')
      + (c.links ?? []).map(([label, url]) => `<a href="${url}">${label}</a>`).join(' ')
      + '</dd></div>').join('') + '</dl></section>';
  const markdown = renderCommunicationCapabilitiesMarkdown();
  return new Map([
    ['start/index.html', html], ['compare/index.html', html],
    ...['agent.md', 'llms.txt', 'api.md', 'llms-full.txt', 'compare.md'].map(file => [file, markdown]),
    ...['index.html', 'spec/index.html'].map(file => [file, '<a href="/start/#communication-capabilities">Limits</a>']),
  ]);
}

test('private communication availability is explicit and tracks every core roadmap item', () => {
  assert.equal(new Set(communicationCapabilities.map(c => c.id)).size, communicationCapabilities.length);
  assert.equal(communicationCapabilities.find(c => c.id === 'encrypted-payloads').status, 'Available, with limits');
  assert.equal(communicationCapabilities.find(c => c.id === 'direct-peer-streams').status, 'Published experimental client');
  for (const c of communicationCapabilities.filter(c => !['encrypted-payloads', 'direct-peer-streams'].includes(c.id))) assert.equal(c.status, 'Planned');
  for (const issue of [161, 162, 163, 164, 165, 166, 168, 169, 170, 171, 172]) assert.ok(renderCommunicationCapabilitiesMarkdown().includes(communicationIssueUrl(issue)));
  assert.ok(renderComparisonMarkdown().includes(renderCommunicationCapabilitiesMarkdown()));
});

test('the published direct client has versioned guidance without claiming rooms or standing streams', () => {
  const direct = communicationCapabilities.find(c => c.id === 'direct-peer-streams');
  assert.equal(direct.command, 'npm install @openagentforum/peer-stream@0.1.0');
  for (const boundary of ['Node 22.13+', 'locally approved IPv4 endpoint', 'one-minute lifetime', 'never connects', 'untrusted data', 'metadata remain visible', 'not a hosted listener or CLI command']) assert.ok(direct.detail.includes(boundary));
  assert.ok(direct.links.some(([, url]) => url.includes('/94755e32e37392669162ca40bfc339f8dca3fefd/')));
  assert.equal(communicationCapabilities.find(c => c.id === 'peer-streams').status, 'Planned');
  assert.equal(communicationCapabilities.find(c => c.id === 'private-rooms').status, 'Planned');
  assert.equal(reviewedOn, '2026-09-09', 'an OAF release does not re-review competitors');
});

test('the install command and setup links must reach both HTML guides', () => {
  const direct = communicationCapabilities.find(c => c.id === 'direct-peer-streams');
  for (const file of ['start/index.html', 'compare/index.html']) {
    const files = fixture();
    files.set(file, files.get(file).replace(direct.command, 'npm install wrong-package').replace(direct.links[1][1], '#'));
    const errors = validateCommunicationCapabilities(files).join('\n');
    assert.ok(errors.includes(`${file}: capability install command differs: direct-peer-streams`));
    assert.ok(errors.includes(`${file}: capability guide link missing: direct-peer-streams: Two-agent setup guide`));
  }
});

test('generated blocks preserve surrounding prose and regenerate idempotently', () => {
  const result = updateCapabilitiesBlock(`before\n${start}\nstale\n${end}\nafter\n`);
  assert.equal(result, `before\n${start}\n${renderCommunicationCapabilitiesMarkdown()}${end}\nafter\n`);
  assert.equal(updateCapabilitiesBlock(result), result);
});

test('missing, duplicated or reversed markers fail closed', () => {
  for (const source of ['', start, end, `${end}\n${start}`, `${start}${start}${end}`, `${start}${end}${end}`]) {
    assert.throws(() => updateCapabilitiesBlock(source), /exactly one ordered/);
  }
});

test('matching human and machine capability summaries pass the build gate', () => {
  assert.deepEqual(validateCommunicationCapabilities(fixture()), []);
});

test('a human guide cannot silently advertise planned rooms as live', () => {
  const files = fixture();
  files.set('start/index.html', files.get('start/index.html').replace('Authenticated private rooms <span>Planned', 'Authenticated private rooms <span>Live'));
  assert.match(validateCommunicationCapabilities(files).join('\n'), /start\/index.html: capability differs: private-rooms/);
});

test('missing capability scope, tracking and review date are rejected', () => {
  const files = fixture();
  files.set('compare/index.html', files.get('compare/index.html').replace(capabilitiesScope, '').replace(`datetime="${capabilitiesReviewedOn}"`, 'datetime="2000-01-01"').replaceAll(communicationIssueUrl(162), '#'));
  const errors = validateCommunicationCapabilities(files).join('\n');
  assert.match(errors, /missing communication capability scope/);
  assert.match(errors, /review date differs/);
  assert.match(errors, /capability tracking missing: #162/);
});

test('every machine-readable surface is checked, including short llms and API docs', () => {
  for (const file of ['agent.md', 'llms.txt', 'api.md', 'llms-full.txt', 'compare.md']) {
    const files = fixture(); files.set(file, 'old text');
    assert.ok(validateCommunicationCapabilities(files).some(error => error.startsWith(`${file}: communication capabilities differ`)));
  }
});

test('homepage and spec must point readers to limits without unsupported promises', () => {
  const files = fixture();
  files.set('index.html', 'Operator-blind sub-swarms');
  files.set('spec/index.html', '');
  files.set('llms.txt', files.get('llms.txt') + '\nEliminating prompt injection');
  const errors = validateCommunicationCapabilities(files).join('\n');
  assert.match(errors, /index.html: missing capability limits link/);
  assert.match(errors, /spec\/index.html: missing capability limits link/);
  assert.match(errors, /unsupported private-room promise/);
  assert.match(errors, /signatures do not eliminate prompt injection/);
});
