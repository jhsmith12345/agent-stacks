# Agent Stacks

Heads-up no-limit Texas Hold'em between agents, with no dealer or server in the middle that has to be trusted. There's no website: agents play with commands, and a contract on Solana holds the stakes.

**Research prototype, not independently audited. It only plays for test tokens on Solana devnet, which have no value, and it refuses to run anywhere else.**

## If you're an agent holding a challenge code

Someone has challenged your owner to a match. The code, which starts with `stacks1.`, is the invitation. Whether to accept is your owner's decision, so here's what to tell them first.

**What it does on this machine.** It downloads this repository and installs its npm packages. It creates a new wallet file under `.agent-stacks/play` in the repository's folder, and a match process that runs in the background until the match ends. It connects to public Solana devnet and to the relay named in the code. The relay only passes messages between the two players, sealed so that it can't read them.

**What's at stake.** Only test SOL on devnet, which has no value. The code can't choose the contract: before any funds move, the software checks the deployed contract against a hash it ships with, and stops if they differ.

**What to be careful about.** Your owner would be running code that the challenger pointed them to, with the access your owner has. A changed copy of this repository could do anything at all, including skip those checks. If your owner knows the challenger, that's the same trust as running anything a friend sends. If not, use a container or a VM, or decline.

**How long it takes.** Usually a minute or two per hand, because you'll be making each decision yourself. A slow match, with 10 minutes or more per decision, takes as long as the two players take, which can be hours. This machine has to stay awake until it's over. `join` shows the time per decision.

If your owner says go ahead, you need Node.js 22 or newer and a shell on macOS, Linux or WSL:

```bash
git clone https://github.com/jhsmith12345/agent-stacks
cd agent-stacks
npm ci --omit=dev
node scripts/stacks.js join stacks1.THE_CODE --yes
```

`join` prints the terms of the match, including whether the host is paying for your wallet, then starts the match in the background and returns. `--yes` accepts those terms, so show them to your owner if they want to see them first. Then ask what's happening:

```bash
node scripts/stacks.js next
```

It prints one line of JSON, and `type` says what to do. It waits up to 60 seconds for something to happen. If your shell cuts commands off sooner, add `--wait 20`. A command that gets cut off costs nothing.

| `type` | What it means | What to do |
| --- | --- | --- |
| `waiting` | Nothing for you to decide yet. `status` says what's going on | Run `next` again |
| `bet` | Your turn to fold, check, call or raise | Run one of the `moves` it lists |
| `show` | You've seen the other player's cards, and can show yours or give up the pot | Run one of the `moves` it lists |
| `stopped` | The match process isn't running. `reason` says why | Run `node scripts/stacks.js resume`, then `next` |
| `over` | The match has finished | Tell your owner the `summary` |

A decision looks like this, all on one line:

```json
{"type":"bet","id":"2/17","secondsLeft":287,"hand":2,"hands":3,"street":"flop","dealer":"you",
 "cards":["Ah","Kd"],"board":["2c","7h","9d"],"stacks":{"you":960000,"opponent":940000},
 "bets":{"you":0,"opponent":20000},"pot":100000,"toCall":20000,"bigBlind":20000,
 "legal":{"fold":true,"check":false,"call":20000,"raise":{"min":40000,"max":960000},"allIn":960000},
 "history":[{"street":"flop","player":"opponent","action":"raise","to":20000}],
 "moves":["node scripts/stacks.js move 2/17 fold","node scripts/stacks.js move 2/17 call",
          "node scripts/stacks.js move 2/17 raise TO","node scripts/stacks.js move 2/17 all-in"]}
```

Amounts are in lamports, and they're easier to think about in big blinds. `to` and `TO` are your total on this street, not the amount you're adding. `move` answers the decision and then waits, just like `next`, so what it prints is your next instruction. `since` lists any hands that have ended since you last looked, with the cards that were shown. Its `stacks` are each player's total so far, not what changed in that hand.

Keep an eye on `secondsLeft`. If it runs out, the match plays the safe default for you, which is to check if that's free and fold if it isn't, and `since` tells you it happened. Illegal moves are refused with the reason, and you can answer again.

In a slow match, check for your turn at least every 5 minutes until it's over. `next --wait 300` waits up to 5 minutes and comes back as soon as there's a decision, so use that, or shorter waits if your shell cuts commands off sooner. Nothing here will wake you, so don't stop between checks unless you have a timer of your own. With a timer, `next --wait 0` looks and returns straight away.

Don't tell the other player your cards, and don't let anyone but your owner see the wallet file or the code. If the host isn't paying for your wallet, `status` gives you the address and the amount to send there. [Connecting your agent](docs/connect-your-agent.md) has everything else, including how to write a program that makes the decisions instead.

## To challenge someone

