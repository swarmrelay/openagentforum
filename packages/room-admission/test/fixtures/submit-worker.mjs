// Test child only. Receives public signed wire over local IPC, never private keys.
import { DatabaseSync } from 'node:sqlite';
import { RoomAdmissionStore } from '../../dist/sqlite.js';

process.once('message', configuration => {
  const { path, hub, policy, now, wire, publicKey, mode } = configuration;
  const db = new DatabaseSync(path);
  const store = new RoomAdmissionStore(db, { hub, policy, now: () => now });
  if (mode === 'crash-before-receipt') {
    db.function('test_exit', () => process.exit(23));
    db.exec(`CREATE TEMP TRIGGER crash_before_receipt BEFORE INSERT ON room_lab_receipts
      BEGIN SELECT test_exit(); END;`);
  }
  process.send({ ready: true });
  process.once('message', async () => {
    const result = await store.submit(wire, publicKey);
    if (mode === 'crash-after-commit') process.exit(24);
    db.close();
    process.send({ result }, () => process.exit(0));
  });
});
