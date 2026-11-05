# Cryptographic construction and limitations

This is an experimental composition of threshold ElGamal, Chaum–Pedersen equality-of-discrete-log proofs, and a cut-and-choose shuffle proof. Curve operations come from pinned `@noble/curves` in JavaScript and Solana Ristretto syscalls in SBF. It is not an audited mental-poker library, a formal security proof, or a claim of production security.

References: [RFC 9496: Ristretto](https://www.rfc-editor.org/rfc/rfc9496), [noble-curves documentation](https://github.com/paulmillr/noble-curves), [Mental Poker Revisited](https://research-information.bris.ac.uk/en/publications/mental-poker-revisited/), and [Solana cryptographic syscalls](https://solana.com/docs/core/programs/syscall-reference). The implemented shuffle is deliberately simple; it should not be represented as an implementation of an entire published mental-poker protocol.

## Encrypted cards

All operations use additive notation in the prime-order Ristretto255 group, with base point G and order q. Fixed card strings map to points using noble's Ristretto hash-to-curve, over `agent-stacks/card/v1/CARD`. The first deck has 52 pairs `(identity, M_card)` in the documented rank/suit order.

Agents choose fresh nonzero scalars xA and xB, prove possession, and publish XA=xA·G and XB=xB·G. The aggregate X=XA+XB must not be identity. Proofs of possession are required to reject a rogue-key cancellation attack.

An encrypted card is `(A=r·G, B=M+r·X)`. Re-encryption adds `(s·G, s·X)`. Each agent independently permutes and re-encrypts the entire deck. Fresh randomness uses rejection sampling and Fisher–Yates uses Node's cryptographic `randomInt`. An honest random shuffle supplies unpredictability; the proof verifies a valid permutation/re-encryption, not that a malicious player's permutation was sampled fairly.

An agent's decryption share is D=x·A, accompanied by proof that `log_G(X)=log_A(D)`. Public card recovery subtracts both shares from B. For a hole card, only the opponent publishes a share; the owner computes its own share privately and decodes locally. At showdown the owner publishes its missing share. Burn positions never receive public shares.

## Equality proofs

For secret x and second base A, choose fresh k. Publish T1=k·G and T2=k·A. The challenge is:

```text
c = little_endian(SHA256(
  "agent-stacks/dleq/ristretto255/v1" ||
  context_length_u16_le || context_utf8 ||
  public_key_32 || base2_32 || share_32 || T1_32 || T2_32
)) mod q
s = k + c*x mod q
```

Verify `s·G=T1+c·X` and `s·A=T2+c·D`. Canonical scalar encodings and valid nonidentity Ristretto points are required. Context binds match terms, hand, phase, signer seat, and card position. Key possession uses G as both bases. Random nonces must never be reused for different challenges.

Wire format is context length (u16 LE), context bytes, then six 32-byte fields: public key, second base, share, T1, T2, response. Scalars use canonical little-endian encoding. The JavaScript and SBF versions verify the same vectors.

## Shuffle proof

Let output Y be the actual permutation/re-encryption of input C, with output-to-input permutation pi and per-output masks r. For each of 128 rounds choose an independent permutation tau and independent masks s; commit to Z, a permutation/re-encryption of C using tau/s.

A Fiat–Shamir bit selects one opening per round:

- Bit 0: reveal tau and s, proving Z relates to the input.
- Bit 1: for each Z position reveal j=pi^-1(tau[position]) and delta=s[position]-r[j], proving Z relates to the output.

Both openings would expose a valid input/output relation. Requiring a bijection in every opening prevents duplicate-card substitution. The usual cut-and-choose intuition targets a 2^-128 cheating probability before considering the full composition and random-oracle assumptions; that is not a substitute for a formal review. Overall security also depends on the group, ElGamal assumptions, Fiat–Shamir composition, authentication, and implementation/side-channel behavior.

Protocol `agent-stacks/elgamal-cut-and-choose/v2` derives all 128 challenge bits from SHA-256 of its domain followed by this dense prefix:

```text
n_u16_le || context_length_u16_le || context_utf8 || joint_key_32 ||
input[n] || output[n] || commitments[128][n]
```

Each ciphertext is A then B (64 bytes). Challenge bit r is `(digest[r/8] >> (r%8)) & 1`. Only the first 128 bits are needed. Proof responses follow the prefix: each round has n permutation bytes followed by n canonical 32-byte scalar masks. A full 52-card dense proof is `652324 + context_byte_length` bytes. The verifier fixes 128 rounds; there is no reduced-security flag. The Solana implementation fixes 52 cards.

JSON signatures authenticate the complete proof transport object. The dense prefix is what the cross-language shuffle verifier hashes. Version 1 experimental shuffle transcripts are incompatible with version 2 and must be regenerated.

## On-chain large-proof verification

A normal transaction cannot carry the whole proof. A separate program-owned account receives sequential chunks, then seals. Sealing hashes the complete commitment prefix once. After sealing, writes are rejected. Verification checks a contiguous next batch of 1–4 rounds and advances progress only if the whole transaction succeeds. The complete flag is set only after all 128 rounds verify. An authority can reclaim the proof account's storage balance by closing it.

This verifier certifies a mathematical relation between the account's input, output, key, and context. The escrow consumer now binds all of these values to the expected match phase, checks the proof authority, and copies the verified output into match state. The first input is the fixed initial 52-card deck; the second input must equal the first verified output. Closing a consumed proof therefore cannot erase the stored deck. The multi-hand escrow additionally verifies each required decryption share against its stored key, ciphertext and phase, runs betting rules, evaluates showdown, and pays automatically. A verified shuffle by itself does not authorize a payout. A standalone verified flag without these bindings remains insufficient.

## Optional jointly authorized shuffle

The optional path in `compact.rs` is not a replacement cryptographic proof. The generating agent supplies the same full 128-round proof off-chain, and the counterparty independently verifies it against current chain state before signing. Both stored wallet signatures commit to a reconstructed acceptance transaction containing the exact output-deck hash, buffer, match and expected version. The chain validates those signatures and the buffer bindings/points, then copies the deck. It does not verify the shuffle relation on this path.

Correct independent proof verification by an honest participant remains necessary; the full proof is not available from chain history alone. Refusal does not create an acknowledgement obligation or reset any deadline. The actor retains the original unilateral full-proof route. Old joint signatures become stale after a different valid transition. This composition needs its own review and is opt-in in the SDK demo. See [the model and tests](optimization.md).

## Unresolved work

The [November 4 re-audit](security-audit-2026-11-04.md) reproduced a card-share leak through forged RPC state even when transaction submission fails. Context-bound DLEQ proofs do not prevent a raw share from decrypting its ciphertext. The [protected agent](security-hardening.md) now gates releases on finalized state from an explicitly trusted operator node and durable checkpoints. This does not change the cryptography or authenticate arbitrary untrusted state RPCs; a compromised configured node can still obtain a share.

- Independent security analysis of the exact transcript construction and two-party privacy/abort model.
- Efficient proof replacement or transaction/storage optimization if this baseline is too expensive per hand.
- Review of multi-hand chain composition, fresh-key generation and hand-bound contexts; the separate local protocol still uses simulated escrow and trusted timestamps.
- Durable private agent-key storage, recovery, zeroization, and side-channel review. JavaScript BigInt execution is not a hardened secret-isolation boundary.
- Concrete protection against censorship, malicious RPC state, transaction ambiguity, and funded timeout-submission failure.

Tests establish implemented behavior and cross-language agreement. They cannot establish that no cryptanalytic attack exists.
