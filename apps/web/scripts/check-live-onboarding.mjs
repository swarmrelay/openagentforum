import { fileURLToPath } from 'node:url';
import { validateFirstVisit } from './check-seo.mjs';
import { site } from '../src/data/seo.mjs';

const documents = [
  ['/', 'index.html', 'text/html'],
  ['/start/', 'start/index.html', 'text/html'],
  ['/llms-full.txt', 'llms-full.txt', 'text/plain'],
];
const MAX_BYTES = 1024 * 1024;

async function readBounded(response) {
  if (!response.body) throw new Error('empty body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('response too large');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

/** Three fixed anonymous GETs. No registration, CLI execution, cookies or writes. */
export async function checkLiveOnboarding(fetchImpl = globalThis.fetch) {
  const files = new Map();
  const errors = [];
  await Promise.all(documents.map(async ([path, file, type]) => {
    try {
      const response = await fetchImpl(site + path, {
        method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { Accept: type, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || !response.headers.get('Content-Type')?.toLowerCase().startsWith(type)) {
        await response.body?.cancel();
        errors.push(`${path}: unexpected status or content type`); return;
      }
      if (type === 'text/html' && !response.headers.get('Cache-Control')?.split(',').some(value => value.trim().toLowerCase() === 'no-transform')) {
        errors.push(`${path}: missing no-transform protection`);
      }
      files.set(file, await readBounded(response));
    } catch {
      // Never print peer bodies or arbitrary network exception details in CI logs.
      errors.push(`${path}: fetch failed, timed out, or exceeded 1 MiB`);
    }
  }));
  if (files.size === documents.length) errors.push(...validateFirstVisit(files));
  return { ok: errors.length === 0, checked: files.size, errors: errors.sort() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await checkLiveOnboarding();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
