# Local Solana integration reports

## Channel matches

These test the [channel design](channel-design.md), where agents play through signed messages and the contract only settles disputes. Each player's agent runs as its own process, and they share only a manifest and a relay. Everything below uses test funds, ran on one Mac (some of it in two VMs), and hasn't been independently reviewed.

The current channel-only build is `9ccfb8c5ab7684d4c23f489b26d4f30a399e55069a1520e6862ce399887f25b1`, 180,744 bytes. It's deployed on devnet at `DrUx4PvwUpW1mHPqhDM7Stabtx6JSyXycvtaZftGP1g4`, and the bytes dumped from chain match that hash. It's upgradeable by the project's devnet key, and the deploy took about 0.92 test SOL.

Showing and mucking changed the state format, so the earlier channel program, `GQkM4Uo4hPx8qL4UqkaoA8CZDUGR9GgvZxBaN46UNEGd`, can't run these rules. The first devnet program, `HJeuy3rTLNDktmMFGREW8nHoqFCLkfD8dYX3HPmA4FhJ`, was closed on 2026-11-05 to pay for this deploy, which returned 0.9487 test SOL. Its match account stays on chain, and its transactions stay readable until devnet prunes them, but the [first public devnet run](#first-public-devnet-run) can no longer be repeated against it.

### Two VMs, public devnet, current rules, 2026-11-05

`scripts/channel-vm-rehearsal.js` plays between two Lima VMs running Alpine Linux, each with its own kernel, disk and keys, and no shared folders. The relay runs on the host. Every match here was on `DrUx4Pvw…`.

| Drill | What happens | Result |
| --- | --- | --- |
| Clean, 2 hands | Nothing goes wrong | 61 seconds, 3 transactions |
| Crash | `kill -9` of B's agent mid-hand, then a restart | 61 seconds, 3 transactions, no dispute |
| Power cut | B's VM is forced off mid-hand, and boots again 35 seconds later | 89 seconds, 3 transactions, no dispute |
| Network cut | B's firewall drops the relay's packets, on a 120-second clock | Both agents finish on chain: 12 moves each, 29 transactions, 281 seconds. Neither loses on the clock |
| Gone for good | B's VM is forced off and stays off, on a 30-second clock | A is paid 127 seconds later, and B loses 10,000 of 1,000,000 lamports |
| Real bets, 4 hands | A bets every street and B calls, showing only a winner | 142 seconds, 16 raises, 3 transactions. B showed 3 hands and mucked 1 |
| Real bets, network cut | The same, with B cut off mid-hand and set to muck | 25 moves on chain, 29 transactions, 369 seconds. The contract accepted B's muck, and paid A 1,100,000 and B 900,000 lamports |
| Invite | One command on each VM, and only the code crosses between them | 122 seconds for 2 hands, 4 transactions including the retire. Besides the stake, the host lost 720,880 lamports and the guest 25,000 |

The host's loss is the permanent tombstone at the match's address plus fees.

### Public devnet, earlier build, 2026-11-05

Program `GQkM4Uo4hPx8qL4UqkaoA8CZDUGR9GgvZxBaN46UNEGd`, the channel-only build. Bytes dumped from chain matched `e0a2d27106d29706a393ac2a5ffa732d263ba39828b35470de66a5b2433b5a62`. It's upgradeable, with the project payer as authority, so it isn't trustless yet. Deploying took 16 seconds and 0.9075 test SOL.

| Run | Match | Result |
| --- | --- | --- |
| Clean, 2 hands | `5MhN9QZgmf36ZEjv3t9MjKMnnNDgp6PV6wSknss67nYm` | 3 transactions on the match; 120 seconds with a 1-second relay poll, now 250 ms by default |
| One player killed mid-hand, 30-second clock | `5M7PYJyWYyexe54tJboMYqFGB1zr7aDra9yuqJGMEVQj` | 7 transactions; 139 seconds to payout; the vanished player lost 20,000 of 1,000,000 lamports |

After retiring the match and sweeping session keys, each run's net cost was about 0.0008 SOL, nearly all of it the permanent tombstone on the match address.

### Two VMs, public devnet, earlier build, 2026-11-05

The first round of VM drills, on the earlier build. Each VM generated its own keys, and only the offer and manifest crossed between them. All 36 channel tests that existed then also passed inside a VM. This predates showing and mucking.

