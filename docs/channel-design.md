# Channel design: off-chain play, on-chain court

**Status: built and played on a local validator and public devnet, experimental, test funds only, not independently reviewed.** This replaces "each player runs a validating node" as the plan for safe play with friends and strangers. Results are in the [testing report](testing.md).

## The idea

Agents play hands directly through signed messages. The contract holds deposits, pays out, and settles disputes. In a normal match it sees only a create, a join and a close.

The [card-leak attack](security-audit-2026-11-04.md) (AS-03) exists because an agent asks an RPC what to reveal next. Here, an agent works out what it owes from messages it has verified itself, so an RPC has no part in what gets revealed during play.

## What is trustless

| Who | Steal funds | See hidden cards | Change the result | Stall |
| --- | --- | --- | --- | --- |
| Opponent | No | No | No | Yes, but a timeout counts as a fold |
| Relay | No | No | No | Yes, then agents go to the chain |
| RPC provider | No | No, unless every source lies during a dispute | No | Could hide a deadline from you |
| Deployer, once the program is immutable | No | No | No | No |

These assumptions remain:

- **Immutability:** a program with an upgrade key isn't trustless, because that key can replace the rules.
- **Correct code and cryptography:** anyone can read them, but they still need independent review.
- **Your own machine:** it holds your hand keys and session key.
- **One honest source of chain data:** you need it to see a dispute in time. Agents can read from several sources, and running your own node stays optional.

## Keys

Each player has a wallet and a session key.

- **Wallet:** signs only the create or join transaction, and is where payouts go.
- **Session key:** held by the agent. It signs game states and pays dispute fees from a small balance. It can't move a deposit anywhere except by the match's rules.

The joiner sends a session key to the creator in an offer signed by its wallet. The creator writes both session keys and the stakes into the account. The contract computes the terms hash from what it actually stores, and the joiner's transaction must carry the same hash, computed from the terms it accepted. If a creator stored anything else, such as its own key in the joiner's seat or a bigger stake, the join fails. So neither player has to read the terms back from an RPC.

## Match flow

1. **Create and join:** both deposit. The account enters `OPEN`, where no clock runs.
2. **Setup, repeated for each hand:** both agents register hand keys and shuffle, each verifying the other's proof locally. Then both sign the accepted deck as the hand's first state. Before that signature no card is decryptable, so an abandoned setup just settles at the last agreed stacks.
3. **Play:** the obligated player applies one step, signs the resulting state and sends it. The other verifies the step against its own copy of the rules and co-signs. Nobody moves until the current state has both signatures.
4. **Between hands:** both sign the new stacks.
5. **Close:** both sign final stacks, and one transaction pays out without waiting.

## Rules that make it safe

**Release rule.** An agent releases a card share only when its own engine says the share is owed in a state the opponent has signed. Any state the opponent signed is one this agent can co-sign and post, so the opponent can't later deny it.

**One signature per step.** A player signs at most one state at each sequence number, and records it durably before sending. Signing two different states at one sequence number is provable from the signatures alone, and the contract then awards the whole match escrow to the other player. Never restore an agent from an old backup mid-match, because that could cause exactly this.

**Fixed challenge window.** After any post, for `turnSeconds`:

- No game moves are allowed.
- Either player may post a state with a higher sequence number, which restarts the window.
- A player who holds a newer state must post it now, because after the window no state can be posted again.

This stops two attacks an earlier sketch allowed:

- **Rollback:** a player secretly co-signs the opponent's bet without sending it back, then plays forward on chain until the flop is revealed. It then posts the withheld state to return to its own decision, with the flop known. The window closes before any card can be revealed on chain, so this can't happen.
- **Fork:** a player signs one move off-chain and sends a different one on chain. The co-signed state beats it during the window, and the two signatures together forfeit the match afterwards.

**Signed on-chain moves.** After the window, each on-chain move must carry the mover's signature on the resulting state, and the contract checks it. So everything an opponent does on chain is also a binding signature. An agent validates that signature and the step against its local engine before acting, so a lying RPC can't invent an obligation. If an opponent signs a move the RPC only pretends landed, and then does something else on chain, the signatures prove it and they forfeit.

**Timeout means fold.** A player who misses a deadline during a hand loses that pot, and the match settles. This replaces the older whole-match forfeit. Stalling gains nothing a fold wouldn't give, and a dropped connection doesn't cost a player's whole stake. It needs review, because the incentive argument is new.

**No hand continues on chain.** A dispute plays out only the current hand, and then the match settles at the resulting stacks.

## No on-chain shuffle check

A shuffle dispute ends in "no hand", so the contract never has to verify a shuffle. Disputes need only:

- signature checks,
- betting actions,
- card-share proofs (about 17,000 compute units each),
- and hand evaluation.

The temporary rent for a dispute is about 0.008 SOL at today's rent, against about 3.3 SOL for the full-proof path.

## Wire formats

All integers are little-endian. `sha256` is plain SHA-256.

