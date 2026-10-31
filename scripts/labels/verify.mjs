// Independent implementation: no imports from detector.mjs, generator or OAF
// protocol. Only built-in local file/crypto modules; never fetch or execute a recipe.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sha = text => createHash('sha256').update(text).digest('hex');
const need = (condition, code) => { if (!condition) throw new Error(code); };
const hex = (s, n) => typeof s === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(s);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const exact = (o, fields) => o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).length === fields.length && fields.every(f => Object.hasOwn(o, f));
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
function bounded(value) {
  let nodes = 0;
  function visit(v, depth) {
    need(++nodes <= 20000 && depth <= 16, 'bundle_structure_limit');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') { need(Number.isFinite(v), 'invalid_number'); return; }
    if (typeof v === 'string') { need(Buffer.byteLength(v) <= 16384, 'string_limit'); return; }
    need(v && typeof v === 'object' && Object.keys(v).length <= 128, 'invalid_structure');
    for (const key of Object.keys(v)) { need(key.length <= 128, 'key_limit'); visit(v[key], depth + 1); }
  }
  visit(value, 0);
}
function verifyEnvelope(envelope, keys) {
  need(exact(envelope, ['id', 'channel', 'sender', 'type', 'sequence', 'timestamp', 'payload', 'signature', 'checksum']), 'envelope_shape');
  need(typeof envelope.id === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(envelope.id)
    && envelope.channel === 'label-fixture' && envelope.type === 'intel'
    && integer(envelope.sequence) && integer(envelope.timestamp), 'envelope_fields');
  const key = keys.get(envelope.sender);
  need(key && hex(envelope.signature, 128) && hex(envelope.checksum, 64), 'signature_encoding');
  need(sha(canonical(envelope.payload)) === envelope.checksum, 'payload_checksum');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key, 'hex')]), format: 'der', type: 'spki' });
  const text = [envelope.id, envelope.channel, envelope.sender, envelope.type, envelope.sequence, envelope.timestamp, envelope.checksum].join('|');
  need(verify(null, Buffer.from(text), publicKey, Buffer.from(envelope.signature, 'hex')), 'invalid_signature');
  return key;
}

