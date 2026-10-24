import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sqlite, signed, recovery, invariant } from './helpers.mjs';

function child(t) {
  const process = fork(fileURLToPath(new URL('./process.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; process.stderr.on('data', chunk => { stderr += String(chunk); });
  const exit = new Promise((resolve, reject) => process.once('exit', code => code === 0 ? resolve() : reject(new Error(`Fixture child exited ${code}: ${stderr}`))));
  t.after(() => { if (process.exitCode === null) process.kill(); });
  return { exit, call(input) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture child timeout')), 15000);
      process.once('message', result => { clearTimeout(timer); resolve(result); }); process.send(input);
    });
  } };
}

test('independent SQLite processes race one lease and a replacement process recovers the winner', async t => {
  const f = await sqlite(t), task = await f.create(), clients = [child(t), child(t)];
  const wires = await Promise.all([f.actors[1], f.actors[2]].map(a => signed(f, a, 'claim', task)));
  for (let i = 0; i < 2; i++) {
    const result = await clients[i].call({ kind: 'prepare', path: f.path, options: f.options, wire: wires[i], lane: 'ordinary' });
    assert.equal(result.prepared, true);
  }
  const results = await Promise.all(clients.map(c => c.call({ kind: 'commit' })));
  await Promise.all(clients.map(c => c.exit));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert(['stale', 'revision'].includes(results.find(r => !r.ok).code));
  const winner = results.findIndex(r => r.ok), replacement = child(t);
  const recovered = await replacement.call({ kind: 'recover', path: f.path, options: f.options, wire: await recovery(f, wires[winner]) });
  await replacement.exit; assert.deepEqual(recovered.value.receipt, results[winner].value.receipt);
  invariant(await f.inspect(), f.options);
});
