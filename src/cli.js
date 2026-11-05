import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateWallet } from './crypto.js';
import { AgentClient } from './client.js';
const [command, walletFile, ...args] = process.argv.slice(2);
const usage = `Agent Stacks — local test chips only

npm run agent -- keygen alice.key.json
npm run agent -- faucet alice.key.json
npm run agent -- create alice.key.json '{"buyIn":1000,"bigBlind":20,"turnSeconds":86400,"maxHands":20}'
npm run agent -- join bob.key.json MATCH_ID
npm run agent -- view alice.key.json MATCH_ID
npm run agent -- act alice.key.json MATCH_ID call
npm run agent -- act alice.key.json MATCH_ID raise 60
npm run agent -- timeout alice.key.json MATCH_ID
npm run agent -- cancel alice.key.json MATCH_ID
npm run agent -- balance alice.key.json
npm run agent -- matches

Actions: fold | check | call | raise STREET_TOTAL | all-in
Set AGENT_STACKS_URL to override http://127.0.0.1:8787.
Key files are secrets. Run one outstanding command per wallet at a time.`;
try {
  if (!command || command === 'help' || command === '--help') console.log(usage);
  else if (command === 'keygen') {
    if (!walletFile) throw new Error('Provide an output key filename');
    const wallet = generateWallet();
    writeFileSync(resolve(walletFile), JSON.stringify(wallet, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ player: wallet.player, keyFile: resolve(walletFile) }, null, 2));
  } else {
    const url = process.env.AGENT_STACKS_URL ?? 'http://127.0.0.1:8787';
    if (command === 'matches') {
      const response = await fetch(`${url}/v1/matches`); console.log(JSON.stringify(await response.json(), null, 2));
    } else {
      if (!walletFile) throw new Error('Provide a wallet key file');
      const client = new AgentClient(url, JSON.parse(readFileSync(resolve(walletFile), 'utf8')));
      let result;
      switch (command) {
        case 'faucet': result = await client.send({ type: 'faucet' }); break;
        case 'balance': result = await client.walletInfo(); break;
        case 'create': result = await client.send({ ...(args[0] ? JSON.parse(args[0]) : {}), type: 'create' }); break;
        case 'join': case 'cancel': result = await client.matchCommand(command, args[0]); break;
        case 'timeout': result = await client.matchCommand('claim-timeout', args[0]); break;
        case 'view': result = await client.view(args[0]); break;
        case 'act': {
          const { match } = await client.view(args[0]);
          result = await client.act(match, args[1], args[2] === undefined ? undefined : Number(args[2])); break;
        }
        default: throw new Error(`Unknown command ${command}; run npm run agent -- help`);
      }
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? 'CLIENT_ERROR', message: error.message } })); process.exitCode = 1;
}
