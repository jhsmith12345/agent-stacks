# Security re-audit — November 4, 2026

**Follow-up:** this report preserves the original audit snapshot. The later [channel design](channel-design.md) removes AS-03 from normal play, because agents no longer learn what to reveal from an RPC. It hasn't been independently reviewed. Subsequent [protected-agent remediation](security-hardening.md) adds an explicit trusted-node backend, durable share gate, code pins, budgets and recovery. AS-03 is contained for untrusted submission relays under that backend's assumptions; arbitrary untrusted state RPCs and compromised configured nodes remain unsupported. See the [external-review brief](external-audit-brief.md) and updated [test evidence](testing.md).

**Verdict: continue isolated testing; do not use real stakes.** This internal review found and fixed three high-severity escrow/account-lifecycle defects and several client/recovery defects. A hidden-card attack through a dishonest RPC was reproduced against the actual agent and remains open. The custom cryptographic composition and production operational model still require independent review.

This is a source and adversarial-test review, not an independent audit, formal verification, deployed-service penetration test, or guarantee that every vulnerability has been found. No public deployment or real-money transaction was performed. Severity describes potential impact if the prototype were used with real stakes.

## Scope

Reviewed all first-party production sources under `programs/escrow/src`, `src`, `examples`, and `scripts`, plus dependency manifests, tests, deployment/recovery instructions and private-file permissions. The fixed card constants were checked against JavaScript encodings. The trusted-dealer HTTP demo, signed local peer protocol, full on-chain verifier and optional cooperative path were assessed separately.

Assets: escrow principal, payout entitlements, hole-card privacy, unpredictable deals, signing/hand keys, accepted terms, availability before deadlines, and fee/rent funding. Threats considered: malicious players, forged/replayed messages, account substitution, hostile RPC/relay responses, crashes, concurrent writers, damaged state, strategy output, dependencies and upgrades. A compromised OS or signing process defeats the prototype; permissions are not a sandbox against the same user/root.

Pre-change source hashes: `.agent-stacks/reports/security-audit-baseline-20261104.json`. Post-review hashes/results: `.agent-stacks/reports/security-audit-20261104.json`. These contain public-source metadata, not private keys.

## Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| AS-01 | High | Closed match addresses could be recreated, reusing contexts and agent caches | Fixed in v5 |
| AS-02 | High | An emptied recipient wallet could block terminal settlement through rent checks | Fixed in v5 |
| AS-03 | High | Dishonest RPC obtains a hidden-card share before transaction rejection | **Open; reproduced against the agent** |
| AS-04 | Medium | An uncertain rent return/funding transfer could be repeated after restart | Duplicate automatic payments blocked; manual recovery remains |
| AS-05 | Medium | Private caches/journals lacked durable publication and agent writer exclusion | Hardened; hardware failure/key compromise remain |
| AS-06 | Medium | Manifest genesis/program/address were not directly compared with the SDK selection | Fixed |
| AS-07 | Medium, local API | Caller-owned objects could mutate accepted state after verification | Fixed at API boundaries |
| AS-08 | Low, local protocol | Alternate DER/base64 encodings gave one key multiple identities | Fixed |
| AS-09 | Medium, operations | Local clock skew could trigger premature timeout attempts and stop the agent | Scheduling now reads the chain Clock |
| AS-10 | High, split initialization | Anyone could claim a funded but uninitialized proof buffer and reclaim its rent | Fixed; buffer signature required |

### AS-01: match-address reuse

Tag 7 previously returned all lamports, removed account data and reassigned the PDA to the System Program. A creator could recreate a match using the same nonce, terms and players. Contexts and cache names both used match address plus hand number. Restarting the honest counterparty with those caches could reuse its hand key and shuffle; the creator could repeat its own material too. A previously revealed deck would then be known before betting. This requires the honest agent to accept/restart that recreated match; it does not forge a signature.

The pre-fix SBF regression demonstrated that close followed by identical creation succeeded. V5 retains a rent-exempt, program-owned eight-byte `ASTKEND5` tombstone, permanently preventing address reuse. Other residual funds return to the creator only after all payout claims are cleared. The tested retained rent is 946,560 lamports per match, not per hand or a transaction fee. The minimal tombstone has no withdrawal operation; do not send it donations.

Evidence: `closed_match_address_cannot_be_recreated_with_replayable_hand_contexts` and retirement assertions in `programs/escrow/tests/svm.rs`.

