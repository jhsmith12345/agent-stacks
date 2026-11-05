import { join } from 'node:path';
import { emptyState } from './protocol.js';
import {privateDirectory, readPrivate, writePrivate} from './private-files.js';
export function fileStore(directory) {
  privateDirectory(directory);
  const path = join(directory, 'state.json');
  let initial;
  try { initial = JSON.parse(readPrivate(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; initial = emptyState(); }
  if (initial.schema !== 1) throw new Error('Unsupported state schema');
  return { initial, persist(state) {
    writePrivate(path, JSON.stringify(state));
  } };
}