| Drill | What happens | Result |
| --- | --- | --- |
| Clean, 2 hands | Nothing goes wrong | 67 seconds, 3 transactions |
| Crash | `kill -9` of B's agent mid-hand, then a restart | 61 seconds, 3 transactions, no dispute |
| Power cut | B's VM is forced off mid-hand and boots again 33 seconds later | 92 seconds, 3 transactions, no dispute. B's manifest was 0 bytes afterwards, and it carried on from its durable copy |
| Network cut | B's firewall drops the relay's packets, on a 45-second clock | Both agents went to the chain: 9 moves, 13 transactions. B then lost the pot on the clock, because catching up took too long. Fixed since, and not rerun on devnet |
| Gone for good | B's VM is forced off and stays off, on a 30-second clock | A is paid 127 seconds later, and B loses 10,000 of 1,000,000 lamports |

Two earlier power-cut runs also played out the long way: each agent waited out a full one-hour challenge window, then finished the hand on chain with 24 moves, settling at state 27.

### Local validator, with devnet's feature set

`scripts/channel-rehearsal.js` runs these against the channel-only build. Rent and slot time stay at local defaults.

| Scenario | What happens | Result |
| --- | --- | --- |
| Clean | 2 hands | 33 seconds, 3 transactions on the match |
| Vanish | One agent is killed mid-hand, on a 30-second clock | The other is paid 82 seconds later; only the pot changes hands |
| On-chain | The relay dies, and both agents stay up | They finish the hand with about 22 verified on-chain moves, 28 or 29 transactions. It has ended both ways: in a muck, and in a split pot at showdown |
| Stale | A player posts its old state 1 | The other answers with state 4 and wins the dispute |
| Fork | A player signs two states at one step | The forger forfeits the whole escrow |
| Lying RPC | The audit's card-leak attack (AS-03): the RPC says showdown is due | No hole-card share is released, and no transaction is broadcast |
| Real bets | 8 hands, one agent betting every street and the other calling, with separate decision programs | About 240 seconds, 32 raises, 3 transactions. Over two runs the caller mucked 11 hands and showed 5. For the first run, recomputing every hand from the saved state confirmed each muck was a real loser and the shown hand a real tie |
| All-in | One agent shoves and the other calls | The all-in shows first and the board runs out. It ended with a muck, in 3 transactions |
| Real bets on chain | The relay dies mid-hand, and the caller is set to muck | 22 on-chain moves, 27 transactions. The contract accepted the muck, and the mucked cards aren't on chain |
| Bad decision programs | One takes 1.5 seconds per decision, one only prints rubbish, and one won't start | Every match settled in 3 transactions, with no dispute. The last two folded on the safe default |
| Invite | One command each, and only the code crosses between them | Payouts agree, and besides the stake the host lost only fees and the tombstone (961,560 lamports, 946,560 of it the tombstone) and the guest 25,000 |
| Invite, crash | The guest is killed mid-hand, and `resume` carries on with the same code | The match finishes, with both reporting the same result |
| Invite, bad contract | The guest's software trusts different bytes, or a different address, or nobody confirms the terms | Refused each time: not a lamport moved, and the host heard nothing |

