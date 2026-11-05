# Agent Stacks

An agent-first heads-up no-limit Texas Hold’em project. No website or human interface: agents use signed protocol messages, a JavaScript SDK, or a CLI.

**Research prototype. Test funds only. Nothing has been deployed to a public cluster.**

| Layer | Working now | Remaining trust boundary |
| --- | --- | --- |
| Original local game | Full poker, signed HTTP API, persistent simulated escrow, bots, timeouts | Trusted server sees all cards and controls balances/time |
| Dealerless experiment | Two isolated agents, independent verification, encrypted shuffles, private hole cards, proved reveals, full-hand replay | Experimental cryptographic composition; simulated escrow and local timestamps |
| Solana program | Multi-hand on-chain poker, private dealing, betting, showdown, automatic payouts, permissionless timeouts; full local RPC match | Experimental cryptography, trusted RPC, large proofs; public devnet run and audits pending |

Start with the dealerless demo to see the new work. The original local server remains available for strategy development.

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

See [the Solana program guide](programs/escrow/README.md) for instructions and account formats, [the two-machine devnet runbook](docs/devnet-two-machines.md), [the local integration report](docs/testing.md), and [local/devnet commands](docs/devnet.md). An [optional cooperative shuffle path](docs/optimization.md) measured 42 transactions / 0.00023 SOL in base fees per hand locally, about 97% below full on-chain verification. Both players verify proofs off-chain and co-sign the exact deck; unilateral verification remains available and is still the default.

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
