import assert from 'node:assert/strict';
import test from 'node:test';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';
import { renderFindings } from './render.mjs';

const author = await generateAgentKeyPair();
const reviewer = await generateAgentKeyPair();
const publicKeys = Object.fromEntries([author, reviewer].map(key => [key.agentId, key.signingPublicKey]));

function sign(payload, key = author) {
  return signEnvelope({ channel: 'fixtures', sender: key.agentId, type: 'intel', payload }, key.signingPrivateKey);
}

const source = await sign({ text: 'Local documentation fixture' });
const finding = {
  version: 1,
  kind: 'finding',
  claim: 'The example declares an explicit version.',
  scope: 'Local fixture only.',
  limitations: 'Deployment was outside this check.',
  evidence: [source.id],
};
const original = await sign({ finding });

test('renders original and independently signed reproduction with their evidence', async () => {
  const reproduction = await sign({ finding: {
    ...finding, kind: 'reproduction', subject: original.id, claim: 'Same result on a second fixture.',
  } }, reviewer);
  const output = await renderFindings({ publicKeys, publicEnvelopes: [source, original, reproduction] });
  assert.match(output, /Same result on a second fixture/);
  assert.ok(output.includes(`reproduction of \`${original.id}\``));
  assert.ok(output.includes(`Evidence \`${source.id}\`. signature verified.`));
  assert.ok(output.includes(reviewer.agentId));
});

test('keeps an author correction and the original without rewriting history', async () => {
  const correction = await sign({ finding: {
    ...finding, kind: 'correction', subject: original.id, claim: 'A second example lacks a version.',
  } });
  const output = await renderFindings({ publicKeys, publicEnvelopes: [source, original, correction] });
  assert.ok(output.includes(finding.claim));
  assert.match(output, /A second example lacks a version/);
  await assert.rejects(renderFindings({ publicKeys, publicEnvelopes: [original, correction, correction] }), /distinct/);
});

test('omits a tampered claim and a correction signed by a different author', async () => {
  const wrongAuthor = await sign({ finding: { ...finding, kind: 'correction', subject: original.id, claim: 'Malicious correction.' } }, reviewer);
  const tampered = { ...original, payload: { finding: { ...finding, claim: 'Tampered content.' } } };
  const failed = await renderFindings({ publicKeys, publicEnvelopes: [tampered] });
  assert.match(failed, /signature failed/);
  assert.doesNotMatch(failed, /Tampered content/);
  const output = await renderFindings({ publicKeys, publicEnvelopes: [original, wrongAuthor] });
  assert.match(output, /unauthenticated relationship/);
  assert.doesNotMatch(output, /Malicious correction/);
});

test('reports missing evidence and unsupported formats', async () => {
  const unsupported = await sign({ finding: { ...finding, version: 2, claim: 'Unknown format.' } });
  const output = await renderFindings({ publicKeys, publicEnvelopes: [original, unsupported] });
  assert.ok(output.includes(`Evidence \`${source.id}\`. unavailable.`));
  assert.match(output, /unsupported finding/);
  assert.doesNotMatch(output, /Unknown format/);
});

test('quotes markup as inert text and omits multiline input', async () => {
  const markup = await sign({ finding: { ...finding, claim: '![](https://example.com/external.png)' } });
  const multiline = await sign({ finding: { ...finding, claim: 'Escape the quoted block\n# New heading' } });
  const output = await renderFindings({ publicKeys, publicEnvelopes: [markup, multiline] });
  assert.match(output, /^    Claim: !\[\]\(/m);
  assert.doesNotMatch(output, /^# New heading$/m);
});
