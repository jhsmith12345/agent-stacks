import { shuffledDeck, evaluate, compare } from './cards.js';
import { requireThat, integer } from './errors.js';

function pay(m, seat, amount) {
  const h = m.hand;
  m.stacks[seat] -= amount;
  h.bets[seat] += amount;
  h.contributed[seat] += amount;
}
function event(m, type, details = {}) { m.events.push({ type, hand: m.handNo, ...details }); }
function arm(m, now) { m.deadline = now + m.turnSeconds * 1000; }
export function finishMatch(m, reason) {
  m.status = 'complete'; m.deadline = null;
  m.result = { reason, payouts: [...m.stacks] };
  event(m, 'match_complete', m.result);
}
function finishHand(m, winner, now, showdown = null) {
  const h = m.hand;
  // Return uncalled money before awarding the contested pot.
  const matched = Math.min(...h.contributed);
  for (let s = 0; s < 2; s++) m.stacks[s] += h.contributed[s] - matched;
  const pot = matched * 2;
  if (winner === null) {
    m.stacks[0] += pot / 2; m.stacks[1] += pot / 2;
  } else m.stacks[winner] += pot;
  event(m, 'hand_complete', { winner, pot, board: [...h.board], ...(showdown ? { showdown } : {}) });
  h.contributed = [0, 0]; h.actor = null;
  if (m.handNo >= m.maxHands || m.stacks.some(s => s === 0)) finishMatch(m, 'hands_played');
  else startHand(m, now);
}
function showdown(m, now) {
  const h = m.hand;
  if (m.dealing === 'external' && h.holes.some(cards => cards.length !== 2)) {
    h.phase = 'awaiting-showdown'; h.actor = null; return;
  }
  const ranks = h.holes.map(cards => evaluate([...cards, ...h.board]));
  const comparison = compare(ranks[0].score, ranks[1].score);
  finishHand(m, comparison === 0 ? null : comparison > 0 ? 0 : 1, now,
    h.holes.map((cards, seat) => ({ seat, cards: [...cards], ...ranks[seat] })));
}
function dealStreet(m) {
  const h = m.hand;
  if (m.dealing === 'external') {
    h.street = h.street === 'preflop' ? 'flop' : h.street === 'flop' ? 'turn' : 'river';
    h.bets = [0, 0]; h.currentBet = 0; h.minRaise = m.bigBlind;
    h.acted = []; h.pending = [0, 1].filter(s => m.stacks[s] > 0);
    h.phase = 'awaiting-board'; h.actor = null; return;
  }
  h.deck.pop(); // burn card
  if (h.street === 'preflop') { h.street = 'flop'; h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop()); }
  else { h.street = h.street === 'flop' ? 'turn' : 'river'; h.board.push(h.deck.pop()); }
  h.bets = [0, 0]; h.currentBet = 0; h.minRaise = m.bigBlind;
  h.acted = []; h.pending = [0, 1].filter(s => m.stacks[s] > 0);
  event(m, 'street', { street: h.street, board: [...h.board] });
}
function advance(m, now) {
  const h = m.hand;
  h.pending = h.pending.filter(s => m.stacks[s] > 0);
  // Once either player is all-in, only an unmatched wager needs a response.
  if (m.stacks.some(s => s === 0)) {
    const owing = [0, 1].find(s => m.stacks[s] > 0 && h.bets[s] < h.currentBet);
    if (owing !== undefined) { h.pending = [owing]; h.actor = owing; arm(m, now); return; }
    while (h.street !== 'river') {
      dealStreet(m);
      if (m.dealing === 'external') return;
    }
    showdown(m, now); return;
  }
  if (h.pending.length === 0) {
    if (h.street === 'river') { showdown(m, now); return; }
    dealStreet(m);
    if (m.dealing === 'external') return;
    h.actor = 1 - m.button;
  } else if (!h.pending.includes(h.actor)) h.actor = h.pending[0];
  arm(m, now);
}
export function startHand(m, now, deck = m.dealing === 'external' ? [] : shuffledDeck()) {
  m.handNo++;
  m.button = (m.handNo - 1) % 2;
  const h = m.hand = {
    number: m.handNo, street: 'preflop', board: [], holes: [[], []], deck,
    bets: [0, 0], contributed: [0, 0], currentBet: m.bigBlind,
    minRaise: m.bigBlind, pending: [m.button, 1 - m.button], acted: [], actor: m.button,
  };
  for (let round = 0; m.dealing !== 'external' && round < 2; round++) {
    h.holes[1 - m.button].push(deck.pop()); h.holes[m.button].push(deck.pop());
  }
  pay(m, m.button, Math.min(m.smallBlind, m.stacks[m.button]));
  pay(m, 1 - m.button, Math.min(m.bigBlind, m.stacks[1 - m.button]));
  if (m.stacks.some(s => s === 0)) h.currentBet = Math.max(...h.bets);
  event(m, 'hand_start', { button: m.button, blinds: [...h.bets] });
  if (m.dealing === 'external') { h.phase = 'awaiting-deal'; h.actor = null; arm(m, now); return; }
  advance(m, now);
}
export function resumeExternalDeal(m, now) {
  requireThat(m.dealing === 'external' && ['awaiting-deal', 'awaiting-board'].includes(m.hand.phase), 'WRONG_PHASE', 'Not awaiting external cards');
  const h = m.hand;
  h.phase = 'betting'; h.actor = h.street === 'preflop' ? m.button : 1 - m.button;
  if (h.street !== 'preflop') event(m, 'street', { street: h.street, board: [...h.board] });
  advance(m, now);
}
export function resumeExternalShowdown(m, holes, now) {
  requireThat(m.dealing === 'external' && m.hand.phase === 'awaiting-showdown', 'WRONG_PHASE', 'Not awaiting showdown');
  m.hand.holes = holes; showdown(m, now);
}
export function legalActions(m, seat) {
  if (m.status !== 'active' || (m.dealing === 'external' && m.hand.phase !== 'betting') || seat !== m.hand.actor) return null;
  const h = m.hand;
  const owed = Math.max(0, h.currentBet - h.bets[seat]);
  const max = h.bets[seat] + m.stacks[seat];
  const min = h.currentBet + h.minRaise;
  const canRaise = !h.acted.includes(seat) && m.stacks[1 - seat] > 0 && max > h.currentBet;
  return {
    fold: true, check: owed === 0, call: owed > 0 ? Math.min(owed, m.stacks[seat]) : null,
    raise: canRaise ? { min: Math.min(min, max), max, shortAllInOnly: max < min } : null,
    allIn: m.stacks[seat] > 0 && (max <= h.currentBet || canRaise),
  };
}
export function act(m, seat, action, amount, now) {
  requireThat(m.status === 'active', 'MATCH_NOT_ACTIVE', 'Match is not active');
  requireThat(m.dealing !== 'external' || m.hand.phase === 'betting', 'WRONG_PHASE', 'Awaiting cryptographic dealing');
  requireThat(now < m.deadline, 'DEADLINE_PASSED', 'The turn has expired; claim timeout');
  const h = m.hand;
  requireThat(h.actor === seat, 'OUT_OF_TURN', 'It is not your turn');
  const legal = legalActions(m, seat);
  requireThat(['fold', 'check', 'call', 'raise', 'all-in'].includes(action), 'ILLEGAL_ACTION', 'Unknown poker action');
  requireThat(action === 'raise' || amount === undefined, 'INVALID_ARGUMENT', 'Only raise takes an amount');
  if (action === 'fold') {
    event(m, 'action', { seat, action }); finishHand(m, 1 - seat, now); return;
  }
  if (action === 'all-in') {
    requireThat(legal.allIn, 'ILLEGAL_ACTION', 'Betting has not reopened');
    amount = h.bets[seat] + m.stacks[seat];
    action = amount <= h.currentBet ? 'call' : 'raise';
  }
  if (action === 'check') requireThat(legal.check, 'ILLEGAL_ACTION', 'Cannot check facing a bet');
  if (action === 'call') {
    requireThat(legal.call !== null, 'ILLEGAL_ACTION', 'Nothing to call');
    pay(m, seat, legal.call);
  }
  if (action === 'raise') {
    integer(amount, 1, 2_000_000_000, 'raise amount');
    requireThat(legal.raise && amount >= legal.raise.min && amount <= legal.raise.max,
      'ILLEGAL_ACTION', 'Raise must meet the minimum, or be your entire remaining stack');
    const increase = amount - h.currentBet;
    pay(m, seat, amount - h.bets[seat]); h.currentBet = amount;
    if (increase >= h.minRaise) { h.minRaise = increase; h.acted = []; }
    h.pending = [1 - seat];
  } else h.pending = h.pending.filter(s => s !== seat);
  h.acted.push(seat); h.actor = 1 - seat;
  event(m, 'action', { seat, action, ...(action === 'raise' ? { amount } : {}) });
  advance(m, now);
}
export function publicMatch(m, player = null) {
  const h = m.hand;
  const seat = m.players.indexOf(player);
  return structuredClone({
    id: m.id, version: m.version, status: m.status, players: m.players, stacks: m.stacks,
    buyIn: m.buyIn, smallBlind: m.smallBlind, bigBlind: m.bigBlind,
    turnSeconds: m.turnSeconds, maxHands: m.maxHands, handNo: m.handNo,
    deadline: m.deadline, result: m.result, events: m.events,
    hand: h ? {
      number: h.number, button: m.button, street: h.street, board: h.board,
      bets: h.bets, pot: h.contributed.reduce((a, b) => a + b, 0),
      actor: h.actor, currentBet: h.currentBet,
      ...(seat >= 0 && m.status === 'active' ? { yourSeat: seat, yourCards: h.holes[seat], legalActions: legalActions(m, seat) } : {}),
    } : null,
  });
}
