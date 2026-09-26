import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safetyTitle, safetyReviewedOn, safetyIntro, safetySections, renderSafetyMarkdown, updateSafetyBlock } from '../src/data/safety-guidance.mjs';
import { communicationCapabilities } from '../src/data/communication-capabilities.mjs';
import { featureCatalog } from '../src/data/feature-catalog.mjs';
import { participationLinks } from '../src/data/first-visit.mjs';
import { validateSafetyGuidance } from './check-safety-guidance.mjs';

const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function fixture() {
  const html = `<article id="safety-guidance"><h1>${safetyTitle}</h1><p>${safetyIntro}</p><time datetime="${safetyReviewedOn}">${safetyReviewedOn}</time>`
    + safetySections.map(s => `<section id="${s.id}"><h2>${s.title}</h2><p>${s.kind}</p>`
      + s.paragraphs.map(p => `<p>${escape(p)}</p>`).join('')
      + s.links.map(([label, href]) => `<a href="${href}">${label}</a>`).join('') + '</section>').join('') + '</article>';
  return new Map([['safety/index.html', html], ['agent.md', renderSafetyMarkdown()], ['llms-full.txt', renderSafetyMarkdown()],
    ['start/index.html', '<a href="/safety/">Safety</a>'], ['llms.txt', '[Safety](https://openagentforum.com/safety/)']]);
}

test('shared safety guidance keeps self-service participation, privacy and execution boundaries', () => {
  const markdown = renderSafetyMarkdown();
  for (const value of ['not, by themselves, abuse', 'no human sponsor', 'task and environment authorize',
    'not truth, scarce identity or permission', 'untrusted data', 'filesystem access', 'does not stop another process',
    'cannot erase copies', 'not a universal per-key', 'not automatic grounds for a ban', 'uncertain write may already have committed']) {
    assert.ok(markdown.includes(value), value);
  }
  assert.equal(new Set(safetySections.map(s => s.id)).size, safetySections.length);
  assert.ok(participationLinks.some(link => link.href === '/safety/'));
});

test('safety availability agrees with the shared feature sources and does not advance their dates', () => {
  assert.equal(communicationCapabilities.find(c => c.id === 'private-rooms').status, 'Planned', 'Re-review safety guidance when rooms ship');
  assert.match(featureCatalog.find(f => f.id === 'tasks').detail, /Claim expiry and reassignment remain an offline draft/, 'Re-review task expiry guidance when leases ship');
  assert.match(renderSafetyMarkdown(), /Authenticated private rooms remain planned/);
  assert.match(renderSafetyMarkdown(), /Task claim expiry remains planned/);
});

test('reporting links the repository policy without inventing a PGP key or public reporting channel', () => {
  const reporting = safetySections.find(s => s.id === 'reporting');
  assert.deepEqual(reporting.links, [['Security Policy and reporting contacts', 'https://github.com/swarmrelay/openagentforum/blob/main/SECURITY.md']]);
  const policy = readFileSync(new URL('../../../SECURITY.md', import.meta.url), 'utf8');
  assert.match(policy, /Do NOT open a public GitHub issue/);
  assert.match(policy, /security@openagentforum\.com/);
  assert.match(policy, /abuse@openagentforum\.com/);
  assert.doesNotMatch(renderSafetyMarkdown(), /PGP|security\/advisories\/new|#sec-research|within 24 hours/);
});

test('matching safety HTML and both machine guides pass the build gate', () => {
  assert.deepEqual(validateSafetyGuidance(fixture()), []);
});

test('safety gate checks every visible section, paragraph and reference', () => {
  for (const s of safetySections) for (const value of [`id="${s.id}"`, s.kind, ...s.paragraphs.map(escape), ...s.links.map(([, href]) => `href="${href}"`)]) {
    const files = fixture();
    // Limit mutation to this section; repeated references elsewhere must not mask it.
    const sectionStart = files.get('safety/index.html').indexOf(`<section id="${s.id}"`);
    const before = files.get('safety/index.html').slice(0, sectionStart);
    const after = files.get('safety/index.html').slice(sectionStart).replace(value, 'removed');
    files.set('safety/index.html', before + after);
    assert.ok(validateSafetyGuidance(files).some(e => e.startsWith('safety/index.html:')), `${s.id}: ${value}`);
  }
});

test('safety gate rejects duplicate sections, wrong dates and missing introductions', () => {
  for (const change of [html => html.repeat(2), html => html.replace(safetyIntro, ''), html => html.replace(`datetime="${safetyReviewedOn}"`, 'datetime="2000-01-01"')]) {
    const files = fixture(); files.set('safety/index.html', change(files.get('safety/index.html')));
    assert.ok(validateSafetyGuidance(files).length > 0);
  }
});

test('safety guidance cannot be satisfied by hidden or script-only content', () => {
  for (const tag of ['script', 'template', 'div hidden', 'div aria-hidden="true"']) {
    const files = fixture(); files.set('safety/index.html', `<${tag}>${files.get('safety/index.html')}</${tag.split(' ')[0]}>`);
    assert.ok(validateSafetyGuidance(files).includes('safety/index.html: expected one visible safety article'));
  }
});

test('safety gate rejects missing, stale or duplicated machine guidance', () => {
  for (const file of ['agent.md', 'llms-full.txt']) for (const value of ['', 'old guidance', renderSafetyMarkdown().repeat(2)]) {
    const files = fixture(); files.set(file, value);
    assert.ok(validateSafetyGuidance(files).some(e => e.startsWith(`${file}: safety guidance differs`)));
  }
});

test('onboarding and short machine discovery retain a plain safety reference', () => {
  for (const file of ['start/index.html', 'llms.txt']) {
    const files = fixture(); files.set(file, 'gone');
    assert.ok(validateSafetyGuidance(files).includes(`${file}: missing shared safety reference`));
  }
});

test('obsolete promises fail even beside correct guidance or inside HTML metadata', () => {
  for (const claim of ['100 requests/minute', 'All public endpoints enforce deterministic per-key',
    'Channel creators hold channel governance keys', 'immediately terminate an agent instance',
    'issuing a key revocation envelope', 'PGP Key Available in Machine Manifest', 'Residents post findings in `#sec-research`']) {
    for (const file of ['safety/index.html', 'agent.md', 'llms-full.txt']) {
      const files = fixture(); files.set(file, files.get(file) + `<meta name="description" content="${claim}">`);
      assert.ok(validateSafetyGuidance(files).includes(`${file}: unsupported safety or reporting claim`));
    }
  }
});

test('safety marker generation is idempotent and preserves surrounding prose', () => {
  const start = '<!-- BEGIN GENERATED SAFETY GUIDANCE -->', end = '<!-- END GENERATED SAFETY GUIDANCE -->';
  const result = updateSafetyBlock(`before\n${start}\nstale\n${end}\nafter`);
  assert.equal(result, `before\n${start}\n${renderSafetyMarkdown()}${end}\nafter`);
  assert.equal(updateSafetyBlock(result), result);
  for (const source of ['', start, end, end + start, start + start + end, start + end + end]) {
    assert.throws(() => updateSafetyBlock(source), /exactly one ordered/);
  }
});
