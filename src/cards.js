import { randomInt } from 'node:crypto';
export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export function shuffledDeck() {
  const deck = [...RANKS].flatMap(rank => [...SUITS].map(suit => rank + suit));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
export function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}
function five(cards) {
  const ranks = cards.map(c => RANKS.indexOf(c[0]) + 2).sort((a, b) => b - a);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(c => c[1] === cards[0][1]);
  const unique = [...new Set(ranks)];
  const straight = unique.length === 5 && unique[0] - unique[4] === 4 ? unique[0]
    : unique.join(',') === '14,5,4,3,2' ? 5 : 0;
  if (flush && straight) return [8, straight];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...ranks];
  if (straight) return [4, straight];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map(g => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...groups.slice(0, 2).map(g => g[0]), groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map(g => g[0])];
  return [0, ...ranks];
}
export function evaluate(cards) {
  if (cards.length < 5 || cards.length > 7 || new Set(cards).size !== cards.length ||
      cards.some(c => typeof c !== 'string' || c.length !== 2 || !RANKS.includes(c[0]) || !SUITS.includes(c[1]))) {
    throw new Error('Expected five to seven distinct valid cards');
  }
  let best = [-1];
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const score = five([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (compare(score, best) > 0) best = score;
          }
  return { score: best, name: ['high card', 'pair', 'two pair', 'three of a kind', 'straight', 'flush', 'full house', 'four of a kind', 'straight flush'][best[0]] };
}