// Separate implementation of the published recipe, including its normalization.
function observe(text) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= 4096, 'message_limit');
  const lines = text.split('\n'), first = lines[0];
  const headline = lines.length > 1 && first.startsWith('**') && first.endsWith('**')
    && first.length >= 5 && first.length <= 84 && !first.slice(2, -2).includes('*');
  let end = text.length; while (end > 0 && /\s/u.test(text[end - 1])) end--;
  const questionClose = end > 0 && text[end - 1] === '?';
  let normalized = '';
  for (let i = 0; i < text.length;) {
    if (text.slice(i, i + 6) === 'agent_' && /^[0-9a-f]{16}$/.test(text.slice(i + 6, i + 22))) {
      normalized += '<agent>'; i += 22;
    } else { normalized += text[i]; i++; }
  }
  normalized = normalized.split(/[ \t\r\n]+/).join(' ').trim();
  return { headline, questionClose, templateHash: sha(normalized) };
}
function recompute(records, config) {
  const signals = records.map(({ envelope }) => ({ id: envelope.id, ...observe(envelope.payload.message) }));
  for (const row of signals) row.groupSize = signals.filter(other => other.headline && other.questionClose && other.templateHash === row.templateHash).length;
  return { targets: signals.filter(row => row.headline && row.questionClose && row.groupSize >= config.minGroupPosts).map(row => row.id), signals };
}
export function verifyBundle(bundle, now = Date.now()) {
  bounded(bundle);
  need(exact(bundle, ['kind', 'keys', 'config', 'controls', 'records', 'events']), 'bundle_shape');
  need(bundle.kind === 'oaf.label-demo-bundle/v0', 'bundle_kind');
  need(Array.isArray(bundle.keys) && bundle.keys.length >= 2 && bundle.keys.length <= 32, 'keys_limit');
  const keys = new Map();
  for (const key of bundle.keys) {
    need(hex(key, 64), 'invalid_key'); const id = 'agent_' + sha(key).slice(0, 16);
    need(!keys.has(id), 'duplicate_or_ambiguous_key'); keys.set(id, key);
  }
  const c = bundle.config;
  need(exact(c, ['recipe', 'minGroupPosts', 'normalization']) && c.recipe === 'fixture:headline-question-template/v1'
    && c.normalization === 'ascii-agent-id-and-whitespace/v1' && integer(c.minGroupPosts) && c.minGroupPosts >= 2 && c.minGroupPosts <= 100, 'unknown_recipe_or_config');
  need(Array.isArray(bundle.records) && bundle.records.length > 0 && bundle.records.length <= 100, 'records_limit');
  need(Array.isArray(bundle.events) && bundle.events.length <= 16, 'events_limit');
  const seen = new Set(); let previous = 0;
  for (const row of bundle.records) {
    need(exact(row, ['storedSeq', 'envelope']) && integer(row.storedSeq) && row.storedSeq > previous, 'record_order');
    previous = row.storedSeq; verifyEnvelope(row.envelope, keys);
    need(!seen.has(row.envelope.id), 'duplicate_id'); seen.add(row.envelope.id);
    need(exact(row.envelope.payload, ['message']), 'record_payload');
  }
  need(Array.isArray(bundle.controls) && bundle.controls.length >= 2 && bundle.controls.length <= 12, 'controls_limit');
  let positives = 0, negatives = 0;
  const controls = bundle.controls.map(control => {
    need(exact(control, ['message', 'expected']) && exact(control.expected, ['headline', 'questionClose'])
      && typeof control.expected.headline === 'boolean' && typeof control.expected.questionClose === 'boolean', 'control_shape');
    const { headline, questionClose } = observe(control.message);
    need(headline === control.expected.headline && questionClose === control.expected.questionClose, 'known_answer_control_failed');
    if (headline && questionClose) positives++; else negatives++;
    return { headline, questionClose };
  });
  need(positives && negatives, 'control_coverage');
  const window = { channel: 'label-fixture', fromSeq: bundle.records[0].storedSeq, toSeq: previous, setHash: sha(canonical(bundle.records)) };
  const detector = { recipe: c.recipe, configHash: sha(canonical(c)), controlsDigest: sha(canonical(bundle.controls)) };
  const computed = recompute(bundle.records, c), transcript = { window, detector, ...computed, controls };
  const transcriptHash = sha(canonical(transcript));
  const labels = new Map(), authors = new Map(), witnesses = [], retractions = [];
  for (const event of bundle.events) {
    const key = verifyEnvelope(event, keys); need(!seen.has(event.id), 'duplicate_id'); seen.add(event.id);
    const p = event.payload; authors.set(event.id, key);
    if (p.kind === 'oaf.label/v0' && Object.hasOwn(p, 'retracts')) {
      need(exact(p, ['kind', 'retracts', 'inReplyTo']) && p.retracts === p.inReplyTo && labels.has(p.retracts), 'retraction_target');
      need(authors.get(p.retracts) === key, 'retraction_author');
      labels.get(p.retracts).retractedBy.push(event.id); retractions.push(event.id); continue;
    }
    if (p.kind === 'oaf.label-witness/v0') {
      need(exact(p, ['kind', 'inReplyTo', 'witness', 'transcript', 'transcriptHash', 'outcome']) && labels.has(p.inReplyTo), 'witness_shape');
      need(p.witness === 'local-independent-implementation' && ['match', 'mismatch'].includes(p.outcome), 'witness_kind');
      need(canonical(p.transcript) === canonical(transcript) && p.transcriptHash === transcriptHash, 'witness_transcript');
      const label = labels.get(p.inReplyTo);
      need(p.outcome === (label.recomputeMatches ? 'match' : 'mismatch'), 'witness_outcome');
      const differentKey = key !== authors.get(p.inReplyTo);
      label.witnesses.push({ id: event.id, differentKey, outcome: p.outcome }); witnesses.push(event.id); continue;
    }
    need(p.kind === 'oaf.label/v0', 'unknown_event_kind');
    const fields = ['kind', 'label', 'claim', 'window', 'targets', 'detector', 'signals', 'expiresAt', 'reference'];
    if (Object.hasOwn(p, 'supersedes')) fields.push('supersedes', 'inReplyTo');
    need(exact(p, fields) && p.label === 'template-wave' && p.claim === 'shares template', 'label_shape');
    need(canonical(p.window) === canonical(window), 'window_pin_mismatch');
    need(canonical(p.detector) === canonical(detector), 'detector_pin_mismatch');
    need(Array.isArray(p.targets) && p.targets.length <= 100 && new Set(p.targets).size === p.targets.length
      && p.targets.every(id => bundle.records.some(row => row.envelope.id === id)), 'label_targets');
    need(exact(p.reference, ['resolved', 'unresolved']) && integer(p.reference.resolved) && integer(p.reference.unresolved)
      && p.reference.resolved + p.reference.unresolved <= 100, 'reference_counts');
    need(integer(p.expiresAt) && p.expiresAt > event.timestamp && p.expiresAt - event.timestamp <= 7 * 86400000, 'label_expiry');
    if (p.supersedes) {
      need(p.supersedes === p.inReplyTo && labels.has(p.supersedes), 'correction_target');
      need(authors.get(p.supersedes) === key, 'correction_author');
      labels.get(p.supersedes).supersededBy.push(event.id);
    }
    const recomputeMatches = canonical(p.targets) === canonical(computed.targets) && canonical(p.signals) === canonical(computed.signals);
    labels.set(event.id, { id: event.id, authorKey: key, recomputeMatches, expired: now >= p.expiresAt,
      reference: p.reference, supersededBy: [], retractedBy: [], witnesses: [] });
  }
  return { kind: 'oaf.label-demo-report/v0', signatures: 'valid', snapshotCoverage: 'provided-records-only',
    operatorIndependence: 'not-established', detectorAccuracy: 'not-established', transcript, transcriptHash,
    labels: [...labels.values()].map(label => ({ ...label, active: !label.expired && !label.supersededBy.length && !label.retractedBy.length,
      witnessState: label.witnesses.some(w => w.differentKey && w.outcome === 'match') ? 'local-recompute-matches'
        : label.witnesses.some(w => w.outcome === 'mismatch') ? 'local-recompute-mismatch' : 'author-asserted-unrecomputed' })),
    witnesses, retractions };
}
export async function readBundle(filename) {
  const file = await open(filename, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1); let size = 0;
    for (let reads = 0; ; reads++) {
      need(reads < 4096 && size < buffer.length, 'bundle_byte_limit');
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break; size += bytesRead;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { await file.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    need(process.argv.length === 3, 'usage: node scripts/labels/verify.mjs bundle.json');
    process.stdout.write(JSON.stringify(verifyBundle(await readBundle(process.argv[2])), null, 2) + '\n');
  } catch (error) { process.stderr.write(`Label verification failed: ${error instanceof SyntaxError ? 'invalid_json' : error.message}\n`); process.exitCode = 1; }
}
