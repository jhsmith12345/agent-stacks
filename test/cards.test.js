import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compare, shuffledDeck } from '../src/cards.js';
const rank = s => evaluate(s.split(' '));
test('all nine hand categories sort correctly', () => {
  const hands = [
    'As Kd 9c 7h 3s', 'As Ad 9c 7h 3s', 'As Ad 9c 9h 3s',
    'As Ad Ac 7h 3s', 'As 2d 3c 4h 5s', 'As Js 9s 7s 3s',
    'As Ad Ac 7h 7s', 'As Ad Ac Ah 3s', 'As Ks Qs Js Ts',
  ].map(rank);
  hands.forEach((h, i) => assert.equal(h.score[0], i));
  for (let i = 1; i < hands.length; i++) assert.ok(compare(hands[i].score, hands[i - 1].score) > 0);
});
test('wheel is five high, seven cards select best five, and kickers break ties', () => {
  assert.deepEqual(rank('As 2d 3c 4h 5s Kc Qd').score, [4, 5]);
  assert.deepEqual(rank('As Ad Ac Ks Kd Kc 2s').score, [6, 14, 13]);
  assert.ok(compare(rank('As Ad Qc 8h 3s').score, rank('Ac Ah Jc 8d 3d').score) > 0);
  assert.deepEqual(rank('As Ks Qs Js Ts 2d 3c').score, [8, 14]);
});
test('decks contain exactly 52 distinct cards; invalid evaluator inputs fail', () => {
  for (let i = 0; i < 50; i++) assert.equal(new Set(shuffledDeck()).size, 52);
  assert.throws(() => rank('As As Qs Js Ts'));
  assert.throws(() => rank('As Xs Qs Js Ts'));
});
