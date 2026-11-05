import test from 'node:test';
import assert from 'node:assert/strict';
import { startHand, act, legalActions, resumeExternalDeal, resumeExternalShowdown } from '../src/poker.js';

const match = (stacks, options = {}) => ({
  stacks, status: 'active', handNo: 0, bigBlind: 20, smallBlind: 10,
  turnSeconds: 30, maxHands: 1, events: [], ...options,
});
const total = m => m.stacks.reduce((a, b) => a + b) + m.hand.contributed.reduce((a, b) => a + b);

test('short big blind faces only the actual posted bet', () => {
  const m = match([100, 15]); startHand(m, 0);
  assert.equal(m.hand.actor, 0);
  assert.equal(legalActions(m, 0).call, 5);
  act(m, 0, 'call', undefined, 1);
  assert.equal(m.status, 'complete'); assert.equal(total(m), 115);
});
test('big blind below small blind immediately runs out with uncalled blind returned', () => {
  const m = match([100, 5]); startHand(m, 0);
  assert.equal(m.status, 'complete'); assert.equal(total(m), 105);
  assert.equal(m.hand.board.length, 5);
  assert.ok(m.stacks[0] >= 95);
});
test('short small blind runs out without asking the big blind for a spurious action', () => {
  const m = match([5, 100]); startHand(m, 0);
  assert.equal(m.status, 'complete'); assert.equal(total(m), 105);
  assert.ok(m.stacks[1] >= 95);
});
test('short all-in raise is legal, cannot be re-raised, and returns excess chips', () => {
  const m = match([1000, 55]); startHand(m, 0);
  act(m, 0, 'raise', 40, 1);
  assert.deepEqual(legalActions(m, 1).raise, { min: 55, max: 55, shortAllInOnly: true });
  assert.throws(() => act(m, 1, 'raise', 50, 2), /Raise must meet/);
  act(m, 1, 'all-in', undefined, 2);
  assert.equal(legalActions(m, 0).raise, null);
  assert.equal(legalActions(m, 0).call, 15);
  act(m, 0, 'call', undefined, 3);
  assert.equal(m.status, 'complete'); assert.equal(total(m), 1055);
  assert.ok(m.stacks[0] >= 945);
});
test('all-in below a call returns the unmatched portion to the bigger stack', () => {
  const m = match([1000, 100]); startHand(m, 0);
  act(m, 0, 'all-in', undefined, 1);
  assert.equal(legalActions(m, 1).call, 80);
  act(m, 1, 'call', undefined, 2);
  assert.equal(total(m), 1100); assert.ok(m.stacks[0] >= 900);
  assert.equal(m.events.find(e => e.type === 'hand_complete').pot, 200);
});
test('board plays for both agents: split returns stacks and ties expose identical best five', () => {
  const m = match([100, 100]); startHand(m, 0);
  m.hand.holes = [['2c', '3d'], ['4c', '5d']];
  // Burns and public cards in draw order, top of deck at the end.
  m.hand.deck = ['6c', 'As', 'Ks', 'Qs', '7c', 'Js', '8c', 'Ts'].reverse();
  act(m, 0, 'all-in', undefined, 1); act(m, 1, 'call', undefined, 2);
  assert.deepEqual(m.stacks, [100, 100]);
  const complete = m.events.find(e => e.type === 'hand_complete');
  assert.equal(complete.winner, null); assert.equal(complete.showdown[0].name, 'straight flush');
});
test('blinds and preflop action alternate between hands', () => {
  const m = match([100, 100], { maxHands: 2 }); startHand(m, 0);
  act(m, 0, 'fold', undefined, 1);
  assert.equal(m.handNo, 2); assert.equal(m.button, 1); assert.equal(m.hand.actor, 1);
  assert.deepEqual(m.hand.bets, [20, 10]);
});

test('external all-in runout pauses for every board street and verified showdown', () => {
  const m = match([100, 100], { dealing: 'external' }); startHand(m, 0);
  assert.equal(m.hand.phase, 'awaiting-deal'); assert.deepEqual(m.hand.holes, [[], []]); assert.deepEqual(m.hand.deck, []);
  assert.throws(() => act(m, 0, 'all-in', undefined, 1), /Awaiting cryptographic/);
  resumeExternalDeal(m, 1);
  act(m, 0, 'all-in', undefined, 2); act(m, 1, 'call', undefined, 3);
  for (const [street, cards] of [['flop', ['2c','3d','4h']], ['turn', ['8s']], ['river', ['9c']]]) {
    assert.equal(m.hand.phase, 'awaiting-board'); assert.equal(m.hand.street, street);
    assert.equal(m.hand.actor, null); assert.equal(legalActions(m, 0), null);
    m.hand.board.push(...cards); resumeExternalDeal(m, 4);
  }
  assert.equal(m.hand.phase, 'awaiting-showdown'); assert.equal(m.status, 'active');
  resumeExternalShowdown(m, [['As','Ad'],['Ks','Kd']], 5);
  assert.equal(m.status, 'complete'); assert.deepEqual(m.stacks, [200,0]);
});
