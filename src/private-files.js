// Private local storage is a trusted boundary, not an encrypted vault. Fail
// closed on unsafe permissions/symlinks and fsync before publishing or sending.
import {constants, mkdirSync, lstatSync, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, closeSync, linkSync, renameSync, unlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';

function ownerOnly(stat) {
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw Error('Private state must be owned by this user with owner-only permissions');
}
export function privateDirectory(directory) {
  mkdirSync(directory, {recursive:true, mode:0o700});
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Private directory must not be a symlink');
  ownerOnly(stat);
}
function privateFile(fd) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) throw Error('Private file must be a regular file with no hard links');
  ownerOnly(stat);
}
function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function readPrivate(file, encoding = null) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { privateFile(fd); return readFileSync(fd, encoding ?? undefined); }
  finally { closeSync(fd); }
}
export function writePrivate(file, value, {exclusive = false} = {}) {
  const directory = dirname(file); privateDirectory(directory);
  // Do not overwrite a non-private target, even though rename would replace it.
  try { const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { privateFile(fd); } finally { closeSync(fd); } }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(directory, `.private-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd = undefined;
    if (exclusive) { linkSync(temp, file); unlinkSync(temp); }
    else renameSync(temp, file);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export function appendPrivate(file, value) {
  const directory = dirname(file); privateDirectory(directory);
  const fd = openSync(file, constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { privateFile(fd); writeFileSync(fd, value); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncDirectory(directory);
}

// A pending marker deliberately blocks a fresh payment after ambiguity, even
// when the process crashed before recording the returned signature.
export async function transferOnce(marker, details, transfer) {
  try {
    const previous = JSON.parse(readPrivate(marker, 'utf8'));
    if (previous.status === 'confirmed' || (!previous.status && previous.signature)) return {...previous, cached:true};
    throw Error('Transfer is pending or uncertain; inspect the original transaction journal before recovery');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  writePrivate(marker, JSON.stringify({...details, status:'pending'}), {exclusive:true});
  const signature = await transfer();
  const result = {...details, status:'confirmed', signature};
  writePrivate(marker, JSON.stringify(result));
  return result;
}
