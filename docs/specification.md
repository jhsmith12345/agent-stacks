# Dealerless research protocol specification

Status: implemented locally, cryptographic composition not independently reviewed. This document describes the multi-hand local peer protocol. A separate multi-hand Solana implementation now runs the corresponding dealing, betting, showdown, payout and timeout obligations on-chain; its terms codec and instruction formats are documented in the Solana program guide.

## Agreed terms and identities

A match identifies two distinct Ed25519 signing keys, a unique match ID, an equal buy-in, even big blind (small blind is half), hand limit, turn duration (30 seconds–72 hours), and the whole-match timeout policy. Both agents sign acceptance of the SHA-512 terms digest before play. Match IDs must never be reused.

Messages use the separate signing domain `agent-stacks/mental-poker/local/v1`, with `player`, `nonce`, `issuedAt`, and `command`. Canonical signing follows `src/crypto.js`. Every command includes `matchId`, `termsHash`, `handNo`, and `expectedVersion`; `accept` also explicitly checks the terms digest. Each identity's nonce is sequential within this peer session. Successful transitions increment the match version. Invalid messages change neither state, nonce, version, nor deadline.

These local Ed25519 identities use DER/base64url encoding. They are not Solana keypair files. The chain SDK instead uses Solana transaction signatures, expected account versions, and a SHA-256 terms commitment binding genesis hash, program, participants, buy-in, blind, clock and the agreed hand limit. Do not interchange the two envelope formats.

## Obligations

| Phase | Responsible player | Required valid message | Next phase |
| --- | --- | --- | --- |
| Accept A | A | Signed agreed terms | Accept B |
| Accept B | B | Signed agreed terms | New hand / key A |
| Key A | A | Fresh Ristretto key and proof of possession | Key B |
| Key B | B | Fresh key and proof; aggregate must be nonidentity | Shuffle A |
| Shuffle A | A | Valid 128-round shuffle/re-encryption proof | Shuffle B |
| Shuffle B | B | Valid proof over A's verified output | Hole shares from B |
| Hole shares from B | B | Proved shares for A's positions 0 and 2 | Hole shares from A |
| Hole shares from A | A | Proved shares for B's positions 1 and 3 | Preflop betting |
| Betting | Current poker actor | Legal signed action | Next actor, board, showdown, or next hand |
| Board share A | A | Proved shares for the next required board positions | Board share B |
| Board share B | B | Proved shares; decode valid public cards | Resume betting or continue all-in runout |
| Showdown A | A | Own shares for positions 0 and 2 | Showdown B |
| Showdown B | B | Own shares for positions 1 and 3 | Evaluate and settle hand |

The button alternates by hand; seat 0 has the first button. Position assignments are fixed by seat, independently of the button. Positions 4, 8, and 10 are undecrypted burns. Flop positions are 5/6/7, turn 9, river 11. No one chooses a favorable position after seeing cards.

Each hand uses fresh encryption key shares and both fresh shuffles. Neither participant reveals its secret scalar, shuffle permutation, or actual re-encryption randomness. Shuffle proof openings expose only masked auxiliary witnesses. The dealerless game state has no plaintext deck. Hole cards enter public game state only at showdown. Folding settles the hand without revealing them.

The public poker engine pauses when it requires an external deal, board cards, or showdown cards. Only verified card shares resume it. It cannot silently fall back to its trusted random dealer.

## Clocks and aborts

Every phase has one obligated seat and a deadline. A valid phase transition starts the next obligation's clock. Invalid work does not extend time. At `now >= deadline`, a signed claim from any identity completes the match; no automatic callback exists.

Before both accept, expiry refunds the simulated buy-ins. After both accept, default awards **all match escrow**, including both remaining stacks and current wagers, to the other participant. The claimer receives no bounty. This explicit policy also applies to withheld keys, shuffle proofs, hole shares, board shares, betting actions, and showdown shares.

This prevents indefinite locked simulated funds in the local state machine. It does not recover a withheld key or ensure that a hand continues. Its economic adequacy assumes the match's bounded, two-player, zero-sum stakes are the relevant incentive; no guarantee is made for external rewards, griefing, compromised agents, or network censorship.

In the local experiment the verifier's clock and recorded acceptance timestamps remain trusted. A transcript replayer verifies internal timing consistency, not the truth of wall-clock timestamps. Final custody must use on-chain obligations and chain time. A recipient's acknowledgement is never required to validate the sender's action; requiring bilateral acknowledgement would allow the recipient to manufacture a timeout against the sender.

## What each process trusts

`VerifiedPeerAgent` derives state from independently verified signed messages. It does not accept arbitrary relay-supplied views or decryption-position requests. A relay can withhold or delay messages; it cannot cause the verified agent to release shares for undealt positions by editing a view. The lower-level `MentalPokerAgent` assumes its caller already verified state and is not a safe transport boundary by itself.

The example relay routes messages, verifies them, and holds simulated escrow. It never receives private hand keys or wallet secrets. Each child independently verifies the same transcript before making its next decision. The peer demo uses local IPC. The separate chain agents coordinate through RPC and persist private hand keys and proof uploads with owner-only permissions. They journal signed transactions before submission and can resume interrupted uploads. Storage is not encrypted, and the RPC is a trusted state source; discovery, hardened secret storage, and robust adversarial RPC recovery remain work.

## Release gates

A final protocol requires: on-chain agreement to all terms; on-chain betting and required-share transitions; verified showdown and unilateral payout; attributable deadlines for proof uploads/verification; safe proof-account consumption/closure; independently reviewed cryptography; and adversarial local-validator/devnet tests. The multi-hand chain implementation now covers terms checking in the SDK, betting, required shares, showdown, unilateral payouts, all active timeout obligations, and consumed-proof closure. SBF and a full local-validator RPC match pass. Public devnet verification, independent operation across hosts, and independent security review remain release gates.
