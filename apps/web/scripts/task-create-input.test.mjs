import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../functions/_lib/task-create-input.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { readTaskCreateInput } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const valid = { creatorId: 'agent_0123456789abcdef', title: 'Work', description: 'Public offer' };
const read = body => readTaskCreateInput(new Request('https://fixture.invalid/v1/tasks', { method: 'POST', body }));
test('task-create input preserves signed text, defaults and Unicode at the exact bounds', async () => {
  const body = { ...valid, title: ' x ', description: 'z'.repeat(6000), reward: '😀'.repeat(256),
    requiredCapabilities: Array.from({ length: 16 }, (_, i) => `cap${i}`), timeoutMs: 86400000 };
  assert.deepEqual(await read(JSON.stringify(body)), body);
  assert.deepEqual(await read(JSON.stringify(valid)), valid);
});
test('task-create input rejects malformed fields, UTF-8, Unicode, JSON and oversized actual bytes', async () => {
  for (const patch of [{ title: 'x'.repeat(161) }, { description: 'x'.repeat(6001) }, { reward: 'x'.repeat(513) },
    { requiredCapabilities: Array(17).fill('x') }, { requiredCapabilities: ['bad/token'] }, { requiredCapabilities: {} },
    { timeoutMs: 1 }, { timeoutMs: 86400001 }, { timeoutMs: '60000' }, { timeoutMs: 60000.5 },
    { title: {} }, { description: null }, { reward: '' }, { title: 'nul\0' }, { title: '\ud800' }, { creatorId: 'not-an-id' }]) {
    await assert.rejects(read(JSON.stringify({ ...valid, ...patch })), e => e.status === 400);
  }
  for (const raw of ['null', '[]', '{', Uint8Array.of(255), '\ufeff' + JSON.stringify(valid)]) {
    await assert.rejects(read(raw), e => e.status === 400);
  }
  await assert.rejects(read(' '.repeat(49153)), e => e.status === 413);
});
test('task-create input cancels excessive empty chunks without waiting for cancellation', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); }, cancel() { cancelled = true; return new Promise(() => {}); } });
  await assert.rejects(readTaskCreateInput(new Request('https://fixture.invalid', { method: 'POST', body, duplex: 'half' })), e => e.status === 400);
  assert.equal(cancelled, true); assert.equal(body.locked, false);
});
