import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateAgentKeyPair, signEnvelope } from '../../packages/protocol/dist/index.js';
import { generateDemo } from './demo.mjs';
import { readBundle, verifyBundle } from './verify.mjs';

let scratch, bundle;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'oaf-label-tests-'));
  const output = await generateDemo(join(scratch, 'demo'));
  assert.equal(output.publicPosts, 0); assert.equal(output.keysSaved, 0);
  bundle = await readBundle(output.bundlePath);
});
after(() => rm(scratch, { recursive: true, force: true }));

test('independent verifier catches the wrong target, then preserves the signed correction and withdrawal', () => {
  const report = verifyBundle(bundle), [initial, corrected] = report.labels;
  assert.equal(report.signatures, 'valid'); assert.equal(initial.recomputeMatches, false);
  assert.equal(initial.witnessState, 'local-recompute-mismatch'); assert.equal(initial.active, false);
  assert.deepEqual(initial.supersededBy, [corrected.id]); assert.deepEqual(initial.retractedBy, ['fixture:retraction']);
  assert.equal(corrected.recomputeMatches, true); assert.equal(corrected.witnessState, 'local-recompute-matches');
  assert.equal(corrected.active, true); assert.deepEqual(corrected.reference, { resolved: 0, unresolved: 1 });
  assert.equal(report.snapshotCoverage, 'provided-records-only'); assert.equal(report.operatorIndependence, 'not-established');
  assert.equal(report.detectorAccuracy, 'not-established'); assert.equal(report.transcript.targets.length, 3);
  assert.equal(bundle.events.length, 5); assert.equal(bundle.records.length, 4);
  assert(!JSON.stringify(bundle).includes('signingPrivateKey'));
});

test('post/signature changes, unsigned relay-position changes and omitted records cannot reuse the old pin', () => {
  for (const [mutate, error] of [
    [b => { b.records[0].envelope.payload.message += 'changed'; }, /payload_checksum/],
    [b => { b.records[0].envelope.signature = '00'.repeat(64); }, /invalid_signature/],
    [b => { b.records[3].storedSeq++; }, /window_pin_mismatch/],
    [b => { b.records.splice(1, 1); }, /window_pin_mismatch/],
    [b => { b.records.reverse(); }, /record_order/],
    [b => { b.events[0].payload.targets.pop(); }, /payload_checksum/],
  ]) {
    const changed = structuredClone(bundle); mutate(changed); assert.throws(() => verifyBundle(changed), error);
  }
});

test('settings and known-answer controls are independently pinned, with no recipe execution', () => {
  const settings = structuredClone(bundle); settings.config.minGroupPosts = 4;
  assert.throws(() => verifyBundle(settings), /detector_pin_mismatch/);
  const recipe = structuredClone(bundle); recipe.config.recipe = 'https://untrusted.invalid/code.mjs';
  assert.throws(() => verifyBundle(recipe), /unknown_recipe_or_config/);
  const controls = structuredClone(bundle); controls.controls[1].expected.questionClose = true;
  assert.throws(() => verifyBundle(controls), /known_answer_control_failed/);
});

test('a valid signature from another full key cannot retract or supersede an author label', async () => {
  const stranger = await generateAgentKeyPair();
  for (const action of ['retract', 'correct']) {
    const changed = structuredClone(bundle); changed.keys.push(stranger.signingPublicKey);
    const target = changed.events[2], payload = action === 'retract'
      ? { kind: 'oaf.label/v0', retracts: target.id, inReplyTo: target.id }
      : { ...target.payload, supersedes: target.id, inReplyTo: target.id };
    const signed = await signEnvelope({ id: 'fixture:stranger:' + action, channel: 'label-fixture', type: 'intel',
      sender: stranger.agentId, timestamp: target.timestamp, payload }, stranger.signingPrivateKey);
    changed.events.push(JSON.parse(JSON.stringify(signed)));
    assert.throws(() => verifyBundle(changed), action === 'retract' ? /retraction_author/ : /correction_author/);
  }
});

test('an absent recompute stays author-asserted, and expiry preserves the historical records', () => {
  const changed = structuredClone(bundle); changed.events = changed.events.filter(e => e.payload.kind !== 'oaf.label-witness/v0');
  assert.equal(verifyBundle(changed).labels[1].witnessState, 'author-asserted-unrecomputed');
  const later = verifyBundle(bundle, bundle.events[2].payload.expiresAt);
  assert(later.labels.every(label => !label.active)); assert.equal(later.labels.length, 2);
  assert.equal(bundle.events.length, 5);
});

test('untrusted bundles have byte/UTF-8/tree bounds and duplicate identities fail closed', async () => {
  const path = join(scratch, 'bad.json'); await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(readBundle(path), /bundle_byte_limit/);
  await writeFile(path, Buffer.from([255])); await assert.rejects(readBundle(path));
  const duplicate = structuredClone(bundle); duplicate.keys.push(duplicate.keys[0]);
  assert.throws(() => verifyBundle(duplicate), /duplicate_or_ambiguous_key/);
  const deep = structuredClone(bundle); let node = deep;
  for (let i = 0; i < 20; i++) node = node.extra = {};
  assert.throws(() => verifyBundle(deep), /bundle_structure_limit/);
});
