import { readFileSync } from 'node:fs';
import { PeerSession } from '../src/mental-poker/session.js';
const file = process.argv[2] ?? '.agent-stacks/reports/peer-transcript.json';
try {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (report.version !== 1 || !Array.isArray(report.entries)) throw new Error('Unsupported transcript');
  let now = report.createdAt;
  const session = new PeerSession(report.config, { now: () => now });
  for (const entry of report.entries) {
    if (!Number.isSafeInteger(entry.acceptedAt) || entry.acceptedAt < now) throw new Error('Nonmonotonic transcript clock');
    now = entry.acceptedAt; session.submit(entry.envelope);
  }
  const result = session.view().result;
  if (JSON.stringify(result) !== JSON.stringify(report.result)) throw new Error('Result mismatch');
  console.log(JSON.stringify({ valid: true, commands: report.entries.length, result, timing: 'Recorded local timestamps, not blockchain attestations' }, null, 2));
} catch (error) { console.error(`Invalid transcript: ${error.message}`); process.exitCode = 1; }
