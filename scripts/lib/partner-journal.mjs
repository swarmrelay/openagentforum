// Source-only operator journal. No keys; exact signed public requests are retained.
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync,
  fstatSync, lstatSync, realpathSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const fail = () => { throw new Error('Partner journal unavailable; preserve state and reconcile manually'); };
const hash = value => createHash('sha256').update(value).digest('hex');
export function openPartnerJournal(directory, scope, initialize = false) {
  if (typeof directory !== 'string' || !directory) fail();
  const requested = resolve(directory), info = lstatSync(requested);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)
    || (process.getuid && info.uid !== process.getuid())) fail();
  const dir = realpathSync(requested);
  for (let parent = dir; ; parent = dirname(parent)) {
    if (existsSync(join(parent, '.git'))) fail();
    if (parent === dirname(parent)) break;
  }
  const lock = join(dir, '.publisher-lock');
  let fd;
  try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch { fail(); }
  const syncDirectory = () => { const d = openSync(dir, constants.O_RDONLY); try { fsyncSync(d); } finally { closeSync(d); } };
  function read(name) {
    let file;
    try { file = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return null; fail(); }
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 100000 || (stat.mode & 0o077)
        || (process.getuid && stat.uid !== process.getuid())) fail();
      return JSON.parse(readFileSync(file, 'utf8'));
    } finally { closeSync(file); }
  }
  function write(name, value) {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 100000 || readdirSync(dir).length >= 2002) fail();
    const file = openSync(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(file, data); fsyncSync(file); } finally { closeSync(file); }
    syncDirectory(); // durable reservation BEFORE network I/O, including its directory entry
  }
  const close = () => { if (fd !== undefined) { closeSync(fd); fd = undefined; unlinkSync(lock); syncDirectory(); } };
  try {
    const metadata = read('scope.json');
    if (metadata === null) {
      if (!initialize || readdirSync(dir).some(name => name !== '.publisher-lock')) fail();
      write('scope.json', scope);
    } else if (initialize || JSON.stringify(metadata) !== JSON.stringify(scope)) fail();
    return {
      read(campaignId) { return read(hash(campaignId) + '.intent.json'); },
      reserve(campaignId, value) { write(hash(campaignId) + '.intent.json', value); },
      acknowledged(campaignId, wire) {
        const receipt = read(hash(campaignId) + '.ack.json');
        if (receipt === null) return false;
        if (receipt.wireHash !== hash(wire) || Object.keys(receipt).length !== 1) fail();
        return true;
      },
      acknowledge(campaignId, wire) { write(hash(campaignId) + '.ack.json', { wireHash: hash(wire) }); },
      close,
    };
  } catch (error) { close(); throw error; }
}