**Terms hash.** The contract computes this at creation, and a joiner must send the same value:

```text
sha256("agent-stacks/channel/terms/v1" || program || creator || opponent || genesis || buyIn(u64) || turnSeconds(u32) || bigBlind(u64) || maxHands(u32) || session0 || session1)
```

**Signed message.** Both session keys sign this 32-byte value with Ed25519:

```text
sha256("agent-stacks/channel/v1" || program || match || terms || kind(u8) || seq(u64) || sha256(payload))
```

| Kind | Name | Payload |
| --- | --- | --- |
| 1 | Stacks | `hand(u32) stack0(u64) stack1(u64)` |
| 2 | Close | `stack0(u64) stack1(u64)` |
| 3 | Hand | The 1,311-byte hand state below |

**Hand state.** Only the nine cards that can ever be revealed are included. The other 43 are checked off-chain and never matter on chain.

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 1 | Phase |
| 1 | 1 | Cursor |
| 2 | 4 | Hand number |
| 6 | 64 | Both hand public keys |
| 70 | 576 | Cards at physical positions 0, 1, 2, 3, 5, 6, 7, 9, 11 |
| 646 | 89 | Game, encoded as `game.rs` does |
| 735 | 576 | Card shares, two per card |

Phases and share contexts are the ones the program already uses, so a share made off-chain can be replayed on chain unchanged.

## Contract instructions

Channel accounts use their own address seed and magic bytes, so the existing instructions can't touch them. They start with the same layout as existing matches, followed by a channel section:

| Offset | Bytes | Field |
| --- | --- | --- |
| 4260 | 64 | Both session keys |
| 4324 | 8 | Sequence number |
| 4332 | 8 | End of the challenge window |

| Tag | Name | Who | Effect |
| --- | --- | --- | --- |
| 30 | Create | Creator wallet | Deposit, store the terms and both session keys, and compute the terms hash |
| 31 | Join | Opponent wallet | Must send the same terms hash. Deposit, enter `OPEN` |
| 32 | Cancel | Creator wallet | Refund before anyone joins |
| 33 | Close | Anyone, with both signatures | Settle now at signed stacks |
| 34 | Post stacks | Either player | Start or extend the window. Sequence 0 needs no signatures and means the original deposits |
| 35–37 | State buffer | Poster | Create, write, close a buffer for a hand state |
| 38 | Post hand | Either player, with both signatures | Same as 34, from a buffer |
| 39 | Action | Obligated player | Betting move after the window, with a signature on the result |
| 40 | Share | Obligated player | Card share after the window, with a signature on the result |
| 41 | Timeout | Anyone | After a deadline: refund, settle, or fold the obligated player and settle |
| 42 | Equivocation | Anyone | Two signatures from one player at one sequence number forfeit the escrow to the other player |
| 43 | Claim | Player | Collect a payout that couldn't be delivered |
| 44 | Retire | Creator wallet | Reclaim rent, leave a tombstone |

Signatures are checked through Solana's Ed25519 program. The contract reads the instruction just before its own and requires:

- two entries (or one, for a move) whose offsets all point inside that instruction,
- the exact session keys,
- and the exact signed message.

## What still has to be true before real money

- Independent review of this design and its code.
- An immutable deployment, with the binary format and build environment settled first.
- A transport for strangers: matchmaking, and an untrusted relay that can only delay messages.
- Legal advice, which this document doesn't replace.

More than two players isn't covered. Channels get much harder with more seats.

## Known limits

- **A lying RPC can start a dispute.** If an agent's sources claim one exists, it stops playing off-chain and posts its newest state, which turns the claim into a real dispute. No funds or cards are at risk, and the hand plays out on chain, but it does cost time and fees. Reading from several sources makes this harder.
- **An offline player can lose a pot, or more.** A player away for longer than the clock can lose the current pot on a timeout. A player away past a challenge window can also be rolled back to an older state, which only matters if it had agreed to something newer. So the clock has to suit how reliably players stay online.
- **Restoring old state is dangerous.** An agent restored from an old backup mid-match could sign a second state at some step, and lose its whole stake.
- **After a missed window, an agent may not be able to continue.** If it has to fall back to an older state and would decide differently at some step, it refuses to sign, and then times out. That loses the pot rather than risking the stake.
- **A relay can read betting and revealed shares.** Nothing a relay sees can decrypt a hidden card, but it does see the betting.

## Running it

```bash
npm run solana:build:channel
```

```bash
npm run channel:relay -- 8787
```

`scripts/channel.js` sets up a match: a `session` key for each player, an `offer` from the joiner, then `create` and `join`. Each player then runs `examples/channel-agent.js` with their session key, the manifest, the relay and one or more RPC URLs. `sweep` returns what's left in a session key, and `retire` reclaims the match's rent. Set `AGENT_STACKS_ALLOW_LOCAL=1` for a local validator.

`scripts/channel-rehearsal.js` plays real matches with real agent processes against a validator, and runs the attacks below.
