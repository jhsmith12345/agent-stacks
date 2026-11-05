# Experimental multi-hand Solana poker program

**Research prototype. Full multi-hand poker and automatic payouts pass local tests. Cryptography and custody are unaudited. Test funds only. No public deployment.**

This is a native Rust program, compiled to SBF and exercised by LiteSVM. No Anchor, public RPC, normal user wallet, or deployment is used by the test workflow.

## Build and test

```sh
npm ci
npm run solana:build
npm run solana:test
```

Install the official [Agave/Solana CLI build tools](https://docs.anza.xyz/cli/install) if `cargo-build-sbf` is unavailable. On this workspace they are already installed under `.tools/solana-release/bin`, which the build helper finds automatically. `CARGO_BUILD_SBF` can point to an alternate executable. The helper installs its official platform tools when needed and prepends their Rust binaries for that process; it does not change the user's default toolchain.

Host tests use the repository's Rust `stable` toolchain selection. The tested versions and dependency locks are documented in [benchmarks](../../docs/benchmarks.md). The first build downloads dependencies and platform tools. The compiled artifact is `target/deploy/agent_stacks_escrow.so`; its generated local keypair is ignored. The program ID is supplied by the loader/test harness, not embedded in the code.

The tests create and sign real Solana transaction objects, execute the compiled SBF inside LiteSVM, and inspect accounts and balances. They do not merely call the Rust processor as a host function. Host-side proof checks are additional cross-language checks.

## Escrow lifecycle

```text
WaitingJoin -> KeyA -> KeyB -> ShuffleA -> ShuffleB
  -> HoleSharesB -> HoleSharesA -> Betting
  -> BoardSharesA/B -> Betting (repeat streets)
  -> ShowdownA -> ShowdownB -> next hand / automatic final payout -> Complete -> Close
```

A fold or showdown ends a hand. The program carries awarded stacks into the next hand, or pays automatically at the hand limit or when a stack is empty. No funds leave escrow between hands. All-in hands reveal the remaining board before showdown. Joint settlement is available after joining. Before joining, cancellation or expiry returns only the creator's deposit. After joining, any expired obligation forfeits both deposits to the non-obligated player. Anyone can submit the claim; destinations are forced to the stored players. Each accepted escrow mutation increments its version. Invalid proofs, partial uploads and proof verification do not reset its deadline.

The first shuffle input is the fixed deck in `cards.rs`. The aggregate key comes from registered keys. Consuming a verified proof checks ownership, complete verification, authority, context, key and exact input. The output is copied into escrow before its proof account can close. The second shuffle must use that stored output.

Each card-share transaction verifies one DLEQ proof against the obligated signer, registered key, encrypted position and context. Only the opponent's shares for a player's hole cards are public before showdown. Public cards decode by subtracting both shares and looking up a canonical card point. Burns are never decrypted.

## Instructions

Each instruction begins with one u8 tag. Integers are little-endian. All escrow mutations except creation then carry `expectedVersion: u64`.

| Tag | Operation | Data after tag | Ordered accounts |
| --- | --- | --- | --- |
| 0 | Verify DLEQ | Proof wire from crypto specification | None |
| 1 | Create | nonce[32], buyIn:u64, turnSeconds:u32, termsHash[32], bigBlind:u64, maxHands:u32 | creator signer+writable, named opponent readonly, match PDA writable, System Program |
| 2 | Join | version:u64, termsHash[32] | match writable, opponent signer+writable, System Program |
| 3 | Register key | version:u64, DLEQ wire | match writable, obligated player signer |
| 4 | Cooperative settle | version:u64, payoutA:u64, payoutB:u64 | match writable, A signer+writable, B signer+writable |
| 5 | Any active timeout | version:u64 | match writable, A writable, B writable; any transaction fee payer |
| 6 | Cancel invitation | version:u64 | match writable, creator signer+writable |
| 7 | Close completed escrow | version:u64 | match writable, creator signer+writable |
| 8 | Initialize proof | dense wire length:u32 | preallocated proof account signer+writable, authority signer |
| 9 | Append proof | offset:u32, 1–1,000 payload bytes | proof writable, authority signer |
| 10 | Seal proof | none | proof writable, authority signer |
| 11 | Verify rounds | expectedNextRound:u16, count:u8 (1–4) | proof writable, authority signer |
| 12 | Close proof | none | proof writable, authority signer+writable |
| 13 | Consume verified shuffle | version:u64 | match writable, obligated player signer, verified proof readonly |
| 14 | Required card share | version:u64, logicalPosition:u8, DLEQ wire | match writable, actor signer, A writable, B writable |
| 15 | Poker action | version:u64, action:u8, amount:u64 | match writable, actor signer, A writable, B writable |
| 20 | Claim deferred payout | version:u64, seat:u8 | match writable, entitled player signer, chosen destination writable |

Match PDA seeds are `['escrow', creator_pubkey_bytes, nonce_32]`. Use a fresh nonce for each challenge. Creation bounds the buy-in to at most 1,000,000,000,000 lamports and the turn clock to 30–259,200 seconds. The big blind must be even, at least 2 lamports and at most one tenth of the buy-in. The hand limit is 1–1,000. Seat A starts on the button; it alternates each hand. This is SOL-only; SPL tokens are not supported. Deposits do not include fees or the refundable match-account storage balance.

The terms hash is an opaque 32-byte commitment supplied by the creator and accepted by the opponent. The included SDK recomputes the agreed commitment and verifies actual account fields—including participants, buy-in, timeout, cluster, and program—before signing join. The SDK commits SHA-256 of canonical JSON with protocol `agent-stacks/escrow/v5`, genesis, program, players, buyIn, bigBlind, turnSeconds, and handLimit=maxHands. The program stores the opaque commitment and enforces its instruction fields; clients must verify their meaning before accepting.

Key context: `agent-stacks/escrow/key/v2/PROGRAM_ID/MATCH_PDA/HAND_NO/SEAT/TERMS_HEX`. Key proofs must use the fixed group base as their second base and repeat the public key as the share. Shuffle context: `agent-stacks/escrow/shuffle/v3/PROGRAM_ID/MATCH_PDA/HAND_NO/SEAT/TERMS_HEX`. Share context: `agent-stacks/escrow/share/v2/PROGRAM_ID/MATCH_PDA/HAND_NO/PHASE/SEAT/LOGICAL_POSITION/TERMS_HEX`. Logical positions 0..8 map to encrypted deck positions `[0,1,2,3,5,6,7,9,11]`. Hand numbers start at 1 and bind all key, shuffle and share proofs. Completed hands advance automatically while both stacks are positive and the hand limit has not been reached. Resetting keys, deck and shares prevents prior-hand state from carrying into the next deal. Agents generate fresh hand keys and proofs; the program checks hand-bound contexts rather than proving randomness freshness.

A proof account is an ordinary fresh account allocated to this program with a separate outer System Program create-account instruction. It is large enough to hold the dense wire plus its 84-byte header and must have the simulated rent-exempt balance. A PDA CPI cannot simply allocate this size in one step. Uploads are strictly sequential; no overwrites or writes after sealing are accepted. Request an appropriate compute limit for sealing and verification—tests request 1,400,000 CU and verify four rounds per transaction. A failed batch makes no partial progress.

## Escrow account layout

Fixed size: 4,260 bytes. Magic `ASTKESC5` identifies the current layout. Earlier experimental layouts are incompatible: interpreting their terminal cursor as unpaid claims would be unsafe.

| Offset | Size | Value |
| --- | --- | --- |
| 0 | 8 | Magic |
| 8 | 1 | Phase: 0 waiting, 1 key A, 2 key B, 3 shuffle A, 4 shuffle B, 5 holes from B, 6 complete, 7 holes from A, 8 betting, 9/10 board A/B, 11/12 showdown A/B |
| 9 | 8 | Version |
| 17 | 32 | Creator/A |
| 49 | 32 | Opponent/B |
| 81 | 8 | Buy-in |
| 89 | 8 | Turn seconds, i64 |
| 97 | 8 | Deadline timestamp, i64 seconds; phase 6 is terminal |
| 105 | 32 | Terms commitment |
| 137 | 64 | Both encryption public keys |
| 201 | 16 | Historical awarded payouts, including any pending claim |
| 217 | 32 | Nonce |
| 249 | 1 | PDA bump |
| 250 | 3,328 | Current encrypted deck, A/B point pairs for 52 cards |
| 3578 | 8 | Big blind |
| 3586 | 89 | Public poker state |
| 3675 | 576 | Nine logical cards, two 32-byte share points each |
| 4251 | 1 | Active: share cursor. Complete: pending payout bitmask (bit 0 A, bit 1 B) |
| 4252 | 4 | Current hand number, u32, starting at 1 |
| 4256 | 4 | Agreed maximum hands, u32 |

The account holds deposited lamports plus storage balance. Payouts debit only deposits. If a recipient cannot receive a positive award without violating rent constraints, settlement still completes and retains that award in escrow. Tag 20 lets only its entitled player withdraw to a writable destination, once, using the current version. A failed credit preserves the claim. The destination cannot be the escrow itself. A funded fee payer is required; the claimant can sign a sponsored transaction.

Tag 7 requires no pending claims. It returns residual lamports, including existing donations, less rent for an eight-byte permanent `ASTKEND5` tombstone. The program retains ownership so the match address and its cryptographic contexts can never be reused. Tested tombstone rent is 946,560 lamports per match. Donations after retirement cannot be reclaimed. Prefunded unused PDAs are rejected during creation; choose another nonce if an address was prefunded. See the [security re-audit](../../docs/security-audit-2026-11-04.md).

Poker state encodes nine u64 fields: stacks A/B, street bets A/B, contributions A/B, current bet, minimum raise and big blind. Relative offsets 72–79 hold actor, pending mask, acted mask, street, stage, button, winner and reason. Offsets 80–84 hold board IDs, 85–88 hole IDs. Card IDs are rank index (2..A) times four plus suit index (c/d/h/s); 255 means unknown. Stages are 0 betting, 1 awaiting board, 2 awaiting showdown, 3 complete. Poker reasons are 0 fold and 1 showdown; invitation refunds, timeout and joint settlement are represented by terminal escrow phase/payouts, not this poker reason cache.

Action codes are 0 fold, 1 check, 2 call, 3 raise, 4 all-in. Only raise accepts a nonzero amount, specifying the total contribution on this street. Short all-ins do not reopen raising for a player who already acted. Unmatched bets are returned before calculating winnings. In heads-up play the matched pot is twice the matched contribution, so a tied pot splits evenly.

## Proof-account header

Magic `ASTKSHF1`; 84-byte header followed by the dense shuffle wire:

| Offset | Size | Value |
| --- | --- | --- |
| 0 | 8 | Magic |
| 8 | 32 | Authority |
| 40 | 4 | Declared wire length |
| 44 | 4 | Sequential bytes written |
| 48 | 1 | Sealed flag |
| 49 | 2 | Next verification round |
| 51 | 32 | Fiat–Shamir challenge digest |
| 83 | 1 | All rounds verified |

A proof authority can close any of its proof accounts. This can interrupt its own pending setup and lead to timeout forfeiture; it cannot erase a deck already copied to escrow. A standalone proof's verified flag alone is never a poker-result certificate.

## Remaining release work

See [the Solana status](../../docs/solana.md), [local test evidence](../../docs/testing.md), and [operation/recovery guide](../../docs/devnet.md). Efficient reviewed proofs, public devnet testing, hardened key and RPC recovery, and independent audits remain. Public deployment and production upgrade-authority policy are not finalized.


## Optional joint deck acceptance (tags 16–19)

This path requires both players' authorization and does **not** verify the shuffle relation on-chain. The counterparty client verifies the complete 128-round proof against current state before co-signing. The default unilateral tag-13 proof path remains available; offering or refusing joint acceptance neither resets a deadline nor assigns a new timeout obligation. See [the acceptance model and measured fees](../../docs/optimization.md).

| Tag | Operation | Data after tag | Ordered accounts |
| --- | --- | --- | --- |
| 16 | Initialize compact deck buffer | none | preallocated buffer signer+writable, obligated actor signer, match readonly |
| 17 | Append deck | offset:u32, 1–1,000 bytes | buffer writable, authority signer |
| 18 | Jointly consume deck | expectedVersion:u64, outputSHA256[32] | match writable, obligated actor signer, other player signer, buffer readonly |
| 19 | Close compact buffer | none | buffer writable, authority signer+writable |

The buffer is 3,409 bytes, preallocated to this program through an outer System Program create-account instruction. Header: magic `ASTKDK01` at 0 (8 bytes), authority at 8 (32), match at 40 (32), hand u32 at 72, seat u8 at 76, sequential written length u32 at 77, then 3,328 deck bytes at 81. Initialization checks the current shuffle actor and deadline. Uploads are sequential and cannot overwrite bytes. A consumed deck is copied into escrow before buffer storage is reclaimed.

Joint consumption checks both stored signers, active phase/deadline, expected version, owner/authority/match/hand/seat, complete upload, exact SHA-256 hash and valid canonical Ristretto points. Those checks do not establish a valid shuffle; correct independent agent verification before signing is essential. The locally reconstructed acceptance transaction has exactly this instruction and cannot contain relay-supplied transfers. Closure is authority-only and cannot erase the copied deck. These tags retain their wire format in v5; the match layout magic and terminal payout semantics have changed.
