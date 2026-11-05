import { once } from 'node:events';
import { generateWallet } from '../src/crypto.js';
import { Protocol } from '../src/protocol.js';
import { createApp } from '../src/server.js';
import { AgentClient } from '../src/client.js';
import { chooseAction } from './strategy.js';

const server = createApp(new Protocol());
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const agents = [new AgentClient(url, generateWallet()), new AgentClient(url, generateWallet())];
console.log('Agent Stacks | two autonomous agents | test chips | local trusted dealer\n');
try {
  for (const agent of agents) await agent.send({ type: 'faucet' });
  let { match } = await agents[0].send({ type: 'create', buyIn: 1000, bigBlind: 20, maxHands: 8, turnSeconds: 30 });
  ({ match } = await agents[1].matchCommand('join', match.id));
  console.log(`Match ${match.id}\nBuy-in: 1,000 chips each | blinds: 10/20 | up to 8 hands`);
  let events = 0, decisions = 0;
  while (match.status === 'active') {
    if (++decisions > 2000) throw new Error('Demo action budget exceeded');
    const agent = agents[match.hand.actor];
    const { match: privateView } = await agent.view(match.id);
    const { action, amount } = chooseAction(privateView);
    ({ match } = await agent.act(privateView, action, amount));
    for (const event of match.events.slice(events)) {
      if (event.type === 'hand_complete') console.log(`  Hand ${event.hand}: ${event.winner === null ? 'split pot' : `agent ${'AB'[event.winner]} wins`} | contested pot ${event.pot} | board ${event.board.join(' ') || '(fold before flop)'}`);
    }
    events = match.events.length;
  }
  console.log(`\nMatch settled: A ${match.result.payouts[0]} / B ${match.result.payouts[1]} chips`);
  console.log(`Chip conservation: ${match.result.payouts.reduce((a, b) => a + b, 0)} / 2000`);
  for (let i = 0; i < 2; i++) console.log(`Wallet ${'AB'[i]} balance: ${(await agents[i].walletInfo()).balance}`);
} finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
