import { randomUUID } from 'node:crypto';
import { act, startHand, finishMatch, publicMatch } from './poker.js';
import { verifyEnvelope } from './crypto.js';
import { requireThat, integer } from './errors.js';

export function emptyState() { return { schema: 1, serverId: randomUUID(), wallets: {}, matches: {} }; }
export class Protocol {
  constructor(state = emptyState(), { now = Date.now, persist = () => {} } = {}) {
    this.state = state; this.now = now; this.persist = persist;
    this.state.serverId ??= randomUUID(); // State files older than this field get one on first load.
  }
  publicWallet(player) {
    const w = this.state.wallets[player];
    return { player, balance: w?.balance ?? 0, nextNonce: (w?.nonce ?? 0) + 1, funded: w?.funded ?? false, serverId: this.state.serverId };
  }
  list() { return Object.values(this.state.matches).map(m => publicMatch(m)); }
  get(id) {
    requireThat(Object.hasOwn(this.state.matches, id), 'NOT_FOUND', 'Match not found');
    return publicMatch(this.state.matches[id]);
  }
  execute(envelope) {
    requireThat(!this.storageFault, 'STORAGE_UNCERTAIN', 'A previous persistence failure requires state recovery before more commands');
    const now = this.now();
    const { player, command: c, nonce } = verifyEnvelope(envelope, now);
    requireThat(c && typeof c === 'object' && !Array.isArray(c), 'INVALID_ARGUMENT', 'Command object required');
    // A signature and fresh nonce would otherwise also be valid on any other server.
    requireThat(c.serverId === this.state.serverId, 'WRONG_SERVER', 'Command was signed for a different server');
    const s = structuredClone(this.state);
    // Use own properties: wallet IDs and match IDs originate outside the trust boundary.
    const w = Object.hasOwn(s.wallets, player) ? s.wallets[player] : { balance: 0, nonce: 0, funded: false };
    integer(nonce, 1, Number.MAX_SAFE_INTEGER, 'nonce');
    requireThat(nonce === w.nonce + 1, 'BAD_NONCE', `Expected nonce ${w.nonce + 1}`);
    s.wallets[player] = w;
    let m = null;
    if (['join', 'cancel', 'action', 'claim-timeout', 'view'].includes(c.type)) {
      requireThat(typeof c.matchId === 'string' && Object.hasOwn(s.matches, c.matchId), 'NOT_FOUND', 'Match not found');
      m = s.matches[c.matchId];
      if (c.type !== 'view') requireThat(c.expectedVersion === m.version, 'STALE_STATE', `Expected match version ${m.version}`);
    }
    switch (c.type) {
      case 'faucet':
        requireThat(!w.funded, 'FAUCET_USED', 'Test faucet can be used once per wallet');
        w.balance += 10_000; w.funded = true; break;
      case 'create': {
        const buyIn = integer(c.buyIn ?? 1000, 20, 1_000_000_000, 'buyIn');
        const bigBlind = integer(c.bigBlind ?? 20, 2, Math.floor(buyIn / 10), 'bigBlind');
        requireThat(bigBlind % 2 === 0, 'INVALID_ARGUMENT', 'bigBlind must be even');
        const turnSeconds = integer(c.turnSeconds ?? 86_400, 30, 259_200, 'turnSeconds');
        const maxHands = integer(c.maxHands ?? 20, 1, 100, 'maxHands');
        requireThat(w.balance >= buyIn, 'INSUFFICIENT_FUNDS', 'Fund your test wallet first');
        w.balance -= buyIn;
        m = { id: randomUUID(), version: 1, status: 'waiting', players: [player, null],
          stacks: [buyIn, 0], buyIn, bigBlind, smallBlind: bigBlind / 2,
          turnSeconds, maxHands, handNo: 0, button: 0, hand: null,
          deadline: now + turnSeconds * 1000, result: null, events: [] };
        s.matches[m.id] = m; break;
      }
      case 'join':
        requireThat(m.status === 'waiting', 'MATCH_NOT_WAITING', 'Match is not waiting');
        requireThat(now < m.deadline, 'DEADLINE_PASSED', 'The invitation expired');
        requireThat(m.players[0] !== player, 'SAME_PLAYER', 'Two different wallet keys required');
        requireThat(w.balance >= m.buyIn, 'INSUFFICIENT_FUNDS', 'Not enough test chips');
        w.balance -= m.buyIn; m.players[1] = player; m.stacks[1] = m.buyIn;
        m.status = 'active'; startHand(m, now); break;
      case 'cancel':
        requireThat(m.status === 'waiting' && m.players[0] === player, 'NOT_ALLOWED', 'Only the creator can cancel an unjoined match');
        finishMatch(m, 'cancelled'); break;
      case 'action': {
        const seat = m.players.indexOf(player);
        requireThat(seat >= 0, 'NOT_A_PLAYER', 'Only players can act');
        act(m, seat, c.action, c.amount, now); break;
      }
      case 'claim-timeout':
        requireThat(['waiting', 'active'].includes(m.status), 'MATCH_NOT_ACTIVE', 'Match already ended');
        requireThat(now >= m.deadline, 'TOO_EARLY', 'Deadline has not elapsed');
        if (m.status === 'waiting') finishMatch(m, 'invitation_expired');
        else {
          const loser = m.hand.actor;
          const total = m.stacks.reduce((a, b) => a + b, 0) + m.hand.contributed.reduce((a, b) => a + b, 0);
          m.stacks = [0, 0]; m.stacks[1 - loser] = total;
          m.hand.contributed = [0, 0]; m.hand.actor = null;
          finishMatch(m, 'timeout_forfeit');
        }
        break;
      case 'view':
        requireThat(m.players.includes(player), 'NOT_A_PLAYER', 'Private views require a player signature'); break;
      default: requireThat(false, 'UNKNOWN_COMMAND', 'Unknown command type');
    }
    if (m && c.type !== 'view' && c.type !== 'create') m.version++;
    if (m?.status === 'complete' && !m.paid) {
      for (let seat = 0; seat < 2; seat++) {
        if (m.players[seat]) s.wallets[m.players[seat]].balance += m.stacks[seat];
      }
      m.paid = true;
    }
    w.nonce = nonce;
    this.assertConservation(s);
    // A filesystem can fail after publishing the replacement. Freeze writes
    // until recovery rather than allowing old memory to overwrite newer disk.
    try { this.persist(s); }
    catch (error) { this.storageFault = true; throw error; }
    this.state = s;
    return { wallet: this.publicWallet(player), ...(m ? { match: publicMatch(m, player) } : {}) };
  }
  assertConservation(s) {
    let issued = 0, owned = 0;
    for (const w of Object.values(s.wallets)) {
      requireThat(Number.isSafeInteger(w.balance) && w.balance >= 0, 'INVARIANT', 'Invalid wallet balance');
      if (w.funded) issued += 10_000;
      owned += w.balance;
    }
    for (const m of Object.values(s.matches)) {
      requireThat(m.stacks.every(n => Number.isSafeInteger(n) && n >= 0), 'INVARIANT', 'Invalid stack');
      if (!m.paid) owned += m.stacks.reduce((a, b) => a + b, 0) + (m.hand?.contributed.reduce((a, b) => a + b, 0) ?? 0);
    }
    requireThat(owned === issued, 'INVARIANT', 'Test chip conservation failed');
  }
}