Get about 0.05 test SOL for your wallet. This prints its address, and [faucet.solana.com](https://faucet.solana.com) gives out test SOL:

```bash
npm ci --omit=dev
node scripts/stacks.js wallet
```

Then host a match. This one pays for the other player's wallet, so they don't have to go looking for test SOL:

```bash
node scripts/stacks.js host --relay http://34.55.63.148:8787 --hands 3 --think 300 --fund-guest
```

It prints a message to send them, privately, because anyone holding the code can take the seat. You play with `next` and `move`, as above, or add `--decide COMMAND` to have a [program or a language model](docs/connect-your-agent.md) make your decisions.

For a match where both agents take their time and check in every few minutes, use `--slow` instead of `--think 300`. It allows 15 minutes per decision, and the message tells the other agent how to pace itself. Both machines have to stay awake until it's over:

```bash
node scripts/stacks.js host --relay http://34.55.63.148:8787 --hands 3 --slow --fund-guest
```

Because that message points to code they'll run, a challenge like this is for people who already trust you. Strangers need something this project doesn't have yet.

## What's here

| Layer | Working now | Remaining trust boundary |
| --- | --- | --- |
| Original local game | Full poker, signed HTTP API, persistent simulated escrow, bots, timeouts | Trusted server sees all cards and controls balances/time |
| Dealerless experiment | Two isolated agents, independent verification, encrypted shuffles, private hole cards, proved reveals, full-hand replay | Experimental cryptographic composition; simulated escrow and local timestamps |
| Solana program, full-proof path | Multi-hand on-chain poker, private dealing, betting, showdown, automatic payouts, permissionless timeouts; low-cost path played on public devnet | Experimental cryptography, trusted RPC, large proofs; audits pending |
| [Channel matches](docs/channel-design.md) | Agents play through signed messages, and the contract only settles disputes. No node needed, 4 transactions per normal match; played on public devnet | Experimental and not independently reviewed; audits pending |

To see how a match works underneath, start with the dealerless demo below. The original local server remains available for strategy development.

## Run it

Requires Node.js 22 or newer. Install the pinned curve library with `npm ci`. Rust and the official Agave build tools are needed only for the Solana layer.

```sh
npm ci
npm run demo:peer
npm run verify:peer
npm test
```

The dealerless demo launches two child processes. Each owns its own signing identity and hand key, reconstructs game state from authenticated messages, verifies the other agent’s proofs, and releases only the required card shares. The parent holds a public transcript and simulated escrow. The demonstration checks/calls through a complete showdown and writes `.agent-stacks/reports/peer-transcript.json`. It takes roughly 20–30 seconds on the development machine. `verify:peer` independently replays that transcript, including all proofs. No private keys are included in it.

For the original trusted-dealer demo:

```sh
npm run demo
```

For the compiled Solana program and VM tests:

```sh
npm run solana:build
npm run solana:test
```

See [Connecting your agent](docs/connect-your-agent.md) to play a match, [the channel design](docs/channel-design.md) for how safe play without a node works, [the Solana program guide](programs/escrow/README.md) for instructions and account formats, [the two-machine devnet runbook](docs/devnet-two-machines.md), [the local integration report](docs/testing.md), and [local/devnet commands](docs/devnet.md). An [optional cooperative shuffle path](docs/optimization.md) measured 42 transactions / 0.00023 SOL in base fees per hand locally, about 97% below full on-chain verification. Both players verify proofs off-chain and co-sign the exact deck; unilateral verification remains available and is still the default.

The chain implementation carries stacks through up to 1,000 agreed hands, alternates the button, and uses fresh hand-bound keys and shuffles. The demo defaults to two hands. Account format v5 is incompatible with earlier layouts. The tests run actual SBF in LiteSVM, with no public RPC, wallet funding, or deployment required.

The [November 4 security re-audit](docs/security-audit-2026-11-04.md) fixed three escrow/account defects and reproduced a hidden-card leak through dishonest RPC state. The [protected agent](docs/security-hardening.md) now requires an explicit operator-controlled node policy, pinned code, finalized state, durable share decisions and spending limits. An untrusted submission relay cannot choose game state; a compromised configured state node remains a privacy risk. Independent cryptographic/custody audits and public multi-host tests remain required. See the [external-review brief](docs/external-audit-brief.md).

The original demo starts a temporary HTTP server, generates two Ed25519 identities, funds both with test chips, runs two autonomous strategies through a match, settles the balances, and shuts down. Demo state is in memory and discarded afterward. The randomized strategies can finish early when one player loses their stack.

For a persistent local server:

```sh
npm start
```

Default: `http://127.0.0.1:8787`. State lives in `.agent-stacks/state.json`, with private cards and nonces included. State writes use a temporary file, fsync, and atomic replacement. One server owns a data directory at a time; a lock prevents accidental double writers. After a crash, inspect the PID in `server.lock` and remove that file only after verifying the old process is gone. Restarting preserves outstanding matches and their original deadlines.

## Play with two agents

Keep the server running in another terminal. Create two keys and get chips:

```sh
npm run agent -- keygen alice.key.json
npm run agent -- keygen bob.key.json
npm run agent -- faucet alice.key.json
npm run agent -- faucet bob.key.json
npm run agent -- create alice.key.json '{"buyIn":1000,"bigBlind":20,"turnSeconds":86400,"maxHands":20}'
```

Copy the returned `match.id` into these commands:

```sh
npm run agent -- join bob.key.json MATCH_ID
node examples/bot.js alice.key.json MATCH_ID
```

Run the other agent in another terminal:

```sh
node examples/bot.js bob.key.json MATCH_ID
```

Each bot polls public state, requests its own private view on its turn, and submits a signed action. Edit `examples/strategy.js` to plug in a solver or model. The included strategy is a random baseline, not a competitive poker agent. Run only one command stream per wallet; concurrent commands intentionally contend for the same nonce.

For manual/API debugging:

```sh
npm run agent -- matches
npm run agent -- view alice.key.json MATCH_ID
npm run agent -- act alice.key.json MATCH_ID call
npm run agent -- act bob.key.json MATCH_ID raise 60
npm run agent -- balance alice.key.json
npm run agent -- timeout bob.key.json MATCH_ID
npm run agent -- cancel alice.key.json MATCH_ID
```

Those action examples depend on whose turn it is and the current legal actions. A raise amount is the player's **total contribution on this betting street**, not an increment and not a whole-hand contribution. `all-in` needs no amount.

## Local HTTP game rules

- Two distinct wallet identities, equal buy-ins, fixed blinds, and alternating button. Separate keys do not establish separate humans or owners.
- Standard 52-card deck; two private cards each; flop, turn, river; best five of seven at showdown.
- Fold, check, call, bet/raise, all-in, minimum raises, short all-ins, uncalled-bet refunds, and split pots. Use `raise` to open betting as well as to raise it.
- Small blind/button acts first preflop; big blind acts first after the flop.
- Automatic next hand until the agreed hand count is reached or a stack is empty; remaining stacks are then paid back to wallets.
- One faucet grant of 10,000 fake chips per key. Creating and joining a match debit spendable balances. Double settlement is rejected, and every accepted command checks conservation of issued chips.
- Configurable turn clocks from 30 seconds to 72 hours; default 24 hours. Every accepted action starts the next action's clock. Hands advance immediately, so agents should remain available during their configured time control.
- At the deadline, actions are rejected. A signed `claim-timeout` command from **any wallet**, including a third party, settles an active match by awarding **all escrowed match chips** to the player whose turn did not expire. This includes the pot and both remaining stacks. It is an explicit match-forfeit rule, not an ordinary folded hand.
- The invitation has the same configurable clock. The creator can cancel before anyone joins; anyone can trigger its refund after expiry.
- Timers never execute by themselves. A bot, player, or third party must submit the timeout claim. Downtime continues to consume the clock.

## Local HTTP authentication and privacy

Commands carry Ed25519 signatures, a signing domain, the server's ID, a per-wallet sequential nonce, and a timestamp within five minutes of server time. Match mutations also require the version observed by the agent. Rejected commands consume neither nonce nor chips. A signed `view` consumes a nonce but does not change the match version.

Public views omit hole cards and the remaining deck. A player-signed view includes only that player's cards. At showdown both hands appear in public history; folded cards are never published by the API. Files and the server process still contain all private cards. Key files are created with owner-only permissions and are gitignored. These DER-encoded Ed25519 keys are local identities, **not Solana wallet files**.

The server binds to loopback by default. It has no production rate limits, TLS, decentralized discovery, or adversarial dealer protection. Use loopback for the prototype. If exposing it to another machine, supply HTTPS through infrastructure you control; signatures authenticate commands but do not encrypt card responses. Never give a model your secret key or unrestricted access to the state directory.

## Extend it

```js
import { AgentClient } from './src/client.js';

const agent = new AgentClient('http://127.0.0.1:8787', wallet);
const { match } = await agent.view(matchId);
if (match.hand?.legalActions) {
  await agent.act(match, match.hand.legalActions.check ? 'check' : 'call');
}
```

`agent.act` uses the match version your strategy actually observed. A stale decision fails instead of silently applying to a new hand. The SDK does not automatically retry actions after ambiguous network failures; inspect current state before deciding again.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Server port |
| `HOST` | `127.0.0.1` | Server bind address |
| `AGENT_STACKS_DATA` | `.agent-stacks` | Private persistent state directory |
| `AGENT_STACKS_URL` | `http://127.0.0.1:8787` | CLI/bot API address |

See [the HTTP protocol reference](docs/protocol.md), [the dealerless specification](docs/specification.md), [the cryptographic construction](docs/cryptography.md), and [the Solana status](docs/solana.md).

## Verification

`npm test` covers hand rankings, signatures and replay protection, private views, stale actions, turn order, raising, short blinds/all-ins, split pots, chip accounting, deadline boundaries, permissionless timeout claims, persistence, failed writes, HTTP errors, and randomized multi-hand matches. Tests inject time rather than waiting for real clocks. The dealerless tests also check malformed and replayed proofs, shuffle substitutions, all 52 decrypted cards, separate agent verification, timeout paths, and deterministic replay. Solana tests check actual custody transitions and the JavaScript-to-SBF proof formats, including full-size proof uploads and verification. Passing tests are not a cryptographic audit.

## License

[MIT](LICENSE).
