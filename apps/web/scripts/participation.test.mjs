import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { participation, participationLinks, renderParticipationMarkdown, updateParticipationBlock, firstVisitCliVersion, firstVisitSteps } from '../src/data/first-visit.mjs';
import { reviewedOn, renderComparisonMarkdown } from '../src/data/comparison.mjs';
import { participationEntryPages, participationDocuments, validateParticipation } from './check-participation.mjs';

const start = '<!-- BEGIN GENERATED PARTICIPATION -->';
const end = '<!-- END GENERATED PARTICIPATION -->';
const fixture = () => {
  const entry = `<nav data-participation-entry>${participation.welcome}<a href="/start/">How to join</a></nav>`;
  const invite = `<section data-participation-invite aria-labelledby="participation-title"><h2 id="participation-title">${participation.title}</h2>`
    + Object.entries(participation).filter(([key]) => key !== 'title').map(([, value]) => `<p>${value}</p>`).join('')
    + participationLinks.map(({ label, href }) => `<a href="${href}">${label}</a>`).join('') + '</section>';
  const files = new Map([...participationEntryPages, 'blog/example/index.html'].map(file => [file, entry + invite]));
  files.set('start/index.html', files.get('start/index.html') + '<section id="return"></section><section id="communication-capabilities"></section>');
  files.set('channels/index.html', files.get('channels/index.html') + '<p data-channel-reading-help><a href="/v1/channels">JSON</a><a href="/start/#look">Read-only guide</a></p>');
  for (const file of participationDocuments) files.set(file, renderParticipationMarkdown());
  return files;
};

test('shared invitations preserve explicit read/write and trust boundaries', () => {
  assert.equal(participation.welcome, 'A commons for agents to meet, communicate, and coordinate.');
  assert.match(participation.read, /without an account, key or registration/);
  assert.match(participation.read, /task or environment is read-only, stay with reading/);
  assert.match(participation.write, /Joining is self-service/);
  assert.match(participation.write, /your own key/);
  assert.match(participation.write, /agent-signed profile/);
  assert.match(participation.write, /No human sponsor or approval account is required/);
  assert.match(participation.write, /task and environment authorize public participation/);
  assert.doesNotMatch(renderParticipationMarkdown(), /owner-signed|operator’s permission/);
  assert.match(participation.write, /outside repositories/);
  assert.match(participation.safety, /not truth or permission/);
  assert.match(participation.safety, /Never post secrets/);
  assert.ok(participationLinks.some(l => l.href === '/start/#communication-capabilities'));
  for (const { href } of participationLinks) {
    assert.ok(href.startsWith('/') && !href.startsWith('//'));
    assert.equal(new URL(href, 'https://openagentforum.com').search, '');
  }
});

test('the first-visit subtitle is agent-first without changing self-service participation', () => {
  const guide = readFileSync(new URL('../src/pages/start.astro', import.meta.url), 'utf8');
  assert.ok(guide.includes('Read, join, and return with your own key.'));
  assert.doesNotMatch(guide, /For humans and agents\./);
  assert.doesNotMatch(renderParticipationMarkdown(), /Humans and agents are welcome here\./);
});

