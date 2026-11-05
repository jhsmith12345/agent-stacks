import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import {once} from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentClient } from '../src/client.js';
import { generateWallet } from '../src/crypto.js';

function finished(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    child.once('error', reject); child.once('exit', code => resolve({ code, output }));
  });
}
async function startServer(directory) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve('.'), env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AGENT_STACKS_DATA: directory },
  });
  const done = finished(child);
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out')); }, 5000);
    child.stdout.on('data', b => {
      const match = b.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited during startup: ${code}`)); });
  });
  return { child, done, url };
}

test('real server and independent bots settle a match; state persists and duplicate writers fail', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-stacks-process-'));
  const children = []; let server;
  try {
    server = await startServer(directory); children.push(server.child);
    const keys = [generateWallet(), generateWallet()];
    const clients = keys.map(w => new AgentClient(server.url, w));
    for (const c of clients) await c.send({ type: 'faucet' });
    let { match } = await clients[0].send({ type: 'create', maxHands: 2, turnSeconds: 30 });
    ({ match } = await clients[1].matchCommand('join', match.id));
    const duplicate = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: '0', AGENT_STACKS_DATA: directory } });
    children.push(duplicate);
    const rejected = await finished(duplicate);
    assert.notEqual(rejected.code, 0); assert.match(rejected.output, /State directory already locked/);
    const botRuns = keys.map((wallet, i) => {
      const keyFile = join(directory, `${i}.key.json`);
      writeFileSync(keyFile, JSON.stringify(wallet), { mode: 0o600 });
      const bot = spawn(process.execPath, ['examples/bot.js', keyFile, match.id], { env: { ...process.env, AGENT_STACKS_URL: server.url } });
      children.push(bot); return finished(bot);
    });
    for (const result of await Promise.all(botRuns)) assert.equal(result.code, 0, result.output);
    const before = await clients[0].walletInfo();
    assert.equal((await clients[0].request(`/v1/matches/${match.id}`)).match.status, 'complete');
    server.child.kill('SIGTERM'); assert.equal((await server.done).code, 0);
    assert.equal(existsSync(join(directory, 'server.lock')), false);
    server = await startServer(directory); children.push(server.child);
    const restored = new AgentClient(server.url, keys[0]);
    assert.deepEqual(await restored.walletInfo(), before);
    assert.equal((await restored.request(`/v1/matches/${match.id}`)).match.status, 'complete');
    server.child.kill('SIGTERM'); assert.equal((await server.done).code, 0);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('chain agents lock both their wallet and private state and release locks on shutdown', {timeout:10_000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stacks-agent-lock-'));
  const children = [];
  const launch = state => {
    const child = fork(new URL('../examples/chain-agent.js', import.meta.url), [join(dir, 'wallet.json'), join(dir, state)], {stdio:['ignore','pipe','pipe','ipc']});
    children.push(child); return child;
  };
  try {
    const first = launch('first'); const firstDone = finished(first);
    const [identity] = await once(first, 'message', {signal:AbortSignal.timeout(5000)});
    assert.equal(identity.kind, 'identity');
    const duplicate = launch('second'); const denied = await finished(duplicate);
    assert.notEqual(denied.code, 0); assert.match(denied.output, /already locked/);
    first.kill('SIGTERM'); assert.equal((await firstDone).code, 0);
    assert.equal(existsSync(join(dir, 'wallet.json.agent.lock')), false);
    assert.equal(existsSync(join(dir, 'first', 'agent.lock')), false);
    const restarted = launch('first'); const restartedDone = finished(restarted);
    assert.equal((await once(restarted, 'message'))[0].player, identity.player);
    restarted.kill('SIGTERM'); assert.equal((await restartedDone).code, 0);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, {recursive:true, force:true});
  }
});