### AS-02: payout destination denial of service

A player can empty its wallet using another fee payer. A positive payout below the rent-exempt minimum then attempts to recreate a rent-paying account. Solana rejects the entire transaction, including the legitimate poker transition. In a final-reveal phase this could prevent the obligated player from finishing and expose it to timeout forfeiture unless it separately topped up the recipient. The pre-fix test produced `InsufficientFundsForRent`, exercising the shared payout logic through joint settlement.

V5 completes settlement and pays deliverable awards normally. Undeliverable amounts remain in escrow for their entitled owners. At phase 6, byte 4251 is a two-bit pending-payout mask. New tag 20 requires the entitled player's signature, current version and writable destination. A successful withdrawal clears that bit; failure preserves it. Retirement is blocked while any claim remains. Historical award amounts are retained.

Tests cover terminal completion, retained funds, unauthorized claims, premature close, failed credit, redirected credit and duplicate-claim rejection. A pending claimant may need fee funding or a sponsored transaction. Its claim does not block the opponent's deliverable payout.

### AS-03: RPC is still a decryption-oracle boundary

`ChainClient.match()` checks layout, owner, PDA and terms, but gets all of those values from the same RPC. It neither authenticates consensus nor reconstructs independently validated history. The agent uses the returned phase, cursor and ciphertext to compute shares.

`test/rpc-trust.test.js` runs the actual agent against a fake local RPC. Matching identities, terms and PDA pass validation, but the RPC substitutes the honest player's hidden ciphertext into an allowed opponent-card slot. The agent submits a share for it. The RPC captures that transaction and rejects it; a colluding opponent combines the captured share with its own to recover the hidden card. **No successful on-chain transaction is necessary.** Context binding prevents proof replay in another context, but the raw share point `x*A` still decrypts that ciphertext.

Refusing remote plaintext RPC and checking actual genesis/program/address harden transport/configuration, **not AS-03**. HTTPS servers can lie. A genesis response is not a chain attestation. Both settlement modes require a trusted RPC/validator today. Adding a second RPC without a defined verification policy is not a complete remedy.

Release work: authenticate the accepted deck and every share-release obligation before computing a share; bind them to durable monotonic state and independently validated history; test equivocation, forks and restarts. Until then, use an operator-controlled trusted validator for testing. The test labeled `OPEN` deliberately passes when it reproduces this unresolved vulnerability.

### AS-04/05: local custody and recovery

Rent-return markers were written after confirmation. A crash after payment but before the marker could trigger another payment. Balance-based funding had a similar restart risk. `transferOnce` now durably records intent before sending and confirmation afterward. A pending/uncertain intent blocks another payment pending inspection of the original journal. A pending marker does not prove a transaction was sent; this favors avoiding duplicate payment over automatic recovery.

`src/private-files.js` adds owner-only files/directories, atomic exclusive creation/replacement, file and directory fsync, and rejection of symlinks, hard links and non-regular files. Keys/proofs are persisted before use. Cached keys are checked against their secret, registration and context; cached shuffle proofs are verified before upload. Concurrent wallet creation converges on one identity. Agents lock the wallet and state directory and serialize IPC requests. Hard crashes leave a lock requiring inspection rather than unsafe automatic removal.

Transaction journals flush before broadcast, and asynchronous journal callbacks are now awaited. Creation manifests precede transactions. The local HTTP engine freezes writes after persistence failure: a failed directory sync can leave disk newer than memory. Its health endpoint reports the fault.

All 54 existing private key/cache/journal files checked had no group/other read bits. The devnet directory was 0755 beneath an already 0700 ancestor; it is now 0700 too. No private key bytes were printed or included here. Files remain plaintext. Disk theft, backups, same-user code execution, memory/side channels, and secure destruction of retained old hand keys remain operational risks.

### AS-06–09: signing and state boundaries

The SDK now compares accepted genesis, program and match address with the actual client selection, as well as stored terms/stakes. Public non-devnet clusters remain refused based on the trusted RPC response; HTTP is restricted to explicitly enabled loopback validators.

Local envelopes are snapshotted before retention; constructor player arrays are copied; returned views are detached. Mutating previously supplied/returned objects no longer changes accepted keys or balances. Direct access to exposed JavaScript object internals remains trusted: this is API isolation, not a plugin sandbox.

