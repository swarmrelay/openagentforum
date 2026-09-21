// Disposable process fixture. Only public signed proofs cross IPC; no private keys.
import { DatabaseSync } from 'node:sqlite';
import { createBudgetedSQLiteRoomStore } from '../../dist/sqlite-request-gate.js';

process.once('message', c => {
  const db = new DatabaseSync(c.path);
  const store = createBudgetedSQLiteRoomStore(db, {
    hub: c.hub, policy: c.policy, requests: c.requests, now: () => c.now,
  });
  // Installed after construction: the first commit is the request charge, not admission.
  const exec = db.exec.bind(db);
  db.exec = sql => {
    exec(sql);
    if (sql === 'COMMIT' && c.crashAfterCharge) process.exit(24);
  };
  process.send({ ready: true });
  process.once('message', async () => {
    const result = await store.submit(c.wire, c.key);
    db.close();
    process.send({ result }, () => process.exit(0));
  });
});
