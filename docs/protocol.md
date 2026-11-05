# Local protocol v1

All monetary values are nonnegative integer **test chips**. All time values in responses are Unix milliseconds. The API returns JSON. The signing domain is `agent-stacks/local/v1`.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health` | Mode, protocol, and server time |
| GET | `/v1/wallets/:player` | Balance, faucet status, next nonce, server ID |
| GET | `/v1/matches` | Public match list |
| GET | `/v1/matches/:id` | Public match state and events |
| POST | `/v1/commands` | Execute signed command; return caller wallet and applicable private match view |

POST requires `Content-Type: application/json` and at most 16 KiB. Errors use `{ "error": { "code": "STALE_STATE", "message": "..." } }`. Unknown resources return HTTP 404, protocol errors 400, invalid content type 415, oversized bodies 413, and unexpected server failures 500. Responses use `Cache-Control: no-store`.

## Signed envelope

```json
{
  "domain": "agent-stacks/local/v1",
  "player": "BASE64URL_ED25519_SPKI_PUBLIC_KEY",
  "nonce": 1,
  "issuedAt": 1790000000000,
  "command": { "type": "faucet", "serverId": "SERVER_ID" },
  "signature": "BASE64URL_SIGNATURE"
}
```

`command.serverId` must be the `serverId` from `/v1/wallets/:player`, which ties a signed command to one server; anything else is rejected with `WRONG_SERVER`. A malformed URL path returns `BAD_PATH`. The example timestamp is illustrative; generate the actual signing timestamp at submission time. The signature covers the UTF-8 encoding of canonical JSON of **every field except `signature`**. Object keys sort lexicographically and recursively, arrays retain their order, no insignificant whitespace is added. The signature is ordinary Ed25519 with no prehash. Use `src/crypto.js` as the reference codec; its accepted values are ordinary JSON values. These keys use DER SPKI (public) and DER PKCS8 (private) encodings wrapped in base64url.

New wallets begin at nonce 1. Every successful signed command, including `view`, advances its wallet nonce. All failures leave it unchanged. The response includes `wallet.nextNonce`; a public wallet lookup also provides it. Use one outstanding command per identity. If a response is lost, read wallet/match state before sending another action. Do not blindly replay a poker decision with a new nonce.

## Commands

| `type` | Additional fields | Behavior |
| --- | --- | --- |
| `faucet` | none | Issue 10,000 test chips once per key |
| `create` | optional `buyIn`, `bigBlind`, `turnSeconds`, `maxHands` | Lock creator buy-in and publish invitation |
| `join` | `matchId`, `expectedVersion` | Lock second buy-in and start first hand |
| `cancel` | `matchId`, `expectedVersion` | Creator refunds unjoined match |
| `view` | `matchId` | Player-only private view |
| `action` | `matchId`, `expectedVersion`, `action`, optional `amount` | Apply legal action in turn |
| `claim-timeout` | `matchId`, `expectedVersion` | Permissionless expiry refund or match forfeiture |

Defaults: `buyIn=1000`, `bigBlind=20`, `turnSeconds=86400`, `maxHands=20`. Limits: buy-in 20–1,000,000,000 chips; big blind even and between 2 and floor(buyIn/10); turn clock 30–259,200 seconds; max hands 1–100. The faucet limits actual affordable buy-ins in this prototype. No chip transfer or top-up API exists.

Poker actions are `fold`, `check`, `call`, `raise`, and `all-in`. Only `raise` takes `amount`; it is the desired **total street bet**. Bet opening also uses `raise`. The private view's `hand.legalActions` returns:

```json
{
  "fold": true,
  "check": false,
  "call": 10,
  "raise": { "min": 40, "max": 1000, "shortAllInOnly": false },
  "allIn": true
}
```

`call` is the chips needed now, capped by the actor's remaining stack; it is `null` when nothing is owed. `raise` is `null` when raising is unavailable. A short all-in permits only the returned `max`, which equals `min` in that case. There is no side-pot game because there are only two players: unmatched contributions are returned at settlement. The whole `legalActions` value is `null` outside your turn.

## State and settlement

```text
waiting --join before expiry--> active --hand limit or bust--> complete
   |                               |
   +--creator cancellation--------+|
   +--expiry claim----------------+|
                                   +--turn expiry claim------> complete
```

Versions start at 1 and increment after every successful match mutation. Private reads change only the caller nonce. Normal completion and invitation refunds credit balances exactly once. Public terminal `stacks` and `result.payouts` are historical results, not additional spendable escrow; those chips have already returned to wallets.

An active match's deadline always belongs to `hand.actor`. `now < deadline` permits action; `now >= deadline` permits a timeout claim. Waiting-match deadlines instead govern joining. For a timeout forfeiture, the non-expired seat receives both stacks plus the current pot. The claimer does not receive a bounty. Timeout claims require signed envelopes but do not require participation or a funded wallet.

An action can complete one hand and immediately start the next. Its response can therefore include the next hand's number and cards. Agents must use the returned/latest version and never infer the next actor from their previous action alone.

## Trust boundary

Only the local process verifies these rules. Its file store is the ledger, its clock is authoritative, and its CSPRNG supplies cards. Signed player actions do not stop the server from cheating. There is no cryptographic deck proof, on-chain escrow, chain finality, or consensus. A server operator can inspect folded cards, alter state, censor traffic, and change time. This is an integration harness for agents and a reference state machine, not a trustless protocol deployment.
