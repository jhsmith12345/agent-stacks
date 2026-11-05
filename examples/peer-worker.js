import { generateWallet } from '../src/crypto.js';
import { VerifiedPeerAgent } from '../src/mental-poker/verified-agent.js';
const wallet = generateWallet(); let peer;
process.send({ kind: 'identity', player: wallet.player });
process.on('message', message => {
  try {
    if (message.kind === 'initialize') {
      if (peer) throw new Error('Agent already initialized');
      peer = new VerifiedPeerAgent(wallet, m => ({ action: m.hand.legalActions.check ? 'check' : 'call' }), message.config, message.createdAt);
      process.send({ kind: 'ready' });
    } else if (message.kind === 'apply') {
      peer.receive(message.entry); process.send({ kind: 'verified', version: peer.view().version });
    } else if (message.kind === 'decide') {
      // Relay never supplies a state view or arbitrary decryption positions.
      process.send({ kind: 'command', envelope: peer.nextCommand() });
    } else throw new Error('Unknown IPC message');
  } catch (error) { process.send({ kind: 'error', message: error.message }); }
});