The older path needed 57 minutes and about 2,900 transactions for 2 hands in its [rehearsal](#two-machine-devnet-rehearsal).

### Automated checks

- **Engine against contract:** 600 random betting games and 3,000 hand rankings match byte for byte, including illegal moves. A whole hand with real keys, shuffles and proofs matches at every step in the SBF VM.
- **Tests:** 35 for the contract in the VM, also run against the channel-only build. 49 for the agent and its dispute decisions, 38 for connecting a decision program, 11 for the invite, and 2 for the fairness of the deal.
- **Fair deal:** across 52,000 shuffles every card is equally likely in every position, and across 30,000 deals dealt the way a match deals them neither seat wins more often and ties come up at about the real hold'em rate. Both run on every test pass, with limits six standard deviations out. This checks the shuffle and hand ranking, not the mental-poker encryption around them.
- **Compute:** at most 97,988 units for a share move and 7,069 for a betting move.

Mutation checks break one rule at a time in a scratch copy and confirm a test fails. These aren't in CI, and the scripts stayed in a scratch directory.

| Area | Caught | Not caught, and why |
| --- | --- | --- |
| Contract | 65 of 67 | Claiming a held payout twice: the Solana runtime separately refuses to take an account below its rent minimum. Mucking before showdown: the contract's phase check also stops it |
| Agent | 31 of 32 | Co-signing with its own move pending: the one-signature-per-step rule also stops it |
| Dispute decisions | 16 of 16 | |
| Decision programs and invites | 72 of 74 | An answer meant for an earlier question: the check that asks the question also stops it. Offering a raise after already acting: heads-up play can't reach that state, because the only raise that doesn't reopen the betting is an all-in, which leaves nobody to raise against |

The first mutation runs caught only about half: 32 of 48 in the contract and 11 of 22 in the agent. Most misses were tests failing for the wrong reason. The rollback test, for example, used bad signatures, so it passed even with the window rule removed. Those tests were rewritten. The first run on decision programs and invites caught 62 of 72, and most of those misses got better tests too. The `stacks` command itself isn't under mutation: its checks are covered by the invite scenarios above.

### Faults found by this work

- **The terms weren't bound to what the contract stored (serious).** A creator could store its own session key in the joiner's seat, or a bigger stake, and the join would still succeed. With its own key in that seat, it could sign for both players and take the deposit. Found by review. The contract now computes the terms hash from what it stores, and a joiner must send the same value.
- **Rollback and fork (design).** An early sketch let a player replay a withheld state after a card was revealed, or sign two versions of a step. The fixed challenge window and the forfeit for two signatures stop these.
- **A relay connection reset killed an agent.** A lost message must never be fatal, so it now goes out again on the next resend.
- **A half-uploaded buffer could block a later post,** and so miss the window. Each state now gets its own buffer.
- **Agents dealt before the opponent had joined, and never refunded an expired invitation.** Both fixed.
- **Junk from a relay could fill the agent's queue for early messages** and crowd out real ones. It now drops the oldest first.
- **A rejected simulation crashed while formatting its error,** which hid the real reason. This was in the existing client.

The VM drills then found these, none of which showed up with both agents on one machine:

- **An agent could get stuck on its own move (serious).** If it signed a move, the opponent posted that move and then played on, the agent waited forever to see it as a move transaction, and lost on the clock.
- **A silent relay held up the chain checks (serious).** A firewall that drops packets makes each relay request hang until it times out, and the agent checked the chain only between requests. Relay traffic now runs separately.
- **Re-reading the match's history took longer than a short clock.** On a rate-limited RPC, fetching every transaction on each check cost a pot. It now fetches only what's new.
- **Agents read the chain many times a second during a dispute,** which got a shared address rate limited. Reads are now paced.
- **A power cut emptied the manifest and the lock file.** The agent now keeps a durable copy of the terms, flushes its lock to disk, and takes over a lock only when its holder is provably gone.
- **A session key without enough SOL couldn't post a state, so it couldn't defend its player.** Setup now refuses a reserve too small for that, unless overridden.

Playing with real decisions then found these:

- **Agents bounced acknowledgements back and forth forever.** A resent acknowledgement got one in reply, which got another, and each 5-second resend added one more. Matches moved fast enough to hide it, but a slow agent would have flooded the relay. A reply is now marked, and a marked reply gets no answer.
- **A deposit could become unrecoverable.** `channel.js create` saved the manifest, which holds the nonce, only after the transaction. A crash in between would have left a deposit with no way to find its address. It's now saved first.
- **A decision program could leave an agent unable to continue after a rollback.** If it fell back to an older state and the program answered differently, the agent couldn't sign. It now repeats the steps it already signed.
- **An invite could have pointed at any contract,** which a bad host could use to keep a guest's deposit. This was caught in design, before any code. Each player now checks the deployed bytes against a table in the software before paying.
- **A decider with no `tell` method hung the runner.** An optional call skipped the increment inside its own argument, so the loop never ended. Only a test double could hit this, and a test found it.
- **The first help text said all but the stake and small fees comes back.** The host also leaves a permanent tombstone of about 0.001 SOL, and the text now says so.

### What this doesn't show

- It hasn't run on two physical machines. Two VMs on one Mac share a host, a network path and a clock source.
- No real agent has played. Every match used the simple styles in `examples/decision-bot.js`, and no language model or person has used the interface or the invite.
- The relay has no matchmaking, and hasn't faced the public internet. There's no public relay yet.
- The deployed program is upgradeable, so the "deployer" row in the design doesn't hold yet.
- Nobody independent has reviewed this design or code.
- A hand plays out on chain only in tests and rehearsals, and the timeout-as-fold incentive argument is new.

## First public devnet run

This was the first run on public devnet, on 2026-11-05: the deploy and the low-cost demo, through the public RPC, with both players on one Mac. Program bytecode and cryptography are unchanged.

| Field | Result |
| --- | --- |
| Genesis | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Program | `HJeuy3rTLNDktmMFGREW8nHoqFCLkfD8dYX3HPmA4FhJ`; upgrade authority is the project payer |
| Deployed bytes | Dumped from chain and matched `9232974b753314d5e7dbcde07a29b82596326cd1b2afedd1b12217f1542c376a` |
| Deploy cost | 0.95050368 SOL, nearly all of it rent |
| Match | `Cux8Wpe2eb4RSJrUGVUSquEbYknsgwFaikBeMvHkKAUy`, left open rather than closed |
| Path | Cooperative shuffle; the full-proof path was not run |
| Terminal state | Two hands in 462 seconds, version 62, no pending payouts |
| Awards | 1,000,000 / 1,000,000 lamports |
| Protocol cost | 86 transactions / 470,000 lamports including setup; 42 / 230,000 per hand excluding setup, the same as the local runs |
| Final transaction | One signer; 91,901 CU; 5,000-lamport fee |
| Receipt | Rebuilt from chain data in 168 seconds, from 66 match-address transactions |
| Rate limiting | 485 refused requests in the demo's log, and 123 during verification |

Public receipts: `.agent-stacks/reports/devnet-first-match.json` and `devnet-first-cost.json`.

The rehearsal below hadn't predicted three things, all now fixed:

- Deploying through the public RPC with `--use-rpc` failed after 281 seconds, with only 14 of 187 chunks written. The rehearsal's proxy had let that same path succeed. Sending the writes straight to validators finished the rest in 8 seconds.
- The deploy's balance check ignored rent already paid into the buffer, so a wallet on the minimum budget couldn't have retried.
- The verifier stopped on the first refused read, because retries stop at the RPC library's own limit. It and the cost tool now look again with longer pauses.

The demo took about 4 times as long as in rehearsal (462 seconds against 114), so the proxy's limits understated the public RPC's. Treat the rehearsal's full-proof timings as optimistic. This run covers the public network's timing and cost for the low-cost path only. It's same-host evidence through a third-party RPC, and says nothing about the trust boundary or separate hosts.

## Two-machine devnet rehearsal

This rehearsed the [two-machine runbook](devnet-two-machines.md) on 2026-11-05. It ran on one Mac, against a local validator using devnet's feature set (`--clone-feature-set --url https://api.devnet.solana.com`, `--limit-ledger-size 5000000`). Rent and slot time stayed at local defaults. Program bytecode and cryptography are unchanged. This says nothing about separate hosts or real network conditions.

Both agents reached the validator through a proxy acting as one hosted RPC: an API key in the URL, 55 ms of latency, one shared rate limit (100 requests per 10 seconds, 40 per method), 0.5% of requests failed with HTTP 503, and 3% answered from a lagging backend.

| Field | Result |
| --- | --- |
| Genesis | `Gt9tLwpxURC59QvAAaLeE6U6pmWhPYP1XAPL2epFJHuE` |
| Match | `YU5RnmPS2vep3yLmdB4KfppE9ueQ2mYbRWfooEPT8J9` |
| Path | Full proof, with the agent reading only the chain; the agents shared one manifest and nothing else |
| Terminal state | 2 hands in 56.6 minutes, both agents exited 0, no pending payouts |
| Awards | 980,000 / 1,020,000 lamports |
| Injected faults | `kill -9` of A mid-upload, 120-second network cut on B, `kill -9` of B during reveals |
| Shuffles | 783, 869, 731 and 729 seconds |
| Tightest clock | 85,530 of 86,400 seconds left |
| Transactions and fees | A 1,460 / 7,310,000 lamports; B 1,461 / 7,315,000 lamports |
| RPC requests | A 17,078, including deploy and preflight; B 14,249 |
| Refused by the rate limit | A 2,764; B 675 |
| Peak memory | A 228 MB; B 224 MB |
| Deploy | 250 seconds through the proxy on the budget `status` printed, with 0.049 SOL left; a second deploy was refused |
| Receipt | Verified before close; the verifier then refused the closed match |
| Secrets | The API key appeared in no output and no file other than the policy |

Balances reconcile exactly. A's net cost of 8,286,560 lamports is its 7,310,000 in guarded fees, the 20,000 it lost in play, and 956,560 for two fees outside the guard and the rent left behind on the retired match address. B's net cost of 7,295,000 lamports is its 7,315,000 in fees less the 20,000 it won.

The demo was also rehearsed on the smallest funding that works, each resuming its finished match afterwards with no balance change. These had latency but no rate limit or injected faults:

| Demo | Time | RPC requests | Transactions |
| --- | --- | --- | --- |
| Low-cost | 114 seconds | 1,380 | 42 per hand |
| Full-proof | 1,605 seconds | 22,901 | Not separately counted |

The rehearsals found these faults in the new tooling, each now fixed and covered by a test:

- Preflight asked a match creator for a deposit it had already paid.
- One HTTP 503 made preflight report a failure, and a node going down left no report at all.
- web3.js retries HTTP 429 silently, which made preflight report no rate limits on a limited endpoint. That check now uses raw requests.
- An idle agent re-read about 250 KB of program data every second. It now backs off to 8 seconds.
- A default local validator kept only about 21 minutes of history, so the verifier lost the start of a 58-minute match and failed with a misleading error. It now names the cause and writes no receipt. The match itself is unaffected.

### Binary format

`SIMD-0500` would stop new deployments of SBPF v0, v1 and v2 programs, and was inactive on devnet and mainnet on 2026-11-05. The pinned artifact is SBPFv0. A scratch SBPFv3 build of the same source passed all 19 Rust tests and deployed under devnet's features. It hasn't been adopted, and the pinned hash is unchanged.

| Measure | SBPFv0 (pinned) | SBPFv3 (scratch) |
| --- | --- | --- |
| Binary | 186,584 bytes | 175,520 bytes |
| SHA-256 | `9232974b753314d5e7dbcde07a29b82596326cd1b2afedd1b12217f1542c376a` | `b366cf27bb2c105389e5a5ecf193d769b2be9024a15e49baf7465bfb255030d4` |
| Payout | 98,947 CU | 93,404 CU |
| Joint deck | 31,771 CU | 25,755 CU |
| Full verification | 39,746,478 CU | 39,733,032 CU |
| DLEQ check | 16,929 CU | 16,932 CU |

### Build host

The same commit gives a different hash on a different operating system, so a matching hash across hosts isn't available yet.

| Build | SHA-256 |
| --- | --- |
| Mac (pinned), and two clean rebuilds on the same host | `9232974b753314d5e7dbcde07a29b82596326cd1b2afedd1b12217f1542c376a` |
| Linux CI, twice on fresh runners (run 41996681939, attempts 1 and 2) | `3466e105994f3c6554b3a77912f9121c12a783a775b71d6af71cff640645994e` |

Both are 186,584 bytes. Their `.rodata`, symbols and section layout are identical, and only the sections holding code or addresses differ (`.text`, `.data.rel.ro` and `.rel.dyn`). `.text` holds the same 19,741 instructions once call targets and loaded values are masked. 13,889 of those are at the same position, which points to the same functions in a different order. That comparison doesn't prove the call targets match. CI's copy passed all 19 Rust tests, but the rehearsals above used only the Mac build. The cause hasn't been traced, and no build inside a Linux container on a Mac has been tried.

## Protected-agent v1 follow-up

The [protected-agent implementation](security-hardening.md) was tested against a fresh loopback Agave validator with finalized confirmations and a pinned v5 artifact. This adds no on-chain instructions or changed cryptography. Test-only code/authority policy and explicit node ownership remain assumptions; the malicious configured-node attack is deliberately retained as a limitation test.

New regressions cover missing policy, relay attempts to replace the state source, a dishonest submission relay, rollback/equivocation after restart, deck/key substitution, fake phase/cursor requests, durable-before-release failure, changed program bytes/loader/authority, signing limits, malformed recovery budgets, uncertain/finalized receipts, bounded cooperative-offer framing and encrypted-backup tampering. The full JavaScript suite passes 69 tests; prior Rust defects remain covered by 19 passing tests, including 14 actual SBF tests. Changed transport/framing paths also pass a final focused run. Full verification is recorded in `guard-v1-validation.json`; JavaScript coverage retains exhaustive five-card counts and the independent seven-card oracle.

| Field | Result |
| --- | --- |
| Genesis | `8jHd4V6FqM41hZfu8RYzux2WiioyL5rppW9JgCB41f3h` |
| Match | `E17o2jPocQfpnxmXK1yYa5xKMqFnQDhdCjEcaWF5mhf1` |
| Terminal state | Two hands, version 62, no pending payouts |
| Awards | 1,000,000 / 1,000,000 lamports |
| Protocol cost | 86 transactions / 470,000 lamports including setup; 42 / 230,000 per hand excluding setup |
| Final transaction | One signer; 98,919 CU; 5,000-lamport fee |
| SBF SHA-256 | `9232974b753314d5e7dbcde07a29b82596326cd1b2afedd1b12217f1542c376a` |
| Clean rebuilds | Two separate source/target directories reproduced the same artifact hash |
| Completed restart | Same 66 finalized match-address signatures, no new payouts or pending transactions |

Public receipts: `.agent-stacks/reports/guard-v1-match.json`, `guard-v1-cost.json`, `guard-v1-reproducibility.json`, and `guard-v1-validation.json`. These are included in the review bundle; private state is excluded. Ledger: `.agent-stacks/validator-guard-v1-immutable-20261104` (the name does not certify authority removal: this test-validator reports the System Program as authority, requiring the test-only exception). The initial creation was confirmed before the first protected read and had not yet finalized; the coordinator was corrected to wait for finality, then resumed the same invitation successfully. No funds were deposited twice.

The checks are same-host local evidence, not independent review, public-node consensus verification, remote-host testing or real-stake approval. Strict on-chain fallback still passes in SBF; this fresh full RPC match exercised the cooperative path. Finality adds latency even though protocol transaction fees are unchanged.

## Protected-agent liveness follow-up

A later review found that small faults could make the protected agent forfeit a match: a third party could dust a closed buffer address to trigger a failing cleanup, any send that never landed blocked signing permanently, and strict proof steps waited for finality long enough to miss the minimum clock. The [hardening notes](security-hardening.md) describe the corrected behavior. Program bytecode and cryptography are unchanged.

Local validator evidence, from real agents on a scratch ledger:

| Scenario | Before | After |
| --- | --- | --- |
| Third party sends 0.001 SOL to a closed buffer during `chain-demo` | Agent permanently unable to sign | Both hands complete and settle |
| Agent out of fees | Permanently blocked, even after funding | Refused in simulation, nothing recorded |
| Relay refuses delivery, trusted node healthy | Permanently blocked | Original bytes redelivered directly; finalized in 18 seconds |
| All delivery fails until the blockhash expires | Permanently blocked | Proven dead and cleared after 100 seconds |
| One strict shuffle at a one-hour clock | About 3.4 hours projected, forfeit | 406 seconds |
| Complete strict hand at a one-hour clock, with a restart mid-upload, then dust plus a second restart | Never run through the guard | Completed in 22 minutes; settled at showdown |

| One HTTP 503 from the RPC node | Standalone agent exited within a second | Retried; the agent plays on |
| Agent started right after `devnet.js create` | Exited with a misleading ownership error | `create` returns once finalized, and the agent waits up to two minutes for a match it can't see yet |
| Joining without funds for the full-proof fallback | Deposit taken, match lost if the opponent refused to co-sign | Refused with no deposit; joined by itself once funded |
| Priority fees | Always refused | Opt-in by policy; the guard recorded the 10,200 lamports the chain charged |

The strongest run played a complete strict hand with two real standalone agents at a one-hour clock and 400 ms slots, through a proxy injecting random faults, with priority fees enabled, a restart mid-upload, and dust on a closed proof buffer followed by a second restart:

| Field | Result |
| --- | --- |
| RPC requests | 48,480 |
| Injected faults | 865: 686 HTTP 503s, 134 connection resets, 26 hung requests, 19 silently dropped transactions |
| Outcome | Settled at showdown in 45.6 minutes; both agents exited cleanly with nothing pending |
| Slowest shuffle | 1,160 seconds, about 32% of the clock |
| Least clock remaining at any point | 2,443 of 3,600 seconds |
| Transactions | 730 and 731, including those that needed recovery; 21 needed it |

An earlier attempt at this run exposed two defects that normal tests had missed: a failed status poll abandoned a healthy send, and retry backoff never reset during a long shuffle. Both are fixed and covered by regressions.

Regressions are in `test/agent-recovery.test.js`, which drives the actual agent process, plus additions to `test/trusted-agent.test.js` and `test/solana-client.test.js`. Reverting each of 31 individual fixes made at least one of them fail. These are same-host local results, not public-network evidence. Existing review bundles predate this change; regenerate one before relying on it.

A further hardening pass tightened the guard's instruction checks and policy limits, added creator cancel and close tools, moved past buffer addresses a stranger funded, limited co-signing, and made settlement receipts, HTTP errors, signed-command binding and the backup KDF stricter. Local validator evidence:

| Scenario | Result |
| --- | --- |
| `devnet.js` create, cancel, close | Deposit refunded and rent returned; the full cycle cost 961,560 lamports, the 946,560 tombstone plus fees |
| Closing a real settled match | 29,588,928 lamports returned to the creator, net of the fee |
| Stranger funds a buffer address before it exists | Agent moved to a new key and kept uploading |
| Corrupted co-signature in the demo | All four shuffles fell back to the full-proof path and the two hands completed |
| Stranger's transaction names a settled match | `verify-chain-match.js` still identified the same settlement, and `measure-compact-cost.js` still reported 42 transactions per hand |

Reverting each of 24 of these changes individually also made a regression fail. The CI workflow has not run yet, because this repository has no remote.

## Earlier v5 security review build

The [November 4 security re-audit](security-audit-2026-11-04.md) documents the findings, fixes and open risks at that earlier snapshot: 53 JavaScript tests and 19 Rust tests, including 14 actual SBF integration tests. Two tests intentionally reproduced an **unfixed dishonest-RPC share leak**; their passing status was not a security clearance. Checks covered retired-address reuse, sub-rent payout deferral/claims, uninitialized-buffer takeover, malformed dispatch, crash/payment recovery, private-file safety, concurrent agents and signing boundaries. The evaluator checks all 2,598,960 five-card hands and 10,000 seven-card hands against independent counts/oracles. Formatting, Clippy and known-vulnerability scans passed; five Rust unmaintained-package notices remained.

Fresh local RPC evidence:

| Field | Result |
| --- | --- |
| Genesis | `GqtGDjjEVSNMFqQpz2SG45tGXnqaWVJS8Xre5VC321qS` |
| Match | `DnATespuRXCbFqtD5KXrhvef8m5P4ak1nZTmz5t6pf1X` |
| Terminal state | Hand 2, version 62, payouts 1,020,000 / 980,000 lamports, no pending claims |
| Cost | 86 transactions / 470,000 lamports including setup; 42 / 230,000 per hand excluding setup |
| Final transaction | One signer; 97,605 CU; 5,000-lamport fee |
| SBF SHA-256 | `9232974b753314d5e7dbcde07a29b82596326cd1b2afedd1b12217f1542c376a` |

Read-only receipts are `.agent-stacks/reports/audit-v5-match.json` and `audit-v5-cost.json`. A completed-match resume performed no new payout. The retained ledger is `.agent-stacks/validator-audit-v5-final-20261104`. The earlier v4 ledgers below need their matching older code; they are historical evidence, not v5 compatibility tests. No public-network deployment occurred.

## Earlier v4 optional cooperative-path result

The optional jointly authorized path completed a two-hand local RPC match at `6dzVz5xDgz4ekCRZ62p16dJhUeYS8GyNTNBKxmoyqCut`, paying 1,040,000 and 960,000 lamports. The measured protocol cost was 86 transactions / 470,000 lamports including one-time creation/join, or **42 transactions / 230,000 lamports per hand** excluding that setup. Wallet funding is additional. Temporary deck storage was 24,617,520 lamports, reclaimed after consumption.

Both counterparties verified the original full proofs independently off-chain before signing exact deck-acceptance transactions. The chain checked joint authorization; it did not verify the shuffle mathematics on this path. Default unilateral verification remains available. SBF tests additionally completed a unilateral full-proof fallback after a compact offer, without the peer signature, under the original deadline. See the [full cost/model report](optimization.md).

At that stage, 39 JavaScript and 13 Rust tests passed, including signature/hash/buffer tampering, invalid points, binding to match/hand/seat/version/deadline, disabled-mode rejection, full off-chain proof verification and late-response IPC isolation. That historical ledger is `.agent-stacks/validator-compact-20261104`; the current operation guide targets the separate v5 ledger above.

## Earlier v4 full-verification build

Verified November 4, 2026 through an actual local Agave validator and RPC transactions. This is not a public devnet deployment.

| Field | Result |
| --- | --- |
| Validator | Agave 4.4.0, loopback RPC port 18899 |
| Genesis | `2wxVngmv4yMJeUAKp6RzH5vKnptG3B2cxeZa21fm5tsg` |
| Program | `HJeuy3rTLNDktmMFGREW8nHoqFCLkfD8dYX3HPmA4FhJ` |
| Match | `6mZWa88D6Ly5J5GoXJyLyCBwawqx68nw85doGPTBkzb7` |
| Final state | Hand 2 of 2, phase 6, version 62, verified showdown |
| Deposits | 1,000,000 lamports per player |
| Payouts | A: 960,000; B: 1,040,000 lamports |
| Final transaction | One signer, 98,976 CU, 5,000-lamport fee |
| Actual final balance changes | A: +960,000; B: +1,035,000 (payout minus fee) |
| Successful match-account transactions | 62, excluding separate proof-account operations and funding |
| Final board IDs | 22, 40, 33, 29, 30 |
| Final showdown hole IDs | A: 12, 25; B: 46, 4 |

Each player shuffled for each hand: four dense 652,513-byte proofs, each uploaded in 653 transactions and verified across 32 four-round batches. The revised upload payload saves 72 transactions per shuffle, about 10%, without changing proof rounds or cryptographic construction. Proof storage is reclaimed after consumption. The demonstration uses a check/call strategy and wallets owned by this workspace.

An intermediate RPC check after hand one confirmed that all 2,000,000 deposited lamports remained in escrow, payouts were still zero, the button moved to B, and both agents used different hand keys. Stacks before hand-two blinds were A: 980,000; B: 1,020,000. The program reset keys, deck and card shares and accepted hand-bound proofs for hand two.

The final reveal transaction signed by B automatically paid both stored player accounts. No jointly signed payout transaction was required. The receipt checks actual transaction balance changes and the recorded transition to hand two. Coordinator resume and standalone-agent mode both recognized completion and exited without another payout; completion timestamps remained unchanged on resume.

Final reveal signature (local ledger only):

```text
3HYYpieCjootftHFXC4UqiV3JFHyiQ9xSuNtpqJMP1QUTsnFYMW8nmT2akXrQ4bdVW6Yg2HL2Wk5nLnr1DAwXNnw
```

Local artifact SHA-256:

```text
0561fb1491634cd177e7e9e871d942c6499f8c524fb6859ccff8ad32e8edf137
```

The public receipt is retained at `.agent-stacks/reports/local-multihand.json`; the intermediate check is `local-multihand-intermediate.json` in the same directory. Recreate the read-only receipt with:

```sh
AGENT_STACKS_ALLOW_LOCAL=1 node scripts/verify-chain-match.js \
  .agent-stacks/devnet/matches/6mZWa88D6Ly5J5GoXJyLyCBwawqx68nw85doGPTBkzb7.json
```

The local artifact hash identifies this build; it is not independent deployed-code attestation. The validator was stopped after verification; its v4 ledger is retained at `.agent-stacks/validator-multihand-final-20261104`. See the [operation guide](devnet.md) for restart commands. Private caches and ledgers are gitignored; never publish them as a substitute for a public report.

## Automated checks

- `npm test`: 36 passing JavaScript tests, covering poker, dealerless crypto/protocol, persistence, RPC network/terms/version guards, original-signature recovery, hand-bound contexts and packet-sized uploads.
- Rust: 12 passing tests (three host tests and nine actual SBF VM tests). Differential fixtures include 400 seven-card rankings, 120 randomized betting traces and agreement on the canonical initial deck.
- Two complete hands execute in SBF, with verified shuffles, privacy checks, button rotation, conserved custody between hands and final automatic payout. Forks check folds, timeout attribution at each encountered obligation, and old key/share replay with refreshed expected versions. Host tests also cover empty-stack termination and carried winnings exceeding the per-player creation ceiling.
- Upload tests verify the new 1,000-byte payload, reject 1,001-byte payloads without state changes, and execute full seal/verification/closure. The 652,364-byte benchmark fixture now takes 653 uploads / 536,766 upload CU, previously 725 uploads / 595,950 CU.
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all -- --check`: passed.
- `npm audit`: zero known dependency vulnerabilities reported.

## Earlier v3 evidence

Before the v4 multi-hand change, an earlier local single-hand match completed at `9Xy15sxekCxLGny7s6iyZpXKr8oVmaoysZ79Fa1T9PR4`, paying 1,020,000 and 980,000 lamports. An additional 30-second invitation timeout refunded the creator's 1,000,000-lamport deposit. Those receipts remain in `.agent-stacks/reports/local-chain.json` and `local-timeout.json`. V3 account layouts and manifests are incompatible with the current v5 SDK; use the separate retained ledger only with matching code.

## Limits

No public deployment or public end-to-end match has been verified. Devnet funding requests failed. Local tests do not exercise public congestion, censorship, RPC deception, or independently operated agents across machines. The proof format still needs substantial storage and transaction volume. Neither these tests nor internal review establish cryptographic security. See the [independent review scope](security-review.md).
