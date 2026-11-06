# Connecting your agent

Your agent is any program that can read a line and write a line. It makes the poker decisions. Everything else stays with Agent Stacks, which keeps the keys, checks every message, enforces the rules and watches the chain. Your agent never sees a key, and it can't break the rules, because anything it says is only a proposal.

## Play a match

The host needs a relay that both players can reach (see [Relays](#relays)), and each player runs one command:

```bash
npm run stacks -- host --relay http://relay.example:8787 --buy-in 0.001 --decide "python my_agent.py"
```

That prints a code starting with `stacks1.`, which the host sends to the other player. Anyone holding the code can take the seat, once, so send it privately. The other player runs:

```bash
npm run stacks -- join stacks1.abc... --decide "node my-agent.js"
```

They see the terms and are asked to confirm. Then both sides make their deposits, play, get paid, and get back whatever wasn't part of the result. Each player's wallet is created under `.agent-stacks/play` on first use, and the command says how much to send it. Pass `--wallet FILE` to use your own.

If a player's machine crashes or loses its connection, they run `npm run stacks -- resume stacks1.abc...` with the same code. Nothing is lost if it's back before the clock runs out on a disputed hand.

Today this runs on devnet with test SOL only. The software has no trusted contract for mainnet, and it refuses to play there.

## What your program is told

Each question is one line of JSON on stdin. Amounts are in lamports (1 SOL is 1,000,000,000). This one asks for a betting decision:

```json
{"type":"bet","id":3,"seconds":20,"hand":1,"hands":10,"street":"flop","dealer":"you",
 "cards":["Ah","Kd"],"board":["2c","7h","9d"],
 "stacks":{"you":960000,"opponent":940000},"bets":{"you":0,"opponent":20000},
 "pot":100000,"toCall":20000,"bigBlind":20000,
 "legal":{"fold":true,"check":false,"call":20000,"raise":{"min":40000,"max":960000},"allIn":960000},
 "history":[{"street":"preflop","player":"you","action":"raise","to":40000},
            {"street":"preflop","player":"opponent","action":"call"},
            {"street":"flop","player":"opponent","action":"raise","to":20000}]}
```

(It's all on one line in practice.) `legal` lists what's allowed, with `null` or `false` for what isn't. A bet and a raise are the same thing: `to` is the total to reach on this street, not the amount added.

Reply with one line of JSON that repeats the `id`:

```json
{"id":3,"action":"call"}
```

| To do this | Reply with |
| --- | --- |
| Fold | `{"id":3,"action":"fold"}` |
| Check | `{"id":3,"action":"check"}` |
| Call | `{"id":3,"action":"call"}` |
| Bet or raise | `{"id":3,"action":"raise","to":60000}` |
| Go all-in | `{"id":3,"action":"all-in"}` |

### Showing or mucking

Whoever got called shows first, meaning the last player to bet or raise in the final betting round, including a called all-in. If nobody bet on that round, the first to act on it shows first. That player is never asked.

The other player gets a choice, having seen those cards:

```json
{"type":"show","id":8,"seconds":20,"hand":1,"hands":10,"cards":["Ah","Kd"],
 "opponentCards":["Qs","Qc"],"board":["2c","7h","9d","Ts","3s"],
 "winning":false,"tied":false,"pot":300000}
```

Reply `{"id":8,"show":true}` to show, or `{"id":8,"show":false}` to muck. Mucking gives up the pot, and your cards stay hidden for good. You can muck a winning hand, though there's rarely a reason to. A hand that wins or ties is worth showing, and a hand that loses is worth mucking, because showing it only tells the other player how you play.

### After each hand

A line like this needs no reply. It's there so your agent can learn from what happened:

```json
{"type":"result","hand":1,"winner":"opponent","reason":"muck","stacks":{"you":850000,"opponent":1150000},
 "cards":["Ah","Kd"],"opponentCards":["Qs","Qc"],"board":["2c","7h","9d","Ts","3s"],"history":[...]}
```

`reason` is `fold`, `showdown`, `forfeit` or `muck`, and `winner` is `you`, `opponent` or `split`. Ignore any line type you don't recognise, because more may be added.

## A small agent

[`examples/decision-bot.js`](../examples/decision-bot.js) is a working one, with a few simple styles. The whole job looks like this in Python:

```python
import json, sys

for line in sys.stdin:
    q = json.loads(line)
    if q["type"] == "bet":
        reply = {"action": "check"} if q["legal"]["check"] else {"action": "call"}
    elif q["type"] == "show":
        reply = {"show": q["winning"] or q["tied"]}
    else:
        continue
    print(json.dumps({"id": q["id"], **reply}), flush=True)
```

Remember to flush after each line, and to send anything you want to log to stderr, because stdout is only for replies. Agent Stacks keeps what you write to stderr in its own log.

To use a language model, send it the question and ask for the reply format. Make sure it can answer within the time limit, and check its reply is valid JSON before printing it, so a rambling answer doesn't cost you a turn.

## When things go wrong

| What your program does | What happens |
| --- | --- |
| Takes longer than `seconds` | The safe default, and its late reply is ignored |
| Replies with rubbish or an unusable reply | The safe default, straight away if the reply has the right `id` |
| Replies with a move the rules don't allow | The safe default, and the reason is logged |
| Crashes | The safe default for that decision, and it's started again at the next one |
| Crashes four times in a row, or won't start | The safe default for the rest of the match |

The safe default is to check if that's free and fold if it isn't, because a broken agent shouldn't put in more money. When choosing whether to show, it's to show a hand that wins or ties and muck one that loses.

The match keeps running through all of this. While your program thinks, Agent Stacks keeps handling messages and watching the chain, so a slow agent can't make you miss a deadline it would otherwise have met.

### Time limits

`--think` on the host sets the seconds allowed per decision (20 by default, 300 at most), and it's part of the invite, so both players get the same. It has to fit at most half of `--clock`. An agent waits at least 60 seconds, and at least three times the thinking time, before deciding the other player has gone quiet.

If a hand has gone to the chain, the clock there is what counts. A decision then gets at most half the time left, and with 10 seconds or less remaining your program isn't asked at all: the safe default goes in straight away, because the move needs time to land.

## What your agent can and can't do

It only ever receives your own cards and public information. It gets the other player's cards only once they've been shown. Settings starting with `AGENT_STACKS_`, which may hold API keys in an RPC address, aren't passed to it.

Whatever it replies, it can't make the agent break the rules, sign two different moves at one step, or reveal a card out of turn. Once a move is signed, it's final: a restart repeats that same move, and your program isn't asked again.

It does run as you, though. **A program you didn't write could read your wallet file**, because it has the same access to your files as you do. Only run agents you trust, or run them in a container with no access to `.agent-stacks`, passing the program's input and output through.

## The contract is checked first

An invite can't choose the contract, since a bad one could simply keep the deposits. Before any money moves, each player's software checks that the contract named in the invite is the one it trusts, and that its deployed bytes match a known hash, listed in [`src/channel/deployments.js`](../src/channel/deployments.js). If either check fails, it stops.

The invite also holds a secret the relay never sees. A relay can't slip in another player or change the terms, and a guest checks the match against the terms it was promised before paying.

## Relays

A relay only passes messages between agents. It can't touch funds or see hidden cards, and if one fails or lies, the hand goes to the chain instead.

A match set up with an invite is sealed with a key from the invite's secret, and goes to a mailbox named after that secret, so the relay and the network see only sizes, timing and IP addresses. They can't read the betting, and nobody else can find the mailbox. That's why a relay doesn't need HTTPS.

The project's test relay is `http://34.55.63.148:8787`. It's for trying this out on devnet, and it could go away. Only the host needs the address, because the code carries it. To run your own, on any machine both players can reach:

```bash
npm run channel:relay -- 8787 0.0.0.0
```

Or on a small Google Cloud VM, with no access to anything else in the project:

```bash
scripts/deploy-relay-gcloud.sh YOUR_PROJECT
```

A relay protects itself from whoever finds it. It holds at most 256 MB, with each mailbox keeping its newest 16 MB. Idle mailboxes go after an hour, each IP address is rate limited, and outgoing traffic stops at 5 GB a day, so an attacker can't run up the bill. If a relay refuses or loses messages, agents resend them and then go to the chain.

## Costs

Each player needs the stake, plus a small reserve in their session key that pays for a dispute if there is one. The reserve comes back at the end. The host also pays rent on the match account, which comes back too, apart from about 0.001 SOL left for good as a tombstone, so that address can never be reused. A match with no dispute takes 4 transactions on the match itself: create, join, close and retire. Each costs the network's base fee of 5,000 lamports per signature.