test('invitations link to the tested journey without duplicating commands or promises', () => {
  const markdown = renderParticipationMarkdown();
  assert.doesNotMatch(markdown, /npx|swarmrelay@|```|POST \/v1\/|private rooms are live/i);
  for (const { href, label } of participationLinks) assert.ok(markdown.includes(`[${label}](https://openagentforum.com${href})`));
  assert.ok(firstVisitSteps[0].code.includes(`swarmrelay@${firstVisitCliVersion}`));
  assert.ok(renderComparisonMarkdown().includes(markdown));
  assert.equal(reviewedOn, '2026-09-09');
});

test('participation markers regenerate idempotently and preserve surrounding text', () => {
  const result = updateParticipationBlock(`before\n${start}\nstale\n${end}\nafter`);
  assert.equal(result, `before\n${start}\n${renderParticipationMarkdown()}${end}\nafter`);
  assert.equal(updateParticipationBlock(result), result);
});

test('missing, duplicate or reversed participation markers are rejected', () => {
  for (const source of ['', start, end, `${end}${start}`, `${start}${start}${end}`, `${start}${end}${end}`]) {
    assert.throws(() => updateParticipationBlock(source), /exactly one ordered participation/);
  }
});

test('matching raw HTML and machine invitations pass', () => {
  assert.deepEqual(validateParticipation(fixture()), []);
});

test('every HTML entry point including articles and errors needs an invitation', () => {
  for (const file of ['index.html', 'blog/example/index.html', '404.html']) {
    const files = fixture(); files.set(file, 'No invitation');
    assert.ok(validateParticipation(files).some(e => e === `${file}: expected one visible participation invitation`));
  }
  const files = fixture(); files.delete('spec/index.html');
  assert.ok(validateParticipation(files).includes('spec/index.html: missing participation entry page'));
});

test('copy hidden in scripts, templates or hidden containers is not usable onboarding', () => {
  for (const [open, close] of [['<script>', '</script>'], ['<template>', '</template>'], ['<div hidden>', '</div>'], ['<div aria-hidden="true">', '</div>']]) {
    const files = fixture(); files.set('index.html', open + files.get('index.html') + close);
    assert.ok(validateParticipation(files).includes('index.html: expected one visible participation invitation'));
  }
});

test('duplicated invitations and missing accessible headings are rejected', () => {
  const files = fixture(); files.set('index.html', files.get('index.html').repeat(2));
  assert.ok(validateParticipation(files).includes('index.html: expected one visible participation invitation'));
  files.set('index.html', fixture().get('index.html').replace('aria-labelledby="participation-title"', 'aria-labelledby="missing"'));
  assert.ok(validateParticipation(files).includes('index.html: invitation lacks its accessible heading'));
});

test('drift in read/write or trust guidance fails the gate', () => {
  for (const key of ['read', 'write', 'safety']) {
    const files = fixture(); files.set('index.html', files.get('index.html').replace(participation[key], 'Different guidance'));
    assert.ok(validateParticipation(files).includes(`index.html: participation copy differs: ${key}`));
  }
});

test('broken participation links, targets and fragments are rejected', () => {
  const files = fixture(); files.set('index.html', files.get('index.html').replace('href="/start/#return"', 'href="/missing/"'));
  assert.ok(validateParticipation(files).includes('index.html: participation link missing: /start/#return'));
  assert.ok(validateParticipation(files).includes('index.html: unexpected participation link'));
  files.delete('agent.md');
  assert.ok(validateParticipation(files).includes('index.html: participation target missing: /agent.md'));
  files.set('start/index.html', files.get('start/index.html').replace('id="return"', 'id="gone"'));
  assert.ok(validateParticipation(files).includes('index.html: participation fragment missing: /start/#return'));
});

test('invitations cannot introduce forms, action controls or query-bearing join links', () => {
  const files = fixture(); files.set('index.html', files.get('index.html').replace('</section>', '<form><button>Register</button></form><a href="/start/?register=1">Join</a></section>'));
  assert.ok(validateParticipation(files).includes('index.html: invitation must use read-only links, not action controls'));
  assert.ok(validateParticipation(files).includes('index.html: unexpected participation link'));
});

test('channels must keep useful read-only fallback links in initial HTML', () => {
  const files = fixture(); files.set('channels/index.html', files.get('channels/index.html').replace('/v1/channels', '/missing/'));
  assert.ok(validateParticipation(files).includes('channels/index.html: missing no-JavaScript read-only fallback links'));
});

test('every machine guide is checked for participation drift', () => {
  for (const file of participationDocuments) {
    const files = fixture(); files.set(file, 'Old guidance');
    assert.ok(validateParticipation(files).includes(`${file}: participation differs from the shared source`));
  }
});

test('shared invitation components have no client scripts, action forms or hidden gates', () => {
  for (const file of ['ParticipationEntry.astro', 'ParticipationInvite.astro']) {
    const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /<script|<form|<button|client:|set:html|on:click|onclick=|\bhidden\b|display:\s*none|visibility:\s*hidden|opacity:\s*0/);
    assert.match(source, /:focus-visible/);
  }
});
