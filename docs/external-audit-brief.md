# External audit brief: Agent Stacks v5 and protected agent v1

**Status: prepared for review; no independent audit commissioned or completed.** Review the exact files/hashes in a newly generated review package's `manifest.json`. This brief is not an auditor endorsement. No secrets, signed transaction journals, private shuffle witnesses or validator ledgers belong in the package.

## Security objectives and adversary

Two agent operators each deposit the agreed stake. Neither should learn the other's hole cards before authorized showdown, influence an honest shuffle's unpredictability, substitute/duplicate cards, steal escrow, block the opponent's deliverable award through account manipulation, or reuse prior-hand keys/contexts. Required reveals and bets advance public on-chain state. At most one participant is assumed honest for privacy/fairness arguments. Both-colluding-party privacy is not a goal. Abort, censorship, external incentives, unavailable chain access and the economics of whole-match forfeiture must be analyzed explicitly.

The production ambition has no trusted dealer or shared privileged operator. The current protected client assumes its own correctly operated validating node, correct accepted terms, untampered private disk and an uncompromised signer process/OS. It trusts Solana consensus/runtime and the deployed program. It does not authenticate state from arbitrary RPC providers. The test-only upgrade exception remains privileged trust until authority is genuinely removed.

## Construction to review

Use [cryptography.md](cryptography.md) for exact domains, encodings and equations and [the program guide](../programs/escrow/README.md) for tags/layouts. Do not substitute a generic published protocol's proof for analysis of this implementation.

- Ristretto255 card encoding, canonical scalars/points, fresh per-hand keys and aggregate-key nonidentity/possession checks.
- Two-party additive ElGamal and Chaum–Pedersen DLEQ with Fiat–Shamir context binding. Raw `x*A` is reusable independent of its accompanying proof context: analyze chosen-ciphertext queries and every release path.
- The exact 128-round parallel cut-and-choose shuffle, both opening branches, all auxiliary commitments, shared challenge derivation, permutations/masks, adaptive statements, auxiliary-witness leakage, grinding and concurrent/multi-hand sessions. Assess zero knowledge and soundness separately. The project does not claim a whole-protocol 128-bit security proof.
- Composition of two sequential shuffles with initially identity A points, private owner decryption, public peer shares, burn cards, selective abort, showdown and key retention after completion.
- Cooperative acceptance: both honest-side proof-verification and exact transaction reconstruction are necessary; the chain validates joint authorization rather than the shuffle proof. Full proof availability is off-chain. Analyze withheld/late signatures, stale offers, buffer changes, refusal and unilateral fallback.
- RNG provenance, nonce reuse, entropy failures, JavaScript arithmetic/side channels and secret handling during crashes/backups.

## Custody and client scope

Review all tags 0–20, every account owner/signer/address/size check, aliases/duplicate metas, prefunded PDAs, rent transitions, donations, overflow, terminal claims, tombstone retention, proof-buffer allocation/initialization/closure, version and deadline races. Check all terminal paths, not only showdown. Check multi-hand conservation, uncalled bets, short all-ins, tied payouts, evaluator consistency, carryover and key/deck reset.

Review `trusted-agent.js` as a security boundary: trusted versus submission connection, actual bytecode pin and loader metadata, finalized-view monotonicity, key/deck pins, durable-before-compute releases, stale/restored caches, malformed policy/record parsing, conservative signing budgets and pending-signature recovery. Determine whether every secret-dependent release is gated. Confirm the documented limits of first-view trust, same-process code execution, filesystem rollback and per-match budgets.

The low-level `ChainClient`, local simulated peer protocol, and trusted-dealer HTTP demo are separate trust models. The protected executable is not a generic safe signer for arbitrary third-party JavaScript. Remote peer transport and production model integration are not implemented and must not be inferred from local IPC tests.

## Reproduction and requested deliverables

Run `npm ci`, `npm test`, `npm run solana:build`, `npm run solana:test`, Rust formatting/Clippy, advisory scans and `npm run security:reproduce`. Tool versions and all dependency locks accompany the snapshot. Refer to [testing.md](testing.md) and [security-hardening.md](security-hardening.md) for evidence and local node setup. Create fresh keypairs/ledgers; never request the author's private caches.

Tests named `compromised-trusted-node` and the primitive chosen-ciphertext demonstration deliberately expose remaining assumptions. Passing those tests means the limitation was reproduced. Inspect attacks independently instead of treating a green suite as proof of security.

Requested report: version/hash-scoped threat model, severity and concrete impact, minimal exploit/regression for each defect, exact assumptions for privacy/fairness/liveness, cryptographic argument or explicit gaps, client/custody findings, remediation review, and remaining risks. State what was not reviewed, including dependencies, toolchains, hardware/OS, consensus assumptions and public network operations. Keep a private disclosure path until fixes are validated; no publication or outreach is authorized by generating this package.

## Deployment decision

The recommended eventual policy is immutable audited versions with new program IDs for upgrades. Before any irreversible authority removal, independently compare deployed bytes to the signed-off artifact, verify genesis/cluster and loader authority, confirm recovery/timeout/funding procedures, and complete separate-host devnet fault tests. Do not transfer custody to a supposedly audited deployment solely because its program ID or interface matches. Production approval is outstanding.
