import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { AgentClient } from '../src/client.js';
import { chooseAction } from './strategy.js';

const [walletFile, matchId] = process.argv.slice(2);
if (!walletFile || !matchId) {
  console.error('Usage: node examples/bot.js WALLET.key.json MATCH_ID'); process.exit(1);
}
const client = new AgentClient(process.env.AGENT_STACKS_URL ?? 'http://127.0.0.1:8787', JSON.parse(readFileSync(walletFile, 'utf8')));
try {
  for (;;) {
    const { match } = await client.request(`/v1/matches/${encodeURIComponent(matchId)}`);
    if (!match.players.includes(client.wallet.player)) throw new Error('Wallet is not seated in this match; join first');
    if (match.status === 'complete') { console.log(JSON.stringify({ result: match.result })); break; }
    try {
      if (Date.now() >= match.deadline) {
        const result = await client.matchCommand('claim-timeout', matchId);
        console.log(JSON.stringify({ result: result.match.result })); break;
      }
      if (match.status === 'active' && match.players[match.hand.actor] === client.wallet.player) {
        const { match: privateView } = await client.view(matchId);
        if (!privateView.hand?.legalActions) continue;
        const choice = chooseAction(privateView);
        await client.act(privateView, choice.action, choice.amount);
        console.log(JSON.stringify({ hand: privateView.handNo, ...choice }));
      }
    } catch (error) {
      if (!['STALE_STATE', 'OUT_OF_TURN', 'DEADLINE_PASSED', 'TOO_EARLY', 'MATCH_NOT_ACTIVE'].includes(error.code)) throw error;
    }
    await setTimeout(300);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
