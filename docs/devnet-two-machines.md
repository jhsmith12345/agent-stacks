# Two-machine devnet runbook

**Status: the deploy and the low-cost demo have run on public devnet, and the whole procedure has been rehearsed on a local validator using devnet's feature set. The full-proof path hasn't run on public devnet, and no run has used two machines.** Test funds only. The client refuses mainnet and the agent accepts only `test-only` policies, so nothing here can touch real funds.

## What this run proves

The standalone agent plays the full-proof path using only the chain, so the two machines need no direct connection. They share one file: the match manifest.

| Stage | Node | Policy flag | What it's evidence for |
| --- | --- | --- | --- |
| 1. Timing | A hosted RPC endpoint | `--third-party-rpc` | Real network timing, cost, and recovery from crashes and outages |
| 2. Trust boundary | A validating node each operator runs | `--operator-controlled` | The [release gate](security-hardening.md) for separately operated nodes |

Stage 1 is cheap, but the provider could lie about chain state, so it says nothing about the trust boundary. The flag records that in the policy and preflight repeats it.

## Devnet as measured

These were read from the live cluster on 2026-11-05. Rerun `npm run devnet:preflight` for current values, because several of them are changing.

| Item | Measured | Why it matters |
| --- | --- | --- |
| Software | Agave 4.4.0 on 96.6% of stake; the public RPC answered from a 4.4.0 beta | Matches the pinned tools |
| Consensus | Alpenglow active since slot 504144000; finalized stayed level with confirmed in all 12 samples | Finality is far quicker than the roughly 13 seconds local runs assumed |
| Slot time | About 0.24 s | Local validators default to 0.4 s, and a blockhash expires sooner |
| Rent | 5,080 lamports per byte, with cuts to 2,575, 1,322 and 696 queued | A proof buffer costs 3.32 SOL, where a default local validator charges 4.54 SOL. Budgets must be read from the cluster |
| Public RPC | About 50 ms; 30 parallel requests had 21 refused with HTTP 429; 30 requests at 10 per second had none in one sample and 4 refused in another | One busy agent is close to the limit, and two on one IP will go over it |
| Priority fees | 0 at every percentile sampled | No bidding needed today, but a policy can't change mid-match, so set a ceiling up front |
| Mainnet | Same rent and consensus features as devnet | Devnet is a fair preview at the moment |

A default `solana-test-validator` switches on almost every feature, including some devnet doesn't have. Rehearse with `--clone-feature-set --url https://api.devnet.solana.com` to run devnet's rules. That still leaves rent and slot time at local defaults.

## Getting test SOL

`node scripts/devnet.js status` prices the run from current rent. On 2026-11-05 that was:

| Wallet | SOL | Needed for |
| --- | --- | --- |
| Project payer (deployer) | 1.00 | Program storage and write fees; about 0.05 of this is a safety margin |
| Player A | 3.36 | Deposit, match account, one proof buffer, worst-case fees |
| Player B | 3.34 | Deposit, one proof buffer, worst-case fees |
| **Total** | **7.70** | 6.63 returns to the players as each buffer closes |

You don't need all of it to get a first public result. The demo in [local/devnet commands](devnet.md) runs both players on one machine, with the payer lending player B its funds. Rehearsed on minimum funding and scaled to devnet's rent, that needs:

| Run | SOL | What it shows |
| --- | --- | --- |
| Deploy plus low-cost demo | 1.05 | The program deploys and plays on the public network, with real finality and cost |
| Deploy plus full-proof demo | 4.40 | Real timing for the full-proof shuffle |
| Separate player wallets, as below | 7.70 | The two-machine run this runbook describes |

Real SOL doesn't become test SOL: mainnet and devnet are separate ledgers, so sending real SOL to an address leaves its devnet balance unchanged. Where test SOL can come from, as of 2026-11-05:

