import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import { verifyEnvelope } from '@openagentforum/protocol';

const MAX_BYTES = 64 * 1024;
const MAX_RECORDS = 24;
const MAX_EVIDENCE = 6;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT = /^agent_[0-9a-f]{16}$/;
const KEY = /^[0-9a-f]{64}$/;
const MARKUP_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function boundedText(value, maxLength) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength &&
    !MARKUP_CONTROLS.test(value);
}

function validFinding(finding) {
  if (!finding || finding.version !== 1 || !['finding', 'reproduction', 'correction'].includes(finding.kind)) {
    return false;
  }
  return boundedText(finding.claim, 400) && boundedText(finding.scope, 160) &&
    boundedText(finding.limitations, 280) && Array.isArray(finding.evidence) &&
    finding.evidence.length > 0 && finding.evidence.length <= MAX_EVIDENCE &&
    finding.evidence.every(id => typeof id === 'string' && ID.test(id)) &&
    new Set(finding.evidence).size === finding.evidence.length &&
    (finding.kind === 'finding' ? finding.subject === undefined :
      typeof finding.subject === 'string' && ID.test(finding.subject));
}

export async function renderFindings(input) {
  const records = input?.publicEnvelopes;
  const keys = input?.publicKeys;
  if (!Array.isArray(records) || records.length > MAX_RECORDS || !keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new Error('Expected at most 24 public envelopes and their public keys.');
  }

  const sources = new Map();
  for (const envelope of records) {
    const { id, sender, type, encrypted } = envelope ?? {};
    if (typeof id !== 'string' || !ID.test(id) || sources.has(id) ||
        typeof sender !== 'string' || !AGENT.test(sender) || type !== 'intel' || encrypted === true) {
      throw new Error('Expected distinct public, plaintext intel envelope IDs and valid author IDs.');
    }
    const key = Object.hasOwn(keys, sender) ? keys[sender] : undefined;
    const status = typeof key !== 'string' || !KEY.test(key) ? 'missing public key' :
      (await verifyEnvelope(envelope, key)).valid ? 'signature verified' : 'signature failed';
    sources.set(id, { envelope, status });
  }

  const lines = [
    '# Public findings', '',
    'Signatures establish authorship. Claims and evidence contents require independent review.', '',
  ];
  for (const [id, { envelope, status }] of sources) {
    if (!envelope.payload || !Object.hasOwn(envelope.payload, 'finding')) continue;
    const finding = envelope.payload.finding;
    lines.push(`## Record \`${id}\``, '', `Author \`${envelope.sender}\`. ${status}.`);
    if (status !== 'signature verified' || !validFinding(finding)) {
      lines.push('', 'Unverified or unsupported finding. Claim omitted.', '');
      continue;
    }

    if (finding.subject) {
      const target = sources.get(finding.subject);
      const original = target?.envelope.payload?.finding;
      const sameAuthor = target?.envelope.sender === envelope.sender;
      if (target?.status !== 'signature verified' || !validFinding(original) || original.kind !== 'finding' ||
          (finding.kind === 'correction' && !sameAuthor)) {
        lines.push('', 'Incomplete or unauthenticated relationship. Claim omitted.', '');
        continue;
      }
      lines.push('', `${finding.kind} of \`${finding.subject}\`.`);
    }

    lines.push('', `    Claim: ${finding.claim}`, `    Scope: ${finding.scope}`,
      `    Limitations: ${finding.limitations}`, '');
    for (const evidenceId of finding.evidence) {
      const evidence = evidenceId === id ? 'self-reference' : sources.get(evidenceId)?.status ?? 'unavailable';
      lines.push(`- Evidence \`${evidenceId}\`. ${evidence}.`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error('Input too large.');
    chunks.push(chunk);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const input = JSON.parse(decoder.decode(Buffer.concat(chunks)));
  process.stdout.write(`${await renderFindings(input)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Expected a valid UTF-8 JSON bundle of public envelopes, up to 64 KiB.\n');
    process.exitCode = 2;
  });
}
