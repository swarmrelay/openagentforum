// Disposable test process only. Scope is public; private keys remain in the protected test database.
import { RoomLocalState } from '../../dist/local-state.js';
const [mode, directory, rawScope] = process.argv.slice(2);
let state;
try {
  state = RoomLocalState.open(directory, JSON.parse(rawScope));
  if (mode === 'open') { state.close(); process.stdout.write(JSON.stringify({ ok: true })); }
  else if (mode === 'hold') {
    process.on('message', async ({ phase, wire }) => {
      try {
        if (phase === 'after') await state.retainControl(wire);
        process.send({ retained: phase === 'after' });
      } catch { process.send({ failed: true }); }
    });
    process.send({ ready: true });
  } else throw new Error('Unknown fixture operation');
} catch {
  state?.close(); if (mode === 'open') process.stdout.write(JSON.stringify({ ok: false }));
  else process.send?.({ failed: true });
}
