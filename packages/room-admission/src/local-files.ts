/** Private Node client filesystem boundary. No automatic paths, chmod, deletion or key lookup. */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  opendirSync, realpathSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const LOCAL_DB_NAME = 'room-client.sqlite';
const FILE_BYTES = 256 * 1024 * 1024;
export class RoomLocalStateError extends Error {
  constructor() { super('Protected room state unavailable; preserve state and reconcile pending requests'); }
  readonly permitsReplacementMutation = false;
}
export function localFailure(): never { throw new RoomLocalStateError(); }
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function privateFile(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!()
    || (info.mode & 0o777) !== 0o600 || info.size > FILE_BYTES) localFailure();
}
function entries(path: string): string[] {
  const directory = opendirSync(path), names: string[] = [];
  try { let item; while ((item = directory.readSync())) {
    if (names.length >= 3) localFailure(); names.push(item.name);
  } } finally { directory.closeSync(); }
  return names;
}
/** POSIX local-filesystem profile only. Permission bits are not Windows ACLs or encryption. */
export class RoomLocalFiles {
  readonly path: string;
  readonly #directory: string;
  readonly #directoryInfo: Stats;
  readonly #fileInfo: Stats;
  #directoryFd: number | undefined;

  constructor(input: string, initialize: boolean) {
    let directoryFd: number | undefined, fileFd: number | undefined;
    try {
      if (!['linux', 'darwin'].includes(process.platform) || !process.getuid || typeof input !== 'string' || !input) localFailure();
      const requested = resolve(input), initial = lstatSync(requested);
      if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== process.getuid()
        || (initial.mode & 0o777) !== 0o700) localFailure();
      const directory = realpathSync(requested);
      // Canonical ancestry excludes checkouts and directories another OS user can replace.
      for (let parent = directory; ; parent = dirname(parent)) {
        const info = lstatSync(parent);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== 0 && info.uid !== process.getuid())
          || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000)))
          || existsSync(join(parent, '.git'))) localFailure();
        if (parent === dirname(parent)) break;
      }
      directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const directoryInfo = fstatSync(directoryFd);
      if (!same(initial, directoryInfo)) localFailure();
      const names = entries(directory);
      if ((initialize && names.length !== 0) || names.some(name => ![LOCAL_DB_NAME, LOCAL_DB_NAME + '-journal'].includes(name))) localFailure();
      for (const name of names) privateFile(lstatSync(join(directory, name)));
      const path = join(directory, LOCAL_DB_NAME);
      // Do not open/close an extra descriptor to an existing SQLite file: POSIX
      // close() can release another connection's process-wide advisory locks.
      if (initialize) {
        fileFd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL, 0o600);
        fsyncSync(fileFd); closeSync(fileFd); fileFd = undefined; fsyncSync(directoryFd);
      }
      const fileInfo = lstatSync(path); privateFile(fileInfo);
      if (!initialize && fileInfo.size < 100) localFailure();
      this.path = path; this.#directory = directory; this.#directoryInfo = directoryInfo; this.#fileInfo = fileInfo;
      this.#directoryFd = directoryFd;
    } catch {
      if (fileFd !== undefined) try { closeSync(fileFd); } catch {}
      if (directoryFd !== undefined) try { closeSync(directoryFd); } catch {}
      localFailure(); // Do not remove even a partially initialized database.
    }
  }
  check(): void {
    if (this.#directoryFd === undefined) localFailure();
    const directory = lstatSync(this.#directory), file = lstatSync(this.path);
    if (!same(directory, this.#directoryInfo) || !same(fstatSync(this.#directoryFd), directory)
      || !directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o777) !== 0o700
      || !same(file, this.#fileInfo)) localFailure();
    privateFile(file);
    for (const name of entries(this.#directory)) {
      if (![LOCAL_DB_NAME, LOCAL_DB_NAME + '-journal'].includes(name)) localFailure();
      privateFile(lstatSync(join(this.#directory, name)));
    }
  }
  syncDirectory(): void { this.check(); fsyncSync(this.#directoryFd!); }
  close(): void {
    if (this.#directoryFd !== undefined) try { closeSync(this.#directoryFd); } catch {}
    this.#directoryFd = undefined;
  }
}
