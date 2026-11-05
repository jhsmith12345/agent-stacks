import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Protocol } from '../src/protocol.js';
import { generateWallet, signCommand } from '../src/crypto.js';
import { fileStore } from '../src/store.js';
import { chooseAction } from '../examples/strategy.js';

function setup(options = {}) {
  let clock = Date.now();
  const p = new Protocol(undefined, { now: () => clock, ...options });
  const wallets = [generateWallet(), generateWallet(), generateWallet()];
  const send = (seat, c) => p.execute(signCommand(wallets[seat], { ...c, serverId: p.state.serverId }, p.publicWallet(wallets[seat].player).nextNonce, clock));
  const mutate = (seat, m, type, extra = {}) => send(seat, { type, matchId: m.id, expectedVersion: p.get(m.id).version, ...extra });
  const view = (seat, m) => send(seat, { type: 'view', matchId: m.id }).match;
  for (const i of [0, 1]) send(i, { type: 'faucet' });
  const create = (opts = {}) => send(0, { type: 'create', buyIn: 1000, bigBlind: 20, maxHands: 1, turnSeconds: 30, ...opts }).match;
  const start = (opts = {}) => { const m = create(opts); return mutate(1, m, 'join').match; };
  return { p, wallets, send, mutate, view, create, start, setTime: t => { clock = t; }, time: () => clock };
}
const code = expected => error => error.code === expected;

