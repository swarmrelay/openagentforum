import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';
import { readHandoff } from './read.mjs';

const author = await generateAgentKeyPair();
const peer = await generateAgentKeyPair();
const publicKeys = Object.fromEntries([author, peer].map(key => [key.agentId, key.signingPublicKey]));
const now = Date.now();
const channel = 'public-fixtures';

function sign(payload, { key = author, timestamp = now - 100, sequence = 3, id } = {}) {
  return signEnvelope({
    id, channel, sender: key.agentId, type: 'intel', sequence, timestamp, payload,
  }, key.signingPrivateKey);
}

const source = await sign({ text: 'Original local evidence' }, { key: peer, timestamp: now - 200 });
const { id, checksum, sender, sequence } = source;
const handoff = {
  version: 1, taskRef: 'task_fixture_1', expiresAt: now + 60_000,
  entries: [
    { kind: 'evidence', text: 'A peer retained the sample output.', sources: [{ id, checksum, sender, sequence }] },
    { kind: 'next', text: '![](https://example.com/preview.png)', sources: [] },
  ],
};
const brief = await sign({ handoff });
const bundle = { channel, publicKeys, brief, sources: [source] };

test('renders a complete handoff and quotes proposed work as text', async () => {
  const { status, markdown } = await readHandoff(bundle, now);
  assert.equal(status, 'verified');
  assert.match(markdown, /Evidence reference/);
  assert.match(markdown, /signature verified/);
  assert.match(markdown, /^    !\[\]\(https:\/\/example\.com\/preview\.png\)$/m);
});

test('reports unavailable, unverified and conflicting references', async () => {
  const unavailable = await readHandoff({ ...bundle, sources: [] }, now);
  assert.equal(unavailable.status, 'incomplete');
  assert.match(unavailable.markdown, /missing/);
  const tampered = await readHandoff({
    ...bundle, sources: [{ ...source, payload: { text: 'Changed after signing' } }],
  }, now);
  assert.equal(tampered.status, 'incomplete');
  assert.match(tampered.markdown, /unverified/);
  const replacement = await sign({ text: 'Different signed record' }, { id, key: peer, timestamp: now - 200 });
  const conflict = await readHandoff({ ...bundle, sources: [replacement] }, now);
  assert.equal(conflict.status, 'incomplete');
  assert.match(conflict.markdown, /conflicting signed record/);
});

test('expires a brief and omits the content of an altered brief', async () => {
  const late = await readHandoff(bundle, handoff.expiresAt);
  assert.equal(late.status, 'expired');
  assert.doesNotMatch(late.markdown, /A peer retained/);
  const altered = { ...brief, payload: { handoff: { ...handoff, taskRef: 'altered' } } };
  const failed = await readHandoff({ ...bundle, brief: altered }, now);
  assert.equal(failed.status, 'unverified');
  assert.doesNotMatch(failed.markdown, /altered/);
});

test('ignores relay ordering and rejects bundles with ambiguous source IDs', async () => {
  const result = await readHandoff({ ...bundle, sources: [{ ...source, storedSeq: 999 }] }, now);
  assert.equal(result.status, 'verified');
  assert.doesNotMatch(result.markdown, /999/);
  await assert.rejects(readHandoff({ ...bundle, sources: [source, source] }, now), /unique IDs/);
});

test('CLI distinguishes complete, incomplete and oversized inputs', () => {
  const script = fileURLToPath(new URL('./read.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(run(JSON.stringify(bundle)).status, 0);
  const missing = run(JSON.stringify({ ...bundle, sources: [] }));
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /Handoff status incomplete/);
  const tooLarge = run(' '.repeat(65537));
  assert.equal(tooLarge.status, 2);
  assert.equal(tooLarge.stdout, '');
});
