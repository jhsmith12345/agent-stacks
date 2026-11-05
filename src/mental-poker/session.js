import { act, startHand, resumeExternalDeal, resumeExternalShowdown, legalActions, finishMatch, publicMatch } from '../poker.js';
import { verifyEnvelope, playerKey } from '../crypto.js';
import { requireThat, integer } from '../errors.js';
import { aggregateKeys, verifyKey } from './proofs.js';
import { initialDeck, verifyShare, revealCard } from './deck.js';
import { verifyShuffle } from './shuffle.js';
import { digest } from './group.js';

export const PEER_DOMAIN = 'agent-stacks/mental-poker/local/v1';
export const HOLES = [[0, 2], [1, 3]];
export const BOARD = { flop: [5, 6, 7], turn: [9], river: [11] };
export function cryptoContext(m, phase, seat, position = null) {
  return JSON.stringify({ protocol: PEER_DOMAIN, match: m.id, terms: m.termsHash, hand: m.handNo, phase, seat, position });
}
const timeout = (m, now) => { m.deadline = now + m.turnSeconds * 1000; };
function obligation(m, kind, seat, now, positions = []) {
  m.obligation = { kind, seat, positions }; timeout(m, now);
}
function synchronize(m, now) {
  if (m.status === 'complete') { m.obligation = null; return; }
  if (m.crypto?.handNo !== m.handNo) {
    m.crypto = { handNo: m.handNo, keys: [null, null], deck: null, holeShares: {}, publicShares: {}, shuffleHashes: [] };
    obligation(m, 'key', 0, now); return;
  }
  if (m.hand.phase === 'betting') obligation(m, 'action', m.hand.actor, now);
  else if (m.hand.phase === 'awaiting-board') obligation(m, 'board-share', 0, now, BOARD[m.hand.street]);
  else if (m.hand.phase === 'awaiting-showdown') obligation(m, 'showdown-share', 0, now, HOLES[0]);
}
function checkShares(m, c, phase, seat, positions) {
  requireThat(Array.isArray(c.shares) && c.shares.length === positions.length, 'BAD_PROOF', 'Wrong number of decryption shares');
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];
    requireThat(verifyShare(m.crypto.keys[seat], m.crypto.deck[position], c.shares[i], cryptoContext(m, phase, seat, position)),
      'BAD_PROOF', `Invalid decryption proof for position ${position}`);
  }
}

