import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
// Linux gives each boot an ID, so a lock from before a power cut can't be confused with a live process
// that happens to have been given the same PID since.
function bootId() {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; }
}
function holderIsGone(path) {
  let pid, boot;
  try { [pid, boot] = readFileSync(path, 'utf8').split('\n'); } catch (error) { return error.code === 'ENOENT'; }
  const current = bootId();
  if (boot && current && boot !== current) return true;
  // Empty means a crash between creating this file and writing it, or a power cut that lost the write.
  // If that was before this boot its holder can't still be running. Otherwise it may be starting up now.
  if (!pid) {
    try { return statSync(path).mtimeMs < Date.now() - uptime() * 1000 - 1000; }
    catch (error) { return error.code === 'ENOENT'; }
  }
  const number = Number(pid);
  if (!Number.isSafeInteger(number) || number <= 0) return false;
  try { process.kill(number, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
// With `reclaimDead`, a lock whose process is provably gone is taken over, so nobody has to clear it by
// hand after a crash. A lock it can't prove is dead still refuses: two agents on one state could sign
// conflicting moves. The rename is atomic, so only one of two simultaneous starters can win.
export function acquireLock(directory, name = 'server.lock', { reclaimDead = false } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw Error('Invalid lock filename');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  // Flushed to disk, so a lock from before a power cut still says who held it.
  const take = () => {
    const file = openSync(path, 'wx', 0o600);
    try { writeSync(file, reclaimDead ? `${process.pid}\n${bootId()}\n` : `${process.pid}\n`); fsyncSync(file); }
    finally { closeSync(file); }
  };
  try { take(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const refuse = () => new Error(`State directory already locked: ${path}. If a prior server crashed, verify its PID is no longer running before removing this lock.`);
    if (!reclaimDead || !holderIsGone(path)) throw refuse();
    const aside = `${path}.stale-${process.pid}`;
    try { renameSync(path, aside); unlinkSync(aside); } catch (moved) { if (moved.code !== 'ENOENT') throw moved; }
    try { take(); } catch (again) { if (again.code === 'EEXIST') throw refuse(); throw again; }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
