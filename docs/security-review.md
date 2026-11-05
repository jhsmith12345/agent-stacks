# Review package: multi-hand Solana prototype

**Historical review scope.** The subsequent [November 4 security re-audit](security-audit-2026-11-04.md) documents confirmed vulnerabilities and v5 fixes. The [protected-agent follow-up](security-hardening.md) and [external-audit brief](external-audit-brief.md) describe the current implementation, assumptions and remaining release gates.

This is a review scope, not an independent audit or a formal security argument. No real stakes or public deployment are approved by test success.

## Code and trust boundaries

- `programs/escrow/src/lib.rs`: custody, PDA and signer checks, terms commitment, expected versions, deadlines and instruction dispatch.
- `programs/escrow/src/play.rs`: card-share obligations, context binding, private/public card positions, hand reset and payout destinations.
- `programs/escrow/src/game.rs`: public no-limit Hold’em transitions and best-five evaluator.
- `programs/escrow/src/proof.rs` and `shuffle.rs`: canonical Ristretto DLEQ and 128-round shuffle verification using Solana syscalls.
- `src/mental-poker/`: proof generation and the separate signed local protocol.
- `src/solana/client.js`: trusted-RPC network checks, accepted terms verification, signed transaction journaling and confirmation uncertainty.
- `examples/chain-agent.js`: agent policy, private per-hand keys, proof caching/upload recovery and required-share release. `chain-demo.js` additionally controls test funding and routing for two wallets owned by this workspace.

The on-chain program, not a relay or off-chain transcript, determines accepted actions and payout amounts. SDKs still trust RPC responses and private local state. Local peer protocol timestamps and escrow are simulated; do not confuse their assurances with chain execution.

## Multi-hand changes checked internally

The match account now commits to a hand limit. Contexts bind the hand number as well as program, match, terms, seat, phase and position where applicable. Stacks carry forward, button alternates, and keys, encrypted deck, share points and cursor reset. No custody payout occurs between hands. A fold or showdown ends the match only at the hand limit or with an empty stack.

Internal review found and corrected a stack-bound issue: a player can carry winnings exceeding the per-player creation ceiling. The game now accepts carried stacks up to the two-player total. Tests cover that boundary, carryover after a fold, empty-stack termination, prior-hand key/share replay even with a refreshed expected version, and deadlines after reset. The demo also recovers consumed proof storage before resumed hand funding, preserving per-hand return markers.

Increasing proof upload payloads from 900 to 1,000 bytes changes framing costs, not Fiat–Shamir rounds or proof mathematics. Tests check transaction packet size, the program's upper payload bound, complete proof verification and closure.

## Optional joint acceptance review scope

The optional compact-buffer path replaces chain proof verification with joint authorization for that transition. It is not a succinct proof. Review the two-signature/output-hash/version binding, canonical point checks, buffer lifecycle and locally reconstructed signing transaction. A correct client must verify the complete full proof against independently fetched chain state before co-signing. A relay must never obtain an arbitrary-transaction signature. Auditors cannot reconstruct the full shuffle relation from chain data alone on this path.

Refusal, delay or buffer upload must never advance a match or create an acknowledgement timeout against the other player. The actor must retain a funded full-proof fallback under the existing deadline. Tests exercise unilateral fallback after a compact offer and reject a stale joint transaction afterward. The demonstration's 15-second receipt timeout uses correlated request IDs to prevent late replies from satisfying subsequent commands. Remote transport, chain congestion and operational fallback funding remain untested publicly.

## Independent review still required

1. Analyze the exact threshold ElGamal, proof-of-possession, cut-and-choose and Fiat–Shamir composition, including malicious adaptive players, selective abort, auxiliary witness leakage, challenge grinding and multi-hand correlations. The 128-round soundness intuition is not a security proof of the full protocol.
2. Audit custody conservation and account substitution across every instruction, including prefunded PDA denial of service, duplicate accounts, donations, rent, integer bounds, early completion and proof closure.
3. Evaluate whole-match forfeiture incentives under external rewards, griefing, censorship, chain stalls and an agent unable to pay fees. Timeouts require a funded submitter; they do not run automatically.
4. Exercise independently operated agents across hosts and untrusted RPC services. Private state is permission-restricted but unencrypted; JavaScript arithmetic is not a hardened secret boundary. Losing a hand key can forfeit the match.
5. Review transaction ambiguity and funding recovery. Journals retain the original signed bytes/signature, but manual inspection remains necessary after uncertainty. The example is not an exactly-once payment service.
6. Specify a reviewed, more efficient proof replacement before treating repeated hands as practical. Temporary proof storage and hundreds of transactions per player remain substantial despite the upload improvement.
7. Establish reproducible release builds, cluster syscall availability/cost checks, public devnet evidence, upgrade authority policy, monitoring and an incident response procedure before considering any real-stake release.

See the [test reports](testing.md), [construction](cryptography.md), [program formats](../programs/escrow/README.md), and [measured costs](benchmarks.md). No independent reviewer has endorsed this implementation.
