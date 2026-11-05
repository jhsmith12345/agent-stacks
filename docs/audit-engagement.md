# Prepared external-review engagement

No reviewer has been contacted, no source has been sent externally, and no paid engagement has been approved.

## Candidate reviewers

These are candidates inferred from their published scope/experience, not verified availability or endorsements of this project. Pricing and scheduling require quotes.

- **Trail of Bits, cryptographic protocol/implementation scope:** its published [cryptography service](https://trailofbits.com/services/cryptography) explicitly covers protocol and implementation reviews, MPC and classical primitives. Ask specifically whether the engagement includes a written argument for this exact ElGamal/DLEQ/cut-and-choose composition, rather than only code review.
- **OtterSec, Solana custody/client scope:** its [services](https://osec.io/services/) describe Solana Rust and cryptographic work, and its [public audit list](https://osec.io/audits/) includes Solana projects. Ask for the escrow program, agent state/signing boundary, upgrade policy and crash/recovery code to be reviewed together.

Both scopes should include an independent remediation review. One firm's unrelated prior work does not establish the security of Agent Stacks. Confirm independence, staff expertise, deliverables, exclusions, private disclosure terms, retest time and total price before engaging.

## Quote request draft — not sent

Subject: Agent Stacks — scoped quote for cryptographic / Solana security review

We are preparing a test-only, two-party dealerless poker protocol using a Solana escrow program and a JavaScript agent. The construction combines Ristretto255 threshold ElGamal, context-bound DLEQ proofs and a custom 128-round Fiat–Shamir cut-and-choose shuffle. An optional cooperative path verifies full proofs in the agents and jointly authorizes the resulting deck on-chain.

We need independent analysis of the exact cryptographic composition and/or an audit of the Solana custody program and protected agent. The accompanying brief specifies the assets, adversaries, implementation, known limitations and requested deliverables. A frozen source/artifact manifest, regression tests and local reproducibility evidence are prepared. No real funds are in use and no public deployment has occurred.

Please identify the scope your team can cover, assigned expertise, assumptions/exclusions, schedule, fixed or bounded price, deliverables and remediation-retest allowance. Cryptographic review should explicitly assess adaptive ciphertext/share queries, witness leakage, Fiat–Shamir composition, selective abort and multi-hand key reuse. Client review should include the operator-controlled node assumption, finality/checkpoints, transaction reconstruction, per-match budgets, pending-signature recovery and local custody.

The audit package contains public source and test receipts only. Wallet secrets, private proof material and signed transaction journals will not be supplied. Please propose secure source/report exchange and disclosure terms before any material is sent.

## Inputs still needed

An external-review budget and reviewer choice (or authority to request quotes), plus a budget/host choice for two separately operated devnet validating nodes. No cloud resources or paid services were provisioned. Public devnet testing also needs test SOL: the project payer's latest status check reported zero and no deployed program. An independent review cannot be supplied by another internal test run.
