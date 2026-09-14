import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateFirstVisit } from './check-seo.mjs';
import { site } from '../src/data/seo.mjs';

const documents = [
  ['/', 'index.html', 'text/html'],
  ['/start/', 'start/index.html', 'text/html'],
  ['/llms-full.txt', 'llms-full.txt', 'text/plain'],
];
const MAX_BYTES = 1024 * 1024;
const DEPLOYMENT_ATTEMPTS = 4;
const DEPLOYMENT_RETRY_MS = 10_000;

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

/**
 * Explicit post-upload mode only. Retry the isolated machine-text mismatch, not
 * HTTP/security/size/HTML failures. Each attempt rechecks all three documents;
 * successful pages are never accumulated across attempts. No deployment writes.
 */
export async function checkDeployedOnboarding({ fetchImpl = globalThis.fetch, wait = delay, onRetry = () => {} } = {}) {
  for (let attempts = 1; attempts <= DEPLOYMENT_ATTEMPTS; attempts++) {
    const result = await checkLiveOnboarding(fetchImpl);
    const retryable = result.checked === documents.length && result.errors.length === 1
      && result.errors[0] === 'Long-form machine text differs from first-visit guide';
    if (result.ok || !retryable || attempts === DEPLOYMENT_ATTEMPTS) return { ...result, attempts };
    onRetry(attempts);
    await wait(DEPLOYMENT_RETRY_MS);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--after-deploy')) {
    console.error('Usage: node apps/web/scripts/check-live-onboarding.mjs [--after-deploy]');
    process.exitCode = 2;
  } else {
    const result = args.length ? await checkDeployedOnboarding({ onRetry: attempt => {
      console.error(`Onboarding attempt ${attempt}/${DEPLOYMENT_ATTEMPTS}: long-form mismatch; rechecking all three documents in ${DEPLOYMENT_RETRY_MS / 1000}s.`);
    } }) : await checkLiveOnboarding();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}
