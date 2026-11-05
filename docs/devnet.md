# Local validator and devnet operation

Current status: v5 local RPC matches passed after the [security re-audit](security-audit-2026-11-04.md). The [protected agent](security-hardening.md) now requires an operator node policy, code pin and finalized checkpoints. Public deployment remains deferred. Arbitrary untrusted state RPCs are unsupported. No testnet SOL or real SOL is needed locally.

## Local validator

Install dependencies and build:

```sh
npm ci
npm run solana:build
```

The project CLI creates project-only payer/program keypairs if absent. Running `npm run devnet:status` only checks public state; it does not deploy or spend funds. The existing workspace has those keypairs already.

Start a validator in a separate terminal, with a fresh ledger name if replacing an earlier binary:

```sh
.tools/solana-release/bin/solana-test-validator \
  --ledger .agent-stacks/validator-audit-v5-final-20261104 \
  --rpc-port 18899 --faucet-port 18901 \
  --dynamic-port-range 19000-19050 --bind-address 127.0.0.1 \
  --ticks-per-slot 8 \
  --mint GKMH7tF11Hbd9T2nSp4eQaiXifn6jvf6Ky9KEMNbUTYw \
  --bpf-program .agent-stacks/devnet/program-keypair.json \
  target/deploy/agent_stacks_escrow.so --quiet
```

The retained v5 ledger contains the completed post-audit cooperative match. Both strict and joint acceptance are supported. Local test tokens are minted to the project payer at genesis; another workspace should substitute its payer address. Restarting a ledger preserves its loaded program; rebuilding does not upgrade it. Older v4 ledgers/manifests require their original code. Do not reset a ledger containing a hand you intend to resume.

In another terminal:

```sh
export AGENT_STACKS_RPC=http://127.0.0.1:18899
export AGENT_STACKS_ALLOW_LOCAL=1
.tools/solana-release/bin/solana airdrop 100 \
  --url "$AGENT_STACKS_RPC" \
  --keypair .agent-stacks/devnet/payer-keypair.json
npm run devnet:status
```

Create an owner-only policy for this node you started. Supply its expected genesis from your local node's status and the program public key; the script checks the deployed bytes against the artifact before writing the policy. The installed test-validator reports a non-null System Program authority even for its no-upgrade fixture, so the local command explicitly permits that test metadata. The default policy otherwise rejects retained authority.

```sh
node scripts/trust-policy.js --operator-controlled \
  --rpc http://127.0.0.1:18899 --genesis EXPECTED_LOCAL_GENESIS \
  --program HJeuy3rTLNDktmMFGREW8nHoqFCLkfD8dYX3HPmA4FhJ \
  --artifact target/deploy/agent_stacks_escrow.so \
  --out .agent-stacks/devnet/local-trust-policy.json \
  --allow-local --allow-upgradeable-test-program --test-controls --cooperative
export AGENT_STACKS_TRUST_POLICY=.agent-stacks/devnet/local-trust-policy.json
AGENT_STACKS_COOPERATIVE_SHUFFLE=1 npm run devnet:play
```

The policy creator refuses to overwrite an existing file. Inspect it before use. Add `--max-compute-unit-price MICROLAMPORTS` to allow bounded priority fees; they are off by default. It is an explicit trust assertion, not proof that a public RPC is honest. Its stake/hand/clock/budget ceilings are separate from the on-chain protocol limits. A changed policy cannot silently reuse a guard checkpoint; reconcile before migration. Leave the cooperative environment variable unset to use full on-chain proof verification. Proof upload and verification steps clear at `confirmed`; everything else waits for finality.

These are local test tokens. `play` creates a two-hand match and launches two isolated agents. The demo funds agent B with test tokens for its deposit, fees and temporary proof storage; B returns the borrowed storage funding after its proof closes. This demonstration uses wallets controlled by this workspace. It does not establish independent ownership.

## Public devnet, when funded

The [two-machine runbook](devnet-two-machines.md) has the full procedure, including what devnet looks like today and how to get test SOL. The SDK accepts the official devnet genesis hash and rejects other public clusters, including mainnet and testnet. Deployment/status can use a public devnet RPC; the protected agent must use a separately configured operator-controlled validating node, except in a test-funds timing run labelled with `--third-party-rpc`. Do not reuse a local policy against public devnet.

```sh
unset AGENT_STACKS_RPC AGENT_STACKS_ALLOW_LOCAL AGENT_STACKS_TRUST_POLICY
npm run devnet:status
npm run devnet:deploy
```

Before play, create and inspect a policy for your own devnet validating node with devnet genesis and the deployed artifact. Set `AGENT_STACKS_RPC` to that node and `AGENT_STACKS_TRUST_POLICY` to its policy. Allow upgradeable code only for this test deployment. A public endpoint is not a substitute for this trust boundary.

Only run deployment once the project payer has sufficient devnet test SOL. `status` prints its address and balance. Deployment checks program-storage funding and uses explicit project keypair, buffer and upgrade-authority paths; it does not use the default Solana wallet. The project payer would retain upgrade authority. A match additionally needs temporary proof storage funding, fees and deposits. Storage is about 4.54 SOL on a default local validator, reused between shuffles, or about 0.0246 SOL for the optional cooperative path. Rent differs by cluster and is changing: the same proof buffer cost 3.32 SOL on devnet on 2026-11-05. `status` prints a budget from the cluster's current rent. The separately created `user-wallet-keypair.json` is not automatically the deployment payer. `deploy` refuses to replace a program that's already deployed, because agents have pinned its bytes; use a new program keypair for a new version.

