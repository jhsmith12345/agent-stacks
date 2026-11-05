# Optional cooperative shuffle acceptance

This is an architectural optimization, not a new succinct shuffle proof. It remains experimental and opt-in. The default path still verifies the full shuffle proof on-chain.

## Measured local cost

A two-hand check/call match completed through the local Solana RPC on November 4, 2026. All four shuffles used cooperative acceptance, and both hands ended at verified showdown.

| Per hand, both players combined | Full on-chain shuffle verification | Optional cooperative acceptance |
| --- | ---: | ---: |
| Transactions, excluding match setup and funding | 1,406 | 42 |
| Signature count | 1,408 | 46 |
| Base fees | 0.00704 SOL | 0.00023 SOL |
| Temporary refundable storage per active shuffle | About 4.54 SOL | 0.02461752 SOL |

That is about **97% lower transaction count and base fees** in the cooperative check/call case. For illustration only, at $150/SOL the per-hand base fee is about $0.035 rather than $1.06. These are measured local-validator fees and a hypothetical exchange rate, not a public-network latency or dollar-price quote. Priority fees, retries, funding, match-account storage and deployment are additional. A refusal requiring the full verifier returns to the expensive path, with a small extra cost for the attempted compact buffer.

Each compact shuffle uses seven transactions: create/initialize a 3,409-byte deck buffer, four sequential uploads, jointly consume the deck, then close the buffer. Account creation and joint consumption each require two signatures. A hand additionally uses two key registrations, 18 card-share transactions and eight check/call betting actions. Match creation/join add two one-time transactions, costing 0.00001 SOL at the observed base fee.

The [v5 security review run](security-audit-2026-11-04.md) reproduced the same 42 transactions / 0.00023 SOL per hand. These figures exclude match storage/retirement and exceptional withdrawal claims. V5 retirement retains 946,560 lamports of tombstone rent once per match to prevent address reuse. An undeliverable payout may need an additional tag-20 withdrawal transaction. Neither change removes the open malicious-RPC risk or the need for independent cryptographic review.

The two-hand benchmark therefore used **86 program transactions, 94 signatures and 470,000 lamports in fees** including match creation/join. Wallet funding transfers are excluded. Every required decryption share and betting action was still checked on-chain; final payouts were 1,040,000 and 960,000 lamports, exactly conserving the deposits.

## Acceptance model and fallback

1. The shuffling agent creates the same 128-round proof as before and uploads only its 3,328-byte encrypted output deck to a compact account.
2. The counterparty fetches current chain state independently, checks the accepted match terms, decodes and verifies the complete public shuffle proof, and compares the uploaded deck with the verified output.
3. It constructs a single, narrowly specified acceptance transaction locally. The transaction commits to program, match, expected version, both player signers, the exact buffer address and the SHA-256 output-deck hash. It signs this reconstructed transaction, never an arbitrary relay-supplied transaction.
4. The actor supplies its own signature and submits. The program requires both stored player signatures, the current shuffle obligation and deadline, matching buffer authority/match/hand/seat, complete upload, exact hash and canonical curve points. The deck is copied to escrow before storage can be reclaimed.

The chain verifies **joint authorization**, rather than the shuffle mathematics, on this path. Third-party auditors see the signatures and accepted deck, but cannot recheck the full shuffle relation from chain data alone unless the full proof is also supplied off-chain. At least one correctly operating participant must perform its required proof verification before co-signing. Both signers already have the ability to agree to a cooperative payout; the new instruction does not enable one player to replace the deck alone.

The optional acknowledgement is never a new timeout obligation. Uploading a compact buffer or refusing approval does not change match state, version or deadline. The actor can use the original tag-13 full-proof verifier without the other player's signature. An old cooperative signature cannot be reused after that transition because it commits to the previous version. The demo waits at most 15 seconds for approval, then uses unilateral verification on refusal or timeout; late IPC responses are correlated by request ID so they cannot satisfy a different command. Use a clock long enough to accommodate the full fallback.

This preserves a unilateral route, but it is not a claim that the two acceptance models have identical auditability or that this composition has been formally proved secure. Independent review must cover client signing policy, proof transport, RPC trust, timing and recovery. Never sign deck hashes without independently verifying their full bound proofs.

## Run locally

Use the current compiled program on a fresh or matching validator ledger (see the operation guide). Both agents must explicitly enable cooperative acceptance:

```sh
AGENT_STACKS_RPC=http://127.0.0.1:18899 \
AGENT_STACKS_ALLOW_LOCAL=1 \
AGENT_STACKS_COOPERATIVE_SHUFFLE=1 \
npm run devnet:play
```

Without that final flag, the full on-chain verifier remains the default. The example coordinator currently transports public proof offers and partial signatures over IPC. The helper `src/solana/compact-shuffle.js` provides the independent verification/signing policy; remote offer transport and independently operated cross-host testing remain work. The standalone agent continues to use unilateral verification.

## Test evidence

- Two complete cooperative hands passed through the actual local validator, including four independently verified proof offers, joint signatures, private dealing, showdown, payout and rent reclamation.
- SBF rejects missing/wrong peer signatures, modified output hashes/buffer bytes, invalid points, wrong match/hand/seat, incomplete buffers, stale versions and expired acceptance. Uploads do not advance deadlines. Closure returns storage without erasing the consumed deck.
- A fork from an uploaded compact offer successfully uploaded and consumed a complete full shuffle proof with only the actor's signature. The previous cooperative transaction then failed as stale.
- Agent-side tests reject malformed/tampered proofs, mismatched output data, stale offers and disabled mode. A changed output hash invalidates the counterparty's transaction signature. The signer rebuilds exactly one allowed instruction, ignoring relay-supplied transaction instructions.
- IPC tests reject errors and expired requests and ignore late approval replies. Resume recognizes completed matches without paying again.

Benchmark match: `6dzVz5xDgz4ekCRZ62p16dJhUeYS8GyNTNBKxmoyqCut`, local genesis `CBp3AYyeLQ2pNUuLRqwS2gL7PxzzJaDnzHfX7MGDin56`. Public receipts are retained locally at `.agent-stacks/reports/compact-match.json` and `compact-cost.json`. No public devnet deployment or real-stake testing occurred. The validator was stopped after verification; its ledger and private caches are retained for restart.

References for fee and packet accounting: [Solana fees](https://solana.com/docs/core/fees), [Solana transactions](https://solana.com/docs/core/transactions). The published [Bayer–Groth shuffle argument](https://www0.cs.ucl.ac.uk/staff/J.Groth/MinimalShuffle.pdf) is a candidate for future succinct-proof research, not an implemented component of this optimization.

To reproduce the accounting without mixing in other matches on the same ledger:

```sh
AGENT_STACKS_ALLOW_LOCAL=1 node scripts/measure-compact-cost.js \
  .agent-stacks/devnet/matches/6dzVz5xDgz4ekCRZ62p16dJhUeYS8GyNTNBKxmoyqCut.json
```

The tool follows this match's compact buffers (including closed buffers) and sums their actual transaction metadata. It rejects mixed full-verifier matches rather than omitting full-proof costs. A separate one-hand smoke match with the final IPC routing measured the same 42 transactions / 230,000 lamports per hand.
