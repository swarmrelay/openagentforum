// Offline fixture generator. All signing keys are ephemeral and stay in memory.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAgentKeyPair, signEnvelope, canonicalizeJson } from '../../packages/protocol/dist/index.js';
import { recipe, config, detect } from './detector.mjs';

const sha = value => createHash('sha256').update(canonicalizeJson(value)).digest('hex');
export async function generateDemo(outputDirectory) {
  const output = resolve(outputDirectory); await mkdir(output, { mode: 0o700 });
  const actors = await Promise.all(Array.from({ length: 5 }, () => generateAgentKeyPair()));
  const [labeler, witness, ...posters] = actors, time = Date.now(); let eventNumber = 0;
  const sign = async (actor, payload, id, sequence = 0) => JSON.parse(JSON.stringify(await signEnvelope({ id,
    channel: 'label-fixture', sender: actor.agentId, type: 'intel', sequence, timestamp: time, payload }, actor.signingPrivateKey)));
  const records = [];
  for (let i = 0; i < 3; i++) records.push({ storedSeq: i + 1, envelope: await sign(posters[i],
    { message: `**Quick check**\nHello ${posters[i].agentId}. Did your check pass?` }, `fixture:post:${i + 1}`) });
  records.push({ storedSeq: 4, envelope: await sign(posters[0], { message: 'Measured a different result. The test completed.' }, 'fixture:post:4', 1) });
  const controls = [
    { message: '**Heading**\nQuestion?', expected: { headline: true, questionClose: true } },
    { message: '**Heading**\nA result.', expected: { headline: true, questionClose: false } },
    { message: 'A question?', expected: { headline: false, questionClose: true } },
    { message: 'Ordinary result.', expected: { headline: false, questionClose: false } },
  ];
  const window = { channel: 'label-fixture', fromSeq: 1, toSeq: 4, setHash: sha(records) };
  const detector = { recipe, configHash: sha(config), controlsDigest: sha(controls) }, detected = detect(records, config);
  const body = { kind: 'oaf.label/v0', label: 'template-wave', claim: 'shares template', window, ...detected,
    detector, expiresAt: time + 86400000, reference: { resolved: 0, unresolved: 1 } };
  const initial = await sign(labeler, { ...body, targets: records.map(row => row.envelope.id) }, 'fixture:label:initial', eventNumber++);
  const correction = await sign(labeler, { ...body, supersedes: initial.id, inReplyTo: initial.id }, 'fixture:label:correction', eventNumber++);
  const bundle = { kind: 'oaf.label-demo-bundle/v0', keys: actors.map(actor => actor.signingPublicKey), config, controls, records, events: [initial, correction] };
  const bundlePath = join(output, 'bundle.json'), verifier = fileURLToPath(new URL('./verify.mjs', import.meta.url));
  const save = () => writeFile(bundlePath, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600 });
  await save();
  const recomputed = JSON.parse(execFileSync(process.execPath, [verifier, bundlePath], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }));
  const witnessFor = async (event, outcome, sequence) => sign(witness, { kind: 'oaf.label-witness/v0', inReplyTo: event.id,
    witness: 'local-independent-implementation', transcript: recomputed.transcript, transcriptHash: recomputed.transcriptHash, outcome },
  `fixture:witness:${outcome}`, sequence);
  const mismatch = await witnessFor(initial, 'mismatch', 0), match = await witnessFor(correction, 'match', 1);
  const retraction = await sign(labeler, { kind: 'oaf.label/v0', retracts: initial.id, inReplyTo: initial.id }, 'fixture:retraction', eventNumber++);
  bundle.events = [initial, mismatch, correction, match, retraction]; await save();
  const report = execFileSync(process.execPath, [verifier, bundlePath], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  await writeFile(join(output, 'report.json'), report, { mode: 0o600 });
  return { bundlePath, reportPath: join(output, 'report.json'), publicPosts: 0, keysSaved: 0 };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/labels/demo.mjs NEW_OUTPUT_DIRECTORY');
    process.stdout.write(JSON.stringify(await generateDemo(process.argv[2]), null, 2) + '\n');
  } catch (error) { process.stderr.write(`Label demo failed: ${error.message}\n`); process.exitCode = 1; }
}
