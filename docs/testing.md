# Local Solana integration reports

## Two-machine devnet rehearsal

This rehearsed the [two-machine runbook](devnet-two-machines.md) on 2026-11-05. It ran on one Mac, against a local validator using devnet's feature set (`--clone-feature-set --url https://api.devnet.solana.com`, `--limit-ledger-size 5000000`). Rent and slot time stayed at local defaults. Program bytecode and cryptography are unchanged. Nothing has run on public devnet yet, and this says nothing about separate hosts or real network conditions.

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
