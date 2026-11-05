import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
export function acquireLock(directory, name = 'server.lock') {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw Error('Invalid lock filename');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  try { writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`State directory already locked: ${path}. If a prior server crashed, verify its PID is no longer running before removing this lock.`);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
