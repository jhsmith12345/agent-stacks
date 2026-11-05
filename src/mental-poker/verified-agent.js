import { PeerSession } from './session.js';
import { MentalPokerAgent } from './agent.js';

// Never grant decryption shares from a relay-supplied view. Reconstruct the
// obligation from authenticated, independently verified protocol messages first.
export class VerifiedPeerAgent {
  constructor(wallet, policy, config, createdAt, { now = Date.now } = {}) {
    if (!config.players.includes(wallet.player)) throw new Error('Agent is not a participant');
    if (!Number.isSafeInteger(createdAt) || Math.abs(now() - createdAt) > 300_000) throw new Error('Stale session creation time');
    this.now = now; this.clock = createdAt;
    this.session = new PeerSession(config, { now: () => this.clock });
    this.agent = new MentalPokerAgent(wallet, policy);
  }
  receive(entry) {
    if (!Number.isSafeInteger(entry.acceptedAt) || entry.acceptedAt < this.clock || Math.abs(this.now() - entry.acceptedAt) > 300_000) throw new Error('Invalid relay timestamp');
    const previous = this.clock; this.clock = entry.acceptedAt;
    try { return this.session.submit(entry.envelope); }
    catch (error) { this.clock = previous; throw error; }
  }
  nextCommand() { return this.agent.decide(this.session.view(), this.now()); }
  view() { return this.session.view(); }
}
