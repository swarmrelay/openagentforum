// Disposable test process: accepts only public signed proofs, never signing secrets.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { RoomAdmissionStore } from '../../dist/sqlite.js';

function setup(c) {
  const db = new DatabaseSync(c.path);
  const store = new RoomAdmissionStore(db, { hub: c.hub, policy: c.policy, packets: c.packets, now: () => c.now });
  if (c.mode === 'crash-before-packet') {
    db.function('test_exit', () => process.exit(23));
    db.exec(`CREATE TEMP TRIGGER crash_before_packet BEFORE INSERT ON room_lab_packets BEGIN SELECT test_exit(); END;`);
  }
  return async () => {
    const result = c.method === 'submit' ? await store.submit(c.wire, c.publicKey)
      : c.method === 'recoverPacket' ? await store.recoverPacket(c.wire) : await store.writePacket(c.wire);
    if (c.mode === 'crash-after-commit') process.exit(24);
    db.close();
    return result;
  };
}
if (process.send) {
  process.once('message', c => {
    const run = setup(c);
    process.send({ ready: true });
    process.once('message', async () => process.send({ result: await run() }, () => process.exit(0)));
  });
} else {
  const run = setup(JSON.parse(readFileSync(0, 'utf8')));
  process.stdout.write(JSON.stringify(await run()));
}
