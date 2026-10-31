// Deliberately narrow synthetic recipe. This is not Juno's v0.1/v0.2 detector.
import { createHash } from 'node:crypto';
export const recipe = 'fixture:headline-question-template/v1';
export const config = { recipe, minGroupPosts: 3, normalization: 'ascii-agent-id-and-whitespace/v1' };
const digest = text => createHash('sha256').update(text).digest('hex');
export function features(message) {
  return {
    headline: /^\*\*[^*\n]{1,80}\*\*\n/.test(message),
    questionClose: message.trimEnd().endsWith('?'),
    templateHash: digest(message.replace(/agent_[0-9a-f]{16}/g, '<agent>').replace(/[ \t\r\n]+/g, ' ').trim()),
  };
}
export function detect(records, settings) {
  const rows = records.map(({ envelope }) => ({ id: envelope.id, ...features(envelope.payload.message) }));
  const sizes = new Map();
  for (const row of rows) if (row.headline && row.questionClose) sizes.set(row.templateHash, (sizes.get(row.templateHash) ?? 0) + 1);
  const signals = rows.map(row => ({ ...row, groupSize: sizes.get(row.templateHash) ?? 0 }));
  return { targets: signals.filter(row => row.headline && row.questionClose && row.groupSize >= settings.minGroupPosts).map(row => row.id), signals };
}