Local Ed25519 keys/signatures require exact canonical encodings. One key cannot use trailing DER or alternate base64 spellings to bypass distinct-key checks. This does not prove different operators or prevent Sybils.

Strategies may propose only an action and amount; they cannot replace signing context or cryptographic fields. No production LLM strategy or model-tool sandbox exists. Standalone timeout scheduling now reads the chain Clock, avoiding local-clock skew; on-chain Clock checks remain authoritative.

### AS-10: uninitialized buffer takeover

If allocation and initialization were separate transactions, tag 8 allowed any signing authority to initialize someone else's program-owned proof account. That authority could then close it and take its roughly 4.54 SOL refundable storage balance. The pre-fix SBF test demonstrated unauthorized initialization. The compact initializer had an analogous boundary: an actor could bind an unsigned buffer to its own eligible match. The shipped SDK already created and initialized atomically, so that normal path had no intervening transaction window.

Both initializers now require the buffer account's own signature in addition to the authority/actor. The SDK declares that signer explicitly and continues to combine creation/initialization. Tests reject unsigned initialization, permit the legitimate key holder and retain all upload/verification/closure checks. No extra signature fee is added to normal creation, since the System Program already required the same new-account signature.

## Coverage matrix

| Area | Reviewed and tested | Limits |
| --- | --- | --- |
| Custody/authorization | Tags 0–20; owner/size/magic/PDA; named signers/destinations; versions; authority-only closure; arithmetic bounds; rent; deferred claims; retirement | Upgrade authority can replace rules; no deployed-bytecode attestation or old-layout migration |
| Atomicity | Invalid proofs, wrong accounts, stale versions, malformed dispatch and duplicate claims leave escrow unchanged | Failed transactions still cost fees; censorship prevents progress |
| Crypto primitives | Canonical points/scalars; nonidentity keys/bases; possession and cancellation checks; cross-language vectors; domain/hand/phase/position binding | No independent composition proof or physical side-channel review |
| Full shuffle | Fixed 52 cards/128 rounds; bijections; challenge binding; immutable sealed data; contiguous verification; consumer checks input/key/context/authority | Cut-and-choose intuition is not a formal argument for the entire adaptive protocol |
| Cooperative shuffle | Client verifies full proof; exact transaction reconstructed; two signatures; hash/buffer/context/version binding; unilateral fallback | Chain does not verify shuffle mathematics or retain the full proof; authentic state and an honest correct signer are essential |
| Card privacy | Required share slots; private owner shares before showdown; burns unrevealed; per-hand reset; replay rejection | AS-03; retained private keys can expose old cards after later compromise |
| Poker | All five-card categories; 10,000 seven-card oracle comparisons; 400 cross-language rankings; 120 betting traces; blinds, raises, short all-ins, refunds, ties, carryover/bust | Not formal verification of every reachable betting state |
| Deadlines/economics | Exact deadline boundary; correct obligated seat; whole-match forfeiture; uploads/offers cannot reset deadline; fallback without peer signature | Requires funded submitter, sufficient time and available chain/RPC; no automatic chain scheduler |
| Local demos | Signed commands/domains/nonces; request-size limit; privacy views; rollback/persistence; authenticated peer transcript replay | Loopback test services; no public-service Sybil/rate/storage quota defense; timestamps are locally recorded |
| Dependencies/build | Direct version pins, lockfiles, locked SBF build, advisory and registry-signature scans, first-party scripts | No line-by-line transitive dependency/toolchain audit or independent reproducible build |