## Independent agents and recovery

Create an invitation naming the opponent's public address:

```sh
node scripts/devnet.js create OPPONENT_ADDRESS
```

The project payer holds the upgrade authority, so set `AGENT_STACKS_WALLET` to a separate key when the creator will run an agent. The same variable applies to `cancel`, `close` and `timeout`. A manifest leaves out any RPC URL that could hold an API key, and output shows such a URL without its path or query.

The on-chain protocol permits 1–1,000 hands and 30–259,200-second turns. The protected agent's default policy caps matches at two hands/1,000,000 lamports per player and refuses turns below one hour or above 24 hours (`--max-turn-seconds` raises the ceiling); the demo defaults to a 24-hour clock and 20,000-lamport big blind. Environment overrides must also satisfy that policy. Each agent must review the accepted manifest before joining. The agent refuses to join without funding for its deposit, the full-proof fallback and fees, then joins by itself once funded. The clock floor is not a measured public-network liveness guarantee.

Run each agent with its own Solana JSON keypair, private cache directory and a copy of the accepted manifest:

```sh
AGENT_STACKS_TRUST_POLICY=OPERATOR_POLICY node examples/chain-agent.js WALLET_KEYPAIR PRIVATE_DIRECTORY \
  --manifest MATCH_MANIFEST
```

Each hand uses a distinct private key/proof cache. Earlier v3/v4 accounts and manifests are incompatible with v5; start a new challenge. The strategy checks/calls. Agents require a trusted RPC; independent-host operation remains untested. Coordinator IPC is a trusted local control plane. Private directories must be owned by your user and mode 0700; private files must be 0600. The agent refuses unsafe files and concurrent wallet/state writers. After a hard crash, verify the recorded lock PID is dead and inspect pending transactions before removing a stale lock.

Resume that demo using its original manifest and original private caches:

```sh
npm run devnet:play -- --resume MATCH_MANIFEST
```

The agent verifies cached keys/proofs and resumes sequential uploads from chain progress. Keys, manifests, accepted state/release decisions and signed transaction journals are flushed to disk before use/broadcast. Completed matches do not pay twice; agents attempt outstanding claims. Unknown prepared transactions block signing until they resolve. The agent redelivers the original bytes and clears the record on a finalized receipt or once the blockhash has provably expired; a transaction rejected in simulation is never recorded. `scripts/reconcile-agent.js` inspects the same evidence manually. Demo funding/rent-return intents need separate reconciliation; a pending marker can represent a failure before sending. Inspect original signatures and chain state; do not delete markers or guard files to retry. See [recovery and encrypted backups](security-hardening.md). The standalone agent retries RPC failures by itself but exits on security failures, so run it under a supervisor that alerts you when it stops.

An award that cannot be delivered to its original wallet stays in escrow after completion. Tag 20 permits its owner to sign a withdrawal to another writable destination (with a funded fee payer). The recorded payout amount is an award; check `pendingPayouts` to distinguish retained claims from delivered funds. Retirement requires all claims cleared and retains eight bytes of rent-funded state to prevent replay through address reuse.

The creator can cancel an invitation nobody has joined, and retire a completed match with no outstanding claims. Closing returns the match's rent except the permanent tombstone. It is irreversible and `scripts/verify-chain-match.js` can no longer read a closed match, so generate any receipt first. The protected agent never does either by itself.

```sh
node scripts/devnet.js cancel MATCH_ADDRESS
node scripts/devnet.js close MATCH_ADDRESS
```

Anyone can submit a permissionless timeout claim after the chain deadline:

```sh
node scripts/devnet.js timeout MATCH_ADDRESS
```

Keep private keypairs, hand keys, shuffle witnesses, caches and journals private and backed up. They are owner-only and gitignored, but not encrypted. Do not delete them during a live hand. Keep an agent or monitor funded and online: deadlines do not submit transactions themselves. The whole-match timeout rule forfeits both deposits after joining.

Generate a read-only settlement receipt while the validator/RPC retains transaction history:

```sh
node scripts/verify-chain-match.js MATCH_MANIFEST
```

This checks accepted terms, terminal poker state, payout conservation, actual recipient balance changes in the settling transaction, any deferred awards, and the hand-transition logs written by the escrow program. Later transactions that merely name the match are ignored. It writes a public receipt to `.agent-stacks/reports/local-multihand.json`. Its artifact hash identifies the local build; it is not an independent proof of deployed program equivalence. For devnet, pass an output filename appropriate to that network.


## Optional lower-fee path

Set `AGENT_STACKS_COOPERATIVE_SHUFFLE=1` in the demo coordinator's environment to enable independent off-chain proof verification and joint deck acceptance in both child agents. Leave it unset for full on-chain verification. The optional path needs about 0.0246 SOL of temporary deck storage rather than 4.54 SOL for the full proof; retain enough fallback funding if refusal must be handled automatically. The demo funds B for the full verifier when it falls back. The caller must similarly keep A funded.

See the [acceptance model, measured fees and fallback tests](optimization.md). This is an opt-in joint-authorization model; the chain does not verify shuffle mathematics on its fast path. The standalone agent still uses unilateral verification. RPC availability, private state and independent verification remain trust boundaries.