// This is a deterministic public verifier and simulated escrow, not a network or chain.
// State contains encrypted cards and proof-backed shares; never a secret key or folded hand.
export class PeerSession {
  constructor({ id, players, buyIn = 1000, bigBlind = 20, turnSeconds = 86_400, maxHands = 1 }, { now = Date.now } = {}) {
    requireThat(typeof id === 'string' && id.length > 0 && id.length <= 128, 'INVALID_ARGUMENT', 'Match ID required');
    requireThat(Array.isArray(players) && players.length === 2 && players.every(p => typeof p === 'string') && players[0] !== players[1],
      'INVALID_ARGUMENT', 'Two distinct player keys required');
    players.forEach(playerKey);
    players = [...players];
    integer(buyIn, 20, 1_000_000_000, 'buyIn'); integer(bigBlind, 2, Math.floor(buyIn / 10), 'bigBlind');
    requireThat(bigBlind % 2 === 0, 'INVALID_ARGUMENT', 'Even bigBlind required');
    integer(turnSeconds, 30, 259_200, 'turnSeconds'); integer(maxHands, 1, 100, 'maxHands');
    this.now = now; this.transcript = []; this.createdAt = now();
    const terms = { id, players, buyIn, bigBlind, turnSeconds, maxHands };
    this.state = { ...terms, termsHash: digest('agent-stacks/terms/v1', terms).toString('hex'),
      version: 0, status: 'consenting', stacks: [buyIn, buyIn], smallBlind: bigBlind / 2,
      handNo: 0, hand: null, crypto: null, button: 0, events: [], result: null,
      dealing: 'external', nonces: {}, obligation: { kind: 'accept', seat: 0, positions: [] },
      deadline: this.createdAt + turnSeconds * 1000 };
  }
  view() {
    const m = this.state;
    return structuredClone({ ...publicMatch(m), termsHash: m.termsHash, crypto: m.crypto,
      obligation: m.obligation, nonces: m.nonces,
      legalActions: m.obligation?.kind === 'action' ? legalActions(m, m.obligation.seat) : null });
  }
  submit(envelope) {
    const now = this.now();
    const { player, nonce, command: c } = verifyEnvelope(envelope, now, PEER_DOMAIN);
    const m = structuredClone(this.state), seat = m.players.indexOf(player);
    requireThat(c && c.matchId === m.id && c.termsHash === m.termsHash && c.handNo === m.handNo && c.expectedVersion === m.version, 'STALE_STATE', 'Wrong match, terms, hand, or version');
    requireThat(Number.isSafeInteger(nonce) && nonce === (m.nonces[player] ?? 0) + 1, 'BAD_NONCE', 'Wrong nonce');
    requireThat(m.status !== 'complete', 'MATCH_NOT_ACTIVE', 'Match already complete');
    if (c.type === 'claim-timeout') {
      requireThat(now >= m.deadline, 'TOO_EARLY', 'Deadline has not elapsed');
      if (m.status === 'consenting') finishMatch(m, 'consent_expired');
      else {
        const total = m.stacks.reduce((a, b) => a + b, 0) + m.hand.contributed.reduce((a, b) => a + b, 0);
        const loser = m.obligation.seat;
        m.stacks = [0, 0]; m.stacks[1 - loser] = total;
        m.hand.contributed = [0, 0]; m.hand.actor = null;
        finishMatch(m, 'timeout_forfeit');
      }
      m.obligation = null;
    } else {
      requireThat(now < m.deadline, 'DEADLINE_PASSED', 'Obligation expired');
      requireThat(seat >= 0 && seat === m.obligation.seat, 'OUT_OF_TURN', 'Not the obligated player');
      requireThat(c.type === m.obligation.kind, 'WRONG_PHASE', `Expected ${m.obligation.kind}`);
      const positions = m.obligation.positions;
      switch (c.type) {
        case 'accept':
          requireThat(c.termsHash === m.termsHash, 'WRONG_TERMS', 'Match terms differ');
          if (seat === 0) obligation(m, 'accept', 1, now);
          else { m.status = 'active'; startHand(m, now); synchronize(m, now); }
          break;
        case 'key':
          requireThat(verifyKey(c.registration, cryptoContext(m, 'key', seat)), 'BAD_PROOF', 'Invalid key possession proof');
          m.crypto.keys[seat] = c.registration;
          if (seat === 0) obligation(m, 'key', 1, now);
          else {
            m.crypto.jointKey = aggregateKeys(m.crypto.keys, [0, 1].map(s => cryptoContext(m, 'key', s)));
            m.crypto.deck = initialDeck(); obligation(m, 'shuffle', 0, now);
          }
          break;
        case 'shuffle':
          requireThat(verifyShuffle(m.crypto.deck, m.crypto.jointKey, cryptoContext(m, 'shuffle', seat), c.proof), 'BAD_PROOF', 'Invalid shuffle proof');
          m.crypto.deck = c.proof.output;
          m.crypto.shuffleHashes.push(digest('agent-stacks/shuffle-proof/v1', c.proof).toString('hex'));
          if (seat === 0) obligation(m, 'shuffle', 1, now);
          else obligation(m, 'hole-share', 1, now, HOLES[0]);
          break;
        case 'hole-share':
          checkShares(m, c, 'hole-share', seat, positions);
          positions.forEach((position, i) => { m.crypto.holeShares[position] = c.shares[i]; });
          if (seat === 1) obligation(m, 'hole-share', 0, now, HOLES[1]);
          else { resumeExternalDeal(m, now); synchronize(m, now); }
          break;
        case 'action':
          act(m, seat, c.action, c.amount, now); synchronize(m, now); break;
        case 'board-share':
          checkShares(m, c, 'board-share', seat, positions);
          positions.forEach((position, i) => {
            m.crypto.publicShares[position] ??= [null, null]; m.crypto.publicShares[position][seat] = c.shares[i];
          });
          if (seat === 0) obligation(m, 'board-share', 1, now, positions);
          else {
            for (const position of positions) m.hand.board.push(revealCard(m.crypto.deck[position], m.crypto.publicShares[position]));
            resumeExternalDeal(m, now); synchronize(m, now);
          }
          break;
        case 'showdown-share':
          checkShares(m, c, 'showdown-share', seat, positions);
          positions.forEach((position, i) => { m.crypto.publicShares[position] = [null, null];
            m.crypto.publicShares[position][seat] = c.shares[i];
            m.crypto.publicShares[position][1 - seat] = m.crypto.holeShares[position];
          });
          if (seat === 0) obligation(m, 'showdown-share', 1, now, HOLES[1]);
          else {
            const holes = HOLES.map(ps => ps.map(position => revealCard(m.crypto.deck[position], m.crypto.publicShares[position])));
            resumeExternalShowdown(m, holes, now); synchronize(m, now);
          }
          break;
        default: requireThat(false, 'UNKNOWN_COMMAND', 'Unknown peer command');
      }
    }
    const held = m.stacks.reduce((a, b) => a + b, 0) + (m.hand?.contributed.reduce((a, b) => a + b, 0) ?? 0);
    requireThat(held === 2 * m.buyIn && m.stacks.every(s => Number.isSafeInteger(s) && s >= 0), 'INVARIANT', 'Escrow conservation failed');
    m.nonces[player] = nonce; m.version++;
    this.state = m; this.transcript.push({ acceptedAt: now, envelope: structuredClone(envelope) });
    return this.view();
  }
}
