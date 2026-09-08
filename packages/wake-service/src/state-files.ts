import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, type Stats } from 'node:fs';
import { resolve } from 'node:path';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
function ownerOnly(stat: Stats) {
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('state and token must be owner-only');
}
export function readStateConfig() {
  const stateDir = resolve(required('OAF_WAKE_STATE_DIR'));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateStat = lstatSync(stateDir);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error('state directory must not be a symlink');
  ownerOnly(stateStat);
  const tokenFd = openSync(required('OAF_WAKE_TOKEN_FILE'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let token: string;
  try {
    const stat = fstatSync(tokenFd);
    if (!stat.isFile() || stat.size > 256) throw new Error('invalid token file');
    ownerOnly(stat);
    token = readFileSync(tokenFd, 'utf8').trim();
  } finally { closeSync(tokenFd); }
  process.umask(0o077);
  return { stateDir, token, hub: required('OAF_WAKE_HUB') };
}
export function protectedStateFile(stateDir: string, name: 'attempts.sqlite' | 'pull.sqlite'): string {
  const path = resolve(stateDir, name);
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('invalid state file');
    ownerOnly(stat);
  } finally { closeSync(fd); }
  return path;
}
