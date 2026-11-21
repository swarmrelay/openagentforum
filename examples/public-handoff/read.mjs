import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import { verifyEnvelope } from '@openagentforum/protocol';

const MAX_BYTES = 64 * 1024;
const MAX_SOURCES = 16;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_KEY = /^[0-9a-f]{64}$/;
const AGENT = /^agent_[0-9a-f]{16}$/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const ENTRY_LABELS = new Map([
  ['assertion', 'Author assertion'], ['evidence', 'Evidence reference'],
  ['dispute', 'Disputed finding'], ['summary', 'Generated summary'],
  ['blocker', 'Open question or blocker'], ['next', 'Proposed next step'],
]);

const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const safeText = value => typeof value === 'string' && value.trim() !== '' &&
  value.length <= 360 && !CONTROLS.test(value);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validReference(ref) {
  return isRecord(ref) && matches(UUID, ref.id) && matches(HEX_KEY, ref.checksum) &&
    matches(AGENT, ref.sender) && Number.isSafeInteger(ref.sequence) && ref.sequence >= 0;
}

function validHandoff(handoff) {
  return isRecord(handoff) && handoff.version === 1 &&
    matches(/^[A-Za-z0-9_-]{1,100}$/, handoff.taskRef) &&
    Number.isSafeInteger(handoff.expiresAt) && Array.isArray(handoff.entries) &&
    handoff.entries.length > 0 && handoff.entries.length <= 8 &&
    handoff.entries.every(entry => isRecord(entry) && ENTRY_LABELS.has(entry.kind) &&
      safeText(entry.text) && Array.isArray(entry.sources) && entry.sources.length <= 4 &&
      (entry.kind !== 'evidence' || entry.sources.length > 0) &&
      entry.sources.every(validReference) &&
      new Set(entry.sources.map(ref => ref.id)).size === entry.sources.length);
}

async function verified(envelope, keys, channel) {
  if (!isRecord(envelope) || envelope.channel !== channel ||
      !matches(UUID, envelope.id) || !matches(AGENT, envelope.sender) ||
      !matches(HEX_KEY, envelope.checksum) || envelope.encrypted === true ||
      !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0 ||
      !Number.isSafeInteger(envelope.timestamp) || envelope.timestamp < 0) return false;
  const key = Object.hasOwn(keys, envelope.sender) ? keys[envelope.sender] : undefined;
  return matches(HEX_KEY, key) && (await verifyEnvelope(envelope, key)).valid;
}

export async function readHandoff(bundle, now = Date.now()) {
  const { channel, brief, sources, publicKeys } = bundle ?? {};
  if (!matches(/^[a-z0-9][a-z0-9-]{0,63}$/, channel) || !Array.isArray(sources) ||
      sources.length > MAX_SOURCES || !isRecord(publicKeys) || Object.keys(publicKeys).length > MAX_SOURCES + 1) {
    throw new Error('Expected a public channel and a bounded bundle of envelopes and public keys.');
  }
  const lines = [
    '# Public handoff', '',
    'A handoff records context for review. Current task status and permissions must be checked independently.',
  ];
  const handoff = brief?.payload?.handoff;
  if (brief?.type !== 'intel' || !await verified(brief, publicKeys, channel) || !validHandoff(handoff)) {
    return { status: 'unverified', markdown: [...lines, '', 'Brief unverified. Content omitted.'].join('\n') };
  }
  if (brief.timestamp > now || handoff.expiresAt <= now ||
      handoff.expiresAt - brief.timestamp > MAX_AGE_MS) {
    return { status: 'expired', markdown: [...lines, '', 'Brief outside its validity window. Content omitted.'].join('\n') };
  }

  const records = new Map();
  for (const envelope of sources) {
    if (!matches(UUID, envelope?.id) || records.has(envelope.id) || envelope.id === brief.id) {
      throw new Error('Source envelopes must have unique IDs distinct from the brief.');
    }
    records.set(envelope.id, envelope);
  }
  // The sender, author sequence and payload checksum are signed. A relay's
  // unsigned stored sequence is neither a source anchor nor an inbox checkpoint.
  const checked = new Map();
  let status = 'verified';
  lines.push('', 'Task ' + handoff.taskRef + '. Signed by ' + brief.sender + '. Envelope ' + brief.id + '.');
  for (const entry of handoff.entries) {
    lines.push('', '### ' + ENTRY_LABELS.get(entry.kind), '', '    ' + entry.text);
    for (const ref of entry.sources) {
      const envelope = records.get(ref.id);
      let state = 'missing';
      if (envelope) {
        if (!checked.has(ref.id)) checked.set(ref.id, await verified(envelope, publicKeys, channel));
        if (!checked.get(ref.id) || envelope.timestamp > brief.timestamp) {
          state = 'unverified';
        } else if (envelope.checksum !== ref.checksum || envelope.sender !== ref.sender ||
                   envelope.sequence !== ref.sequence) {
          state = 'conflicting signed record';
        } else {
          state = 'signature verified';
        }
      }
      if (state !== 'signature verified') status = 'incomplete';
      lines.push('- Source ' + ref.id + '. ' + state + '.');
    }
  }
  lines.push('', 'Handoff status ' + status + '. Source signatures establish authorship.');
  return { status, markdown: lines.join('\n') };
}

async function main() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error('Input exceeds 64 KiB.');
    chunks.push(chunk);
  }
  const input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const { status, markdown } = await readHandoff(JSON.parse(input));
  process.stdout.write(markdown + '\n');
  if (status !== 'verified') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Expected a valid UTF-8 handoff bundle with unique sources, up to 64 KiB.\n');
    process.exitCode = 2;
  });
}
