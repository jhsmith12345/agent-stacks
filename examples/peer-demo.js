import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PeerSession } from '../src/mental-poker/session.js';

const children = [0, 1].map(() => fork(new URL('./peer-worker.js', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced' }));
function ask(child, message) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('message', receive); child.off('exit', exited); child.off('error', failed); clearTimeout(timer); };
    const receive = response => { cleanup(); if (response.kind === 'error') reject(new Error(response.message)); else resolve(response); };
    const exited = () => { cleanup(); reject(new Error('Agent exited unexpectedly')); };
    const failed = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Agent response timed out')); }, 30_000);
    child.once('message', receive); child.once('exit', exited); child.once('error', failed);
    child.send(message);
  });
}
const report = [];
console.log('Agent Stacks | dealerless research demo | simulated escrow\nTwo isolated agent processes; relay holds only public state.');
try {
  const players = await Promise.all(children.map(async child => (await once(child, 'message'))[0].player));
  const config = { id: randomUUID(), players, buyIn: 1000, bigBlind: 20, maxHands: 1, turnSeconds: 86_400 };
  const session = new PeerSession(config, { now: () => Date.now() });
  await Promise.all(children.map(child => ask(child, { kind: 'initialize', config, createdAt: session.createdAt })));
  let view = session.view();
  while (view.status !== 'complete') {
    const { kind, seat } = view.obligation;
    const child = children[seat];
    const before = performance.now();
    const message = await ask(child, { kind: 'decide' });
    const produced = performance.now();
    if (message.kind === 'error') throw new Error(message.message);
    view = session.submit(message.envelope);
    const verified = performance.now();
    const entry = session.transcript.at(-1);
    await Promise.all(children.map(peer => ask(peer, { kind: 'apply', entry })));
    if (kind === 'shuffle') {
      const entry = { seat, proveMs: Math.round(produced - before), verifyMs: Math.round(verified - produced), jsonBytes: Buffer.byteLength(JSON.stringify(message.envelope.command.proof)) };
      report.push(entry); console.log(`  Agent ${'AB'[seat]} shuffle: ${entry.proveMs} ms prove, ${entry.verifyMs} ms verify, ${entry.jsonBytes.toLocaleString()} JSON bytes`);
    } else if (kind === 'board-share' && seat === 1) console.log(`  ${view.hand.street}: ${view.hand.board.join(' ')}`);
    else if (kind === 'action') console.log(`  Agent ${'AB'[seat]} ${message.envelope.command.action}`);
  }
  const artifact = { version: 1, createdAt: session.createdAt, config, entries: session.transcript, result: view.result, measurements: report };
  const directory = resolve('.agent-stacks/reports'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const output = resolve(directory, 'peer-transcript.json');
  writeFileSync(output, JSON.stringify(artifact), { mode: 0o600 });
  console.log(`\nSettled: A ${view.result.payouts[0]} / B ${view.result.payouts[1]} test chips`);
  console.log('No wallet secrets, private hand keys, or folded plaintext cards in relay state.');
  console.log(`Replayable public transcript: ${output}`);
} finally { for (const child of children) child.kill(); }