Parsing was checked against [RFC 9496](https://www.rfc-editor.org/rfc/rfc9496.html). The payout problem/remedy was checked against the runtime and Solana's [account modification and rent-transition rules](https://solana.com/docs/core/accounts/modification-rules). These sources describe primitives/runtime behavior, not an endorsement of Agent Stacks.

## Release blockers and design risks

1. **Independent cryptographic analysis:** exact threshold ElGamal, knowledge proofs, parallel cut-and-choose Fiat–Shamir, adaptive ciphertext attacks, witness leakage, grinding, key reuse and abort behavior. A valid shuffle proof does not prove fair malicious randomness; unpredictability needs an honest random shuffle. No rounds were reduced or whole-protocol 128-bit guarantee established.
2. **Authenticated share release:** resolve AS-03 before relying on an untrusted RPC. Include confirmed-versus-finalized behavior, rollback, omission and replay.
3. **Upgrade authority:** deployment would retain the project payer as authority, which could replace custody/privacy rules. An operator-free real-stake design requires a reviewed immutability/governance policy and deployed-code verification.
4. **Liveness and griefing:** full verification needs hundreds of transactions and roughly 4.54 SOL temporary rent. A 30-second allowed clock is not evidence public-network fallback can finish. Refusal forces full-path costs. Whole-match penalties cannot eliminate censorship, external incentives or selective abort.
5. **Remote control/strategy isolation:** IPC initialization and rent-return commands are trusted demo controls, not an adversarial network protocol. Remote authentication, replay protection, queue/proof quotas, host isolation and independent-host testing remain work.
6. **Secrets and operations:** encrypted recovery/backups, signer isolation/spending limits, old-key retention/destruction, monitoring, fee reserves, incident response, reorg recovery and repeated crash injection. Journals aid recovery; they are not an exactly-once payment service.
7. **Invitation griefing:** prefunding an unused PDA prevents creation at that nonce. A fresh nonce recovers. This remains setup denial of service, not authority to withdraw an existing escrow.

## Validation evidence

All three SBF defect regressions failed before their respective fixes and passed afterward. The final suite comprises 53 JavaScript tests and 19 Rust tests (five host, fourteen actual SBF). The intentionally passing tests for the **open RPC exploit are not remediation evidence**. Malformed dispatch covers 168 short known-tag payloads and all 235 unknown tags. Rust formatting and Clippy with warnings denied pass.

The evaluator exhaustively classifies all 2,598,960 five-card combinations against independent combinatorial category counts, and compares 10,000 seven-card hands with a direct histogram oracle separate from its best-five enumeration. Other tests cover crypto tampering, authorization, timeouts, private state, ambiguous transfers and concurrency.

Dependency results on November 4:

- `npm audit`: zero known vulnerabilities across 57 packages.
- `npm audit signatures`: all 57 registry signatures and 54 attestations verified. No install scripts or non-registry resolved URLs in the lockfile.
- `cargo-audit 0.22.2`: zero known vulnerabilities across 362 locked dependencies; database revision `965bf9ad083b58e6340d65829d85217b18be9290`. Five unmaintained notices remain: `ansi_term 0.12.1`, `bincode 1.3.3`, `derivative 2.2.0`, `libsecp256k1 0.7.2`, `paste 1.0.15`. `bincode` is in the normal Solana dependency graph; the other four are in the test/runtime graph. These were not suppressed. See [RustSec's audit documentation](https://github.com/rustsec/rustsec/blob/main/cargo-audit/README.md).

These checks detect known advisory/metadata issues, not unknown vulnerabilities or malicious code hidden in signed packages.

A fresh Agave 4.4.0 local validator completed two cooperative hands using separate agent processes:

| Field | Result |
| --- | --- |
| Genesis | `GqtGDjjEVSNMFqQpz2SG45tGXnqaWVJS8Xre5VC321qS` |
| Match | `DnATespuRXCbFqtD5KXrhvef8m5P4ak1nZTmz5t6pf1X` |
| Final state | Hand 2, version 62, no pending payouts |
| Awards | A 1,020,000; B 980,000 lamports |
| Protocol cost | 86 transactions / 470,000 lamports including setup; 42 / 230,000 per hand excluding setup |
| Final transaction | One signer; 97,605 CU; 5,000-lamport fee |
| SBF SHA-256 | `9232974b753314d5e7dbcde07a29b82596326cd1b2afedd1b12217f1542c376a` |

Resuming completion did not pay again. The strict verifier, two-hand play, phase timeouts and unilateral fallback also passed in SBF. No v5 public-network run occurred. The artifact hash is not independent deployed-code attestation. Costs exclude funding, priority fees, deployment, failed transactions and retained account/tombstone rent.

## Compatibility and next milestone

V5 uses magic `ASTKESC5` and terms domain `agent-stacks/escrow/v5`. Earlier terminal cursor bytes must not be interpreted as unpaid claims. Use fresh matches and a fresh validator ledger, or a separately reviewed migration. Rebuilding does not upgrade a retained validator's program. The retained v5 ledger is `.agent-stacks/validator-audit-v5-final-20261104`.

Next: design and adversarially validate authenticated share release, then obtain external cryptographic and Solana custody audits of the complete revised protocol. Lower fees do not remove these prerequisites.