- **`solana airdrop` no longer works on the public endpoint.** The CLI reports a possible rate limit, but the node's actual reply is HTTP 410, "The RPC faucet is closed on this cluster". Retrying can't help.
- **[Solana web faucet](https://faucet.solana.com):** for people, not automated tools. Signing in with GitHub raises its limit, but its checks can refuse an account, and it refused one with too few public repos. Don't make a private repo public to pass that check.
- **[Chainstack's faucet](https://chainstack.com/solana-faucet/) and other provider faucets:** each needs an account with that provider. Several faucets that advertise no requirements failed when tried on 2026-11-05.
- **[QuickNode's faucet](https://faucet.quicknode.com/solana/devnet):** needs no account, but requires a small mainnet balance on the claiming wallet, and allows one claim per address every 12 hours. Claim with a wallet you already own if you can, then send the test SOL across on devnet. Using the project payer instead puts real SOL on a key stored unencrypted, so send only the minimum and move it off once you've finished claiming.
- **A person who already has devnet SOL** can simply send it. It has no value.
- **`devnet-pow`:** pays for computation, and is listed in [Solana's guide](https://solana.com/developers/guides/getstarted/solana-token-airdrop-and-faucets). The crate was last updated in May 2023 and names no source repository, so review it before installing, and it may not work on today's cluster.

## Setting up each machine

Each machine needs Node 22 or later, a stable connection and about 250 MB of free memory, and it has to stay on for the whole match. A laptop that sleeps will stall its agent.

```bash
git clone https://github.com/jhsmith12345/agent-stacks.git
```

```bash
cd agent-stacks && git checkout AGREED_COMMIT && npm ci
```

Keep your RPC URL out of shell history and shared files, since hosted URLs usually contain an API key:

```bash
read -rs AGENT_STACKS_RPC && export AGENT_STACKS_RPC
```

Create a private directory for keys and your player wallet. Both operators do this on their own machine:

```bash
mkdir -m 700 -p ~/agent-stacks-keys
```

```bash
solana-keygen new --no-bip39-passphrase -o ~/agent-stacks-keys/player.json
```

Both operators need the same binary, because the policy step compares the deployed bytes with your copy and refuses a mismatch. The build currently depends on the operating system: two fresh Linux CI builds gave `3466e105…`, while a Mac build gives `9232974b…`. They're the same size and have the same instructions once addresses are masked, but the functions sit in a different order. Agree on one hash first, then get that binary one of two ways:

- **Download it from CI:** this is the simplest, and machine A should deploy this copy too. Remove any local build first, then run `gh run download RUN_ID -n agent_stacks_escrow -D target/deploy`.
- **Build it:** run `npm run solana:build` after installing the verified tools. This only matches a build from the same operating system. A Linux build that matches CI's hash is also evidence for the independent-host gate.

## Running the match

### Machine A only: deploy and invite

```bash
node scripts/devnet.js status
```

Fund the printed addresses, then deploy. This keeps upgrade authority on the project payer, which is acceptable for test funds only. The command refuses to redeploy over an existing program.

Writes go straight to validators, because the public RPC's limits let only 14 of 187 chunks through in 281 seconds. Sent to validators, the rest took 8 seconds, so a network that blocks outbound UDP may not be able to deploy. If a deploy stops partway, run it again. It resumes the same buffer, and the rent already in that buffer still counts.

```bash
npm run devnet:deploy
```

Keep the upgrade key off any machine that plays. If the same machine must do both, use a separate player wallet as shown here, because an agent is an online process.

Create the invitation, using player B's public address:

```bash
AGENT_STACKS_WALLET=~/agent-stacks-keys/player.json node scripts/devnet.js create PLAYER_B_ADDRESS
```

Send player B the manifest file named in the output. It holds only public match terms, and hosted RPC URLs are left out of it.

### Both machines: policy, preflight, play

Create your own policy for your own endpoint. It checks the deployed bytes against your binary before writing anything. For stage 2, replace `--third-party-rpc` with `--operator-controlled`.

```bash
node scripts/trust-policy.js --third-party-rpc --rpc "$AGENT_STACKS_RPC" --genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG --program PROGRAM_ADDRESS --artifact target/deploy/agent_stacks_escrow.so --out ~/agent-stacks-keys/policy.json --allow-upgradeable-test-program --max-compute-unit-price 50000
```

Run preflight, then read its `terms` section. Starting an agent accepts those terms, and every failed check must be resolved first.

```bash
npm run devnet:preflight -- --policy ~/agent-stacks-keys/policy.json --wallet ~/agent-stacks-keys/player.json --manifest MANIFEST --expect-sha256 AGREED_HASH
```

Start the agent in something that survives a dropped login, such as `tmux`:

```bash
AGENT_STACKS_TRUST_POLICY=~/agent-stacks-keys/policy.json node examples/chain-agent.js ~/agent-stacks-keys/player.json ~/agent-stacks-keys/state --manifest MANIFEST 2>&1 | tee -a ~/agent-stacks-keys/agent.log
```

The agent exits with code 0 once the match completes. It retries network failures by itself and stops on a security failure, so don't restart it automatically without reading why it stopped. Lines about `429 Too Many Requests` mean the endpoint is rate limiting you, which slows the run without harming it.

## If something goes wrong

**A crash or power loss:** the agent leaves lock files behind. Check that the recorded process is really gone, and remove the locks only if it is. Never start a second agent on the same wallet.

```bash
ps -p "$(cat ~/agent-stacks-keys/state/agent.lock)"
```

```bash
rm ~/agent-stacks-keys/state/agent.lock ~/agent-stacks-keys/player.json.agent.lock
```

Then start the agent again with the same command. It resumes from chain progress and redelivers any uncertain transaction.

**The opponent disappears:** the clock runs on chain, and your agent claims the timeout itself once the deadline passes. The player who missed the deadline loses the whole match, so the other player receives both stacks and the pot. The same applies to you if your agent is the one that's down.

**Never** delete a guard file, proof cache or key to get past an error. Follow the [incident steps](security-hardening.md).

## Fault drills

Run these in stage 2, after one clean match. Each is a reason this run exists, and the [release gate](security-hardening.md) requires them.

| Drill | How | Expected |
| --- | --- | --- |
| Hard crash mid-upload | `kill -9` the agent during its shuffle, clear the locks, restart | Upload resumes where the chain says it stopped |
| Network cut | Block the machine's connection for a few minutes | Retries with backoff, then continues |
| Crash during card reveals | `kill -9` while reveals are under way, clear the locks, restart | No share is released twice, and play continues |
| Low funds | Start player B with too little | Refuses to join, then joins once funded |
| Stale or lying node | Point the policy at a lagging endpoint | A lagging node delays play and cannot pass old state to the agent; a lying node is the known limitation AS-03 |
| Missed deadline | Keep an agent stopped past a one-hour clock | The other agent claims the timeout |

## Finishing

Do this in order, because closing is permanent and the verifier can't read a closed match.

```bash
node scripts/verify-chain-match.js MANIFEST devnet-receipt.json
```

```bash
AGENT_STACKS_WALLET=~/agent-stacks-keys/player.json node scripts/devnet.js close MATCH_ADDRESS
```

Run the verifier soon after the match ends, on a node that still has its history. Nodes discard old transactions: a default local test validator kept only about 21 minutes during a full-proof match, which lost the start of a longer one. The verifier then refuses to build a receipt from what's left, and says so. The match itself is unaffected, so try a node with longer history. If you run your own node, set its ledger size well above the default.

Keep the preflight reports, both `agent.log` files, the receipt, the policy flags used and the commit hash. Those are the public evidence. Each `transactions.ndjson` holds signed transaction bytes and stays private, along with everything else in the state directory. Never share a policy file, because a hosted URL's key is inside it.

## What to expect

The first public run, on 2026-11-05, was the low-cost demo through the public RPC, with both players on one machine:

| Measure | Result |
| --- | --- |
| Deploy cost | 0.9505 SOL, nearly all of it rent |
| Match | 2 hands in 7.7 minutes |
| On-chain cost | 86 transactions and 470,000 lamports, the same as local runs |
| Receipt | Verified from chain in 168 seconds |

That demo took about 4 times as long as in rehearsal, and rate limiting is the likely cause: its log shows 485 refused requests. Full-proof matches make far more requests, so the rehearsal figures below are probably optimistic, and they're a reason to use a hosted endpoint for stage 1.

The rest come from local rehearsals through a proxy acting as one hosted RPC, with 55 ms of latency and a local validator's 0.4 s slots. Measuring the real numbers is the purpose of stage 1.

The two-machine run below played 2 hands with both agents on one Mac, each with its own wallet and state. The proxy also shared one rate limit between them (100 requests per 10 seconds, 40 per method), failed 0.5% of requests with HTTP 503 and answered 3% from a lagging backend. Three faults were injected during the match: a hard crash of A mid-upload, a 120-second network cut on B, and a hard crash of B during card reveals.

| Measure | Player A | Player B |
| --- | --- | --- |
| Whole match | 57 minutes | Same |
| Each full-proof shuffle | 12 to 14.5 minutes | Same |
| Transactions | 1,460 | 1,461 |
| Fees | 0.0073 SOL | 0.0073 SOL |
| RPC requests | 17,078, including deploy and preflight | 14,249 |
| Data received | 202 MB | 192 MB |
| Requests refused by the rate limit | 2,764 | 675 |
| Peak memory | 228 MB | 224 MB |

Both agents finished by themselves with nothing pending. The tightest clock had 85,530 of its 86,400 seconds left, so the longest wait used about 14.5 minutes. The receipt verified, and each player's balance came out exact to the lamport.

The two demo runs in [local/devnet commands](devnet.md), also 2 hands each, had latency but no rate limit:

| Demo | Time | RPC requests |
| --- | --- | --- |
| Low-cost | 2 minutes | 1,380 |
| Full-proof | 27 minutes | 22,901 |

## What this doesn't show

Even a clean stage 2 run isn't approval for real funds. Independent cryptographic and custody audits, signer isolation and the other [release gates](security-hardening.md) remain open. The strategy in these agents only checks and calls, and it isn't a production player.
