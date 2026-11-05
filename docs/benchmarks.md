# Research measurements

Measured November 4, 2026 in the local development environment. These are implementation measurements, not promises of production latency, transaction pricing, or cryptographic security.

| Operation | Observed result |
| --- | --- |
| JS full 52-card shuffle proof generation | Roughly 2.2–2.5 seconds |
| JS shuffle verification | Roughly 2.2–2.3 seconds |
| JSON shuffle transport | Roughly 1.44 MB per shuffle |
| Dense on-chain fixture (40-byte context) | 652,364 bytes |
| Standalone DLEQ SBF verification | Roughly 16,900 CU |
| Escrow key registration including context checks | Roughly 46,000–54,000 CU |
| Historical upload at 900 payload bytes | 725 transactions per proof |
| Current upload at 1,000 payload bytes | 653 transactions per proof (about 10% fewer) |
| Upload compute at 1,000 bytes | 536,766 CU total for the 652,364-byte fixture (previously 595,950 CU) |
| Seal/hash full proof commitment prefix | Roughly 218,000 CU |
| All 128 shuffle rounds in SBF | Roughly 40 million CU total, 32 transactions at four rounds each |
| Consume verified shuffle into bound escrow | Roughly 30,000–36,000 CU |
| Automatic showdown evaluation and payout | Roughly 94,000–100,000 CU |
| Refundable proof-account storage in LiteSVM | 4,541,928,960 lamports, about 4.54 SOL |
| Strict shuffle through the protected agent, local validator at 400 ms slots | 406 seconds (0.50 s per upload/verification step; 17.4 s per finalized step) |
| Complete strict hand, two agents, same conditions | 22 minutes |

Each hand needs two shuffle proofs. Storage is reclaimed after each verified proof is consumed into escrow; the RPC demo reuses the temporary funding between players. JSON size differs from the dense format; this is not a proposal to post JSON on-chain.

The verifier accepts up to four rounds per transaction with an explicitly requested compute limit. The test prints the measured transaction count and total CU. Escrow consumes a verified output to advance setup; upload and verification alone do not advance a match or reset its deadline. Betting, verified public reveals, showdown evaluation and automatic settlement now execute on-chain across the agreed multi-hand match.

The original v3 local RPC run uploaded 652,511 bytes per proof and took several minutes per shuffle because uploads are sequential and each transaction waits for confirmation. The hand-bound v4 contexts add a few bytes. Local-only confirmation polling is now faster; public devnet polling is unchanged. These are local-validator measurements, not devnet latency measurements.

These measurements make the tradeoff concrete: the baseline can run on Solana's VM, but hundreds of uploads per shuffle and significant temporary storage are poor ergonomics for repeated hands. Investigate a reviewed succinct shuffle proof, aggregation, or a different verifiable dealing construction before committing to this format for launch. A committee-based MPC dealer would change the original two-party trust model and is not an equivalent optimization.

Reproduce:

```sh
npm ci
npm run solana:build
npm run solana:test
npm run demo:peer
```

The VM test prints storage, upload, sealing, key-registration, and verification measurements. The peer demo writes proof-generation and verification timings to its public transcript. Host Rust is pinned to 1.96.0; the SBF toolchain was Rust 1.95.0 / platform-tools v1.57, via local Agave CLI 4.4.0, whose tarball matches the official release digest recorded in `solana-tools.sha256`. Dependencies are recorded in Cargo.lock and package-lock.json. Byte-for-byte reproducible release builds are not established.


## Optional cooperative path

A later two-hand local RPC match measured 42 transactions and 230,000 lamports (0.00023 SOL) in base fees per hand, versus 1,406 transactions / 0.00704 SOL for the full on-chain proof path. The compact deck buffer required 24,617,520 lamports of refundable storage funding. Joint acceptance used roughly 26,000–32,000 CU in SBF tests. The unchanged full proof is generated and verified off-chain; this is joint authorization rather than a succinct chain-verifiable shuffle proof. The full verifier remains the unilateral fallback and SDK default. See the [detailed cost report and model](optimization.md).