test('fold returns uncalled blind, settles once, and preserves chips', () => {
  const f = setup(), m = f.start();
  assert.deepEqual(m.stacks, [990, 980]);
  const done = f.mutate(0, m, 'action', { action: 'fold' }).match;
  assert.deepEqual(done.result.payouts, [990, 1010]);
  assert.equal(f.p.publicWallet(f.wallets[0].player).balance, 9990);
  assert.throws(() => f.mutate(1, done, 'claim-timeout'), code('MATCH_NOT_ACTIVE'));
  assert.deepEqual(f.view(1, done).result.payouts, [990, 1010]);
  f.p.assertConservation(f.p.state);
});
test('small blind acts first, big blind has option, non-button opens flop', () => {
  const f = setup(), m = f.start();
  const called = f.mutate(0, m, 'action', { action: 'call' }).match;
  assert.equal(called.hand.street, 'preflop'); assert.equal(called.hand.actor, 1);
  const flop = f.mutate(1, m, 'action', { action: 'check' }).match;
  assert.equal(flop.hand.street, 'flop'); assert.equal(flop.hand.actor, 1);
  assert.equal(flop.hand.board.length, 3);
  assert.deepEqual(flop.hand.bets, [0, 0]);
});
test('public views never expose hidden cards, private views require signed membership', () => {
  const f = setup(), m = f.start();
  const pub = f.p.get(m.id);
  assert.equal(pub.hand.yourCards, undefined); assert.equal(pub.hand.deck, undefined);
  assert.equal(pub.hand.holes, undefined);
  assert.equal(JSON.stringify(f.p.list()).includes('yourCards'), false);
  const a = f.view(0, m), b = f.view(1, m);
  assert.equal(a.hand.yourCards.length, 2); assert.equal(b.hand.yourCards.length, 2);
  assert.equal(new Set([...a.hand.yourCards, ...b.hand.yourCards]).size, 4);
  assert.throws(() => f.view(2, m), code('NOT_A_PLAYER'));
  f.mutate(0, m, 'action', { action: 'fold' });
  assert.equal(JSON.stringify(f.p.get(m.id)).includes('yourCards'), false);
  assert.equal(f.p.get(m.id).events.some(e => e.showdown), false);
});
test('signatures, replay, stale state, turn order, and failed-command rollback', () => {
  const f = setup(), m = f.start();
  const c = { type: 'view', matchId: m.id };
  const bound = { ...c, serverId: f.p.state.serverId };
  const signed = signCommand(f.wallets[0], bound, f.p.publicWallet(f.wallets[0].player).nextNonce, f.time());
  f.p.execute(signed);
  assert.throws(() => f.p.execute(signed), code('BAD_NONCE'));
  assert.throws(() => f.p.execute({ ...signed, nonce: signed.nonce + 1 }), code('BAD_SIGNATURE'));
  assert.throws(() => f.p.execute(signCommand(f.wallets[0], bound, signed.nonce + 1, f.time() - 300_001)), code('STALE_SIGNATURE'));
  const before = JSON.stringify(f.p.state);
  assert.throws(() => f.mutate(1, m, 'action', { action: 'fold' }), code('OUT_OF_TURN'));
  assert.throws(() => f.mutate(0, m, 'action', { action: 'check' }), code('ILLEGAL_ACTION'));
  assert.throws(() => f.mutate(0, m, 'action', { action: 'raise', amount: 21 }), code('ILLEGAL_ACTION'));
  assert.throws(() => f.mutate(2, m, 'action', { action: 'fold' }), code('NOT_A_PLAYER'));
  assert.equal(JSON.stringify(f.p.state), before);
  f.mutate(0, m, 'action', { action: 'call' });
  assert.throws(() => f.send(1, { type: 'action', matchId: m.id, expectedVersion: m.version, action: 'check' }), code('STALE_STATE'));
});
test('join and cancellation enforce custody; expired invitation can be refunded by anyone', () => {
  const f = setup(), m = f.create();
  assert.equal(f.p.publicWallet(f.wallets[0].player).balance, 9000);
  assert.throws(() => f.mutate(0, m, 'join'), code('SAME_PLAYER'));
  assert.throws(() => f.mutate(1, m, 'cancel'), code('NOT_ALLOWED'));
  f.mutate(0, m, 'cancel');
  assert.equal(f.p.publicWallet(f.wallets[0].player).balance, 10_000);
  const n = f.create(); f.setTime(n.deadline);
  assert.throws(() => f.mutate(1, n, 'join'), code('DEADLINE_PASSED'));
  f.mutate(2, n, 'claim-timeout');
  assert.equal(f.p.publicWallet(f.wallets[0].player).balance, 10_000);
});
test('timeout boundary rejects late action and permissionlessly forfeits entire match', () => {
  const f = setup(), m = f.start();
  f.setTime(m.deadline - 1);
  assert.throws(() => f.mutate(2, m, 'claim-timeout'), code('TOO_EARLY'));
  f.setTime(m.deadline);
  assert.throws(() => f.mutate(0, m, 'action', { action: 'call' }), code('DEADLINE_PASSED'));
  const done = f.mutate(2, m, 'claim-timeout').match;
  assert.deepEqual(done.result.payouts, [0, 2000]);
  assert.equal(f.p.publicWallet(f.wallets[1].player).balance, 11_000);
});
test('timer resets on every turn and accepts configured 24/72 hour clocks', () => {
  for (const turnSeconds of [86_400, 259_200]) {
    const f = setup(), m = f.start({ turnSeconds });
    f.setTime(f.time() + 10_000);
    const n = f.mutate(0, m, 'action', { action: 'call' }).match;
    assert.equal(n.deadline, f.time() + turnSeconds * 1000);
  }
});
test('all-in call runs board to river, reveals showdown, settles exactly 2000', () => {
  const f = setup(), m = f.start();
  f.mutate(0, m, 'action', { action: 'all-in' });
  const done = f.mutate(1, m, 'action', { action: 'call' }).match;
  assert.equal(done.status, 'complete');
  assert.equal(done.hand.board.length, 5);
  assert.equal(done.result.payouts.reduce((a, b) => a + b), 2000);
  assert.equal(done.events.find(e => e.type === 'hand_complete').showdown.length, 2);
});
test('file state survives restart with nonces, private cards, escrow, and 0600 permissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-stacks-test-'));
  try {
    const store = fileStore(directory), f = setup({ persist: store.persist }), m = f.start();
    const before = f.view(0, m);
    const restored = new Protocol(fileStore(directory).initial);
    assert.deepEqual(restored.state, f.p.state);
    assert.deepEqual(restored.get(m.id).hand.board, before.hand.board);
    assert.equal(statSync(join(directory, 'state.json')).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(directory, 'state.json'))).matches[m.id].status, 'active');
    restored.assertConservation(restored.state);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('failed persistence never acknowledges or mutates in-memory state', () => {
  const f = setup(); const before = JSON.stringify(f.p.state);
  f.p.persist = () => { throw new Error('disk full'); };
  assert.throws(() => f.create(), /disk full/);
  assert.equal(JSON.stringify(f.p.state), before);
});
test('randomized agents finish 150 matches without illegal actions or lost chips', () => {
  let seed = 12345;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let game = 0; game < 150; game++) {
    const f = setup(); let m = f.start({ maxHands: 10 }); let steps = 0;
    while (m.status === 'active') {
      assert.ok(++steps < 3000);
      const seat = m.hand.actor;
      const privateView = f.view(seat, m);
      m = f.mutate(seat, m, 'action', chooseAction(privateView, random)).match;
      f.p.assertConservation(f.p.state);
    }
    assert.equal(m.result.payouts.reduce((a, b) => a + b), 2000);
  }
});
