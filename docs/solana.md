# Solana implementation status

The native Rust program now executes multi-hand heads-up no-limit Hold’em matches. A full match has passed through the actual local-validator RPC using two isolated agent processes. **No program has been deployed to a public cluster. Test funds only.**

Implemented:

- Match PDA, named opponent, equal deposits, accepted terms, version checks, and invitation cancellation/refund.
- Independent Ristretto keys with proof of possession; two match-bound verified shuffles over the canonical 52-card deck.
- Required card-share proofs bound to program, match, terms, phase, seat and position. Agents privately decode their own holes; public holes appear only at showdown. Burns remain encrypted.
- On-chain fold/check/call/raise/all-in rules, minimum raises, short all-ins, unmatched-wager refunds, street order, best-five-of-seven evaluation, and split pots.
- Automatic final payouts after a fold or verified showdown. An undeliverable award remains claimable by its owner without blocking the opponent's settlement. Retirement retains a permanent record preventing match-address reuse. Optional joint settlement remains available.
- Chain-clock deadlines on every active obligation, including post-shuffle dealing, betting and reveals. Anyone can submit a timeout; after joining, the defaulting player forfeits both deposits to the other player.
- Proof uploads, bounded verification, consumed-output binding and reclaimable proof storage. Partial uploads and verification do not reset the match deadline.
- RPC SDK with network/genesis guards, account/PDA and terms checks, signed-transaction journals, confirmation, resumable uploads and durable private hand-key files.

The chain implementation supports **1–1,000 hands**, carries stacks, alternates the button, and ends early when a player is busted. Every new hand resets the encrypted deck, keys and card shares and binds new proofs to its hand number. The separate JavaScript peer protocol also supports multiple hands. It has different identities, terms hashes and envelopes; it is not a chain light client.

See [local test evidence](testing.md), [commands and recovery](devnet.md), [instruction layouts](../programs/escrow/README.md), [cryptography](cryptography.md), and [costs](benchmarks.md), and [security review scope](security-review.md).

The optional [cooperative acceptance path](optimization.md) now measures 42 transactions / 0.00023 SOL in base fees per hand locally. Both agents verify the full proof off-chain and authorize the exact output deck; the default remains full on-chain verification. Refusal can use that original unilateral verifier without a new deadline or counterparty signature. This changes chain auditability and depends on correct client proof verification before signing.

The [channel design](channel-design.md) moves play off-chain and uses this program's rules only to settle disputes, which is the plan for safe play without a node. For the older paths, remaining work: more efficient reviewed shuffle proofs, remote independent-agent testing, public devnet verification of the full-proof path, adversarial RPC/recovery work, cryptographic review and custody audit. The present proofs need about 653 uploads and 32 verification transactions per player, and about 4.54 SOL of temporary refundable storage funding.

The [security re-audit](security-audit-2026-11-04.md) reproduced a hidden-card leak through dishonest RPC state. The [protected agent](security-hardening.md) now requires an operator-controlled node, pinned code and durable finalized-state/share checkpoints, separating reads from an optional submission relay. The low-level SDK and a compromised configured node remain trust boundaries; arbitrary untrusted state RPCs are unsupported. Live private caches remain owner-only plaintext; encrypted backup tools do not encrypt the running signer. Losing a hand key can cause a timeout forfeit. Tests do not establish cryptographic security.

Public deployment is deferred while we continue locally. Deployment tooling uses project-only keys and would retain the project payer as upgrade authority; that is not a finalized production authority policy. No normal user wallet or mainnet funds are used.
