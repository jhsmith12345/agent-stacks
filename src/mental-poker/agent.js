import { makeKey } from './proofs.js';
import { decryptionShare, privateCard } from './deck.js';
import { shuffleAndProve } from './shuffle.js';
import { cryptoContext, HOLES, PEER_DOMAIN } from './session.js';
import { signCommand } from '../crypto.js';

// Low-level signer: view MUST already be authenticated/verified. Prefer
// VerifiedPeerAgent at a transport boundary. Never serialize this private object.
export class MentalPokerAgent {
  constructor(wallet, policy) { this.wallet = wallet; this.policy = policy; this.keys = new Map(); }
  decide(view, now = Date.now()) {
    const o = view.obligation;
    if (!o || view.players[o.seat] !== this.wallet.player) throw new Error('Agent is not obligated');
    const seat = o.seat;
    let command = { type: o.kind, matchId: view.id, termsHash: view.termsHash, handNo: view.handNo, expectedVersion: view.version };
    const keyId = `${view.id}:${view.handNo}`;
    if (o.kind === 'accept') command.termsHash = view.termsHash;
    else if (o.kind === 'key') {
      const key = this.keys.get(keyId) ?? makeKey(cryptoContext(view, 'key', seat)); this.keys.set(keyId, key);
      command.registration = key.registration;
    } else if (o.kind === 'shuffle') {
      command.proof = shuffleAndProve(view.crypto.deck, view.crypto.jointKey, cryptoContext(view, 'shuffle', seat));
    } else {
      const key = this.keys.get(keyId);
      if (!key) throw new Error('Private hand key missing; restore private agent state');
      if (['hole-share', 'board-share', 'showdown-share'].includes(o.kind)) {
        command.shares = o.positions.map(position => decryptionShare(key.secret, view.crypto.deck[position], cryptoContext(view, o.kind, seat, position)));
      } else if (o.kind === 'action') {
        const cards = HOLES[seat].map(position => privateCard(key.secret, view.crypto.deck[position],
          view.crypto.keys[1 - seat], view.crypto.holeShares[position], cryptoContext(view, 'hole-share', 1 - seat, position)));
        const privateView = structuredClone(view);
        privateView.hand.yourCards = cards; privateView.hand.yourSeat = seat;
        privateView.hand.legalActions = view.legalActions;
        const choice = this.policy(privateView);
        // A strategy proposes a poker move; it cannot replace the signing
        // context, message type, match, nonce or cryptographic payload.
        command = { ...command, action: choice?.action,
          ...(choice?.amount === undefined ? {} : { amount: choice.amount }) };
      }
    }
    return signCommand(this.wallet, command, (view.nonces[this.wallet.player] ?? 0) + 1, now, PEER_DOMAIN);
  }
}
