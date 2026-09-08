import { AttemptLedger } from './ledger.js';
import { createPullControl } from './pull-control.js';
import { PullJournal } from './pull-journal.js';
import { createPullRunner, runPullLoop } from './pull-runner.js';
import { protectedStateFile, readStateConfig, required } from './state-files.js';

let journal: PullJournal | undefined;
let ledger: AttemptLedger | undefined;
try {
  const { stateDir, token, hub } = readStateConfig();
  const endpoint = required('OAF_WAKE_CONTROL_ENDPOINT');
  const control = createPullControl({ endpoint, hub, token });
  journal = new PullJournal(protectedStateFile(stateDir, 'pull.sqlite'), hub, endpoint);
  ledger = new AttemptLedger(protectedStateFile(stateDir, 'attempts.sqlite'));
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // No listener, reverse tunnel, health endpoint, command execution or arbitrary request API.
  process.stdout.write(JSON.stringify({ event: 'started', role: 'wake-pull', publicHooks: false }) + '\n');
  let unhealthy = false;
  try {
    await runPullLoop(createPullRunner({ control, journal, ledger }), stop.signal, event => {
      const failed = event === 'control_unavailable';
      if (failed !== unhealthy) process.stdout.write(JSON.stringify({ event: failed ? 'control_unavailable' : 'control_recovered' }) + '\n');
      unhealthy = failed;
    });
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
  }
} catch {
  process.stderr.write('wake-pull: startup/runtime refused; check config, exclusive journal and owner-only state/token files\n');
  process.exitCode = 1;
} finally {
  ledger?.close();
  journal?.close();
}
