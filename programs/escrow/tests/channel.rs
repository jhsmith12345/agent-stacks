//! The channel court in the real SBF VM, against a hand the JavaScript engine played with real
//! keys, shuffles and proofs. Each attack in docs/channel-design.md has a test here.
use agent_stacks_escrow::{channel, play};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use serde_json::Value;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{path::PathBuf, process::Command, sync::OnceLock};

type TxResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;
type KeyAndMessage = ([u8; 32], [u8; 32]);
/// Public key, signature, message.
type Entry = (Vec<u8>, Vec<u8>, Vec<u8>);
/// Name, buy-in, blind, clock, opponent's session key, genesis.
type Terms = (&'static str, u64, u64, u32, [u8; 32], [u8; 32]);
const BUY_IN: u64 = 1_000_000;
const BIG_BLIND: u64 = 20_000;
const SECONDS: i64 = 3600;
const GENESIS: [u8; 32] = [42; 32];
const NONCE: [u8; 32] = [7; 32];
const PROGRAM: Address = Address::new_from_array([9; 32]);
const ED25519: Address = Address::new_from_array([
    0x03, 0x7d, 0x46, 0xd6, 0x7c, 0x93, 0xfb, 0xbe, 0x12, 0xf9, 0x42, 0x8f, 0x83, 0x8d, 0x40, 0xff,
    0x05, 0x70, 0x74, 0x49, 0x27, 0xf4, 0x8a, 0x64, 0xfc, 0xca, 0x70, 0x44, 0x80, 0x00, 0x00, 0x00,
]);
const INSTRUCTIONS: Address = Address::new_from_array([
    6, 167, 213, 23, 24, 123, 209, 102, 53, 218, 212, 4, 85, 253, 194, 192, 193, 36, 198, 143, 33,
    86, 117, 165, 219, 186, 203, 95, 8, 0, 0, 0,
]);
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn wallet_a() -> Keypair {
    Keypair::new_from_array([1; 32])
}
fn wallet_b() -> Keypair {
    Keypair::new_from_array([2; 32])
}
fn vault() -> Address {
    Address::find_program_address(
        &[b"channel", wallet_a().pubkey().as_ref(), &NONCE],
        &PROGRAM,
    )
    .0
}
// One hand of real proofs takes seconds to generate, and every test can share it.
fn vectors() -> &'static Value {
    static V: OnceLock<Value> = OnceLock::new();
    V.get_or_init(|| {
        let output = Command::new("node")
            .current_dir(root())
            .args([
                "scripts/channel-vectors.js",
                &PROGRAM.to_string(),
                &wallet_a().pubkey().to_string(),
                &wallet_b().pubkey().to_string(),
                &Address::new_from_array(GENESIS).to_string(),
                &hex::encode(NONCE),
                &BUY_IN.to_string(),
                &BIG_BLIND.to_string(),
                &SECONDS.to_string(),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    })
}
fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap()).unwrap()
}
fn terms() -> Vec<u8> {
    bytes(&vectors()["terms"])
}
fn session_key(seat: usize) -> Vec<u8> {
    bytes(&vectors()["sessions"][seat])
}
fn mover(seat: usize) -> Keypair {
    if seat == 0 {
        wallet_a()
    } else {
        wallet_b()
    }
}
fn int(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}
/// entries: (public key, signature, message). All offsets point inside this instruction.
fn ed25519(entries: &[Entry]) -> Instruction {
    let mut data = vec![entries.len() as u8, 0];
    let start = 2 + entries.len() * 14;
    let mut body: Vec<u8> = Vec::new();
    for (key, signature, message) in entries {
        let key_at = start + body.len();
        let signature_at = key_at + 32;
        let message_at = signature_at + 64;
        for field in [
            signature_at,
            0xffff,
            key_at,
            0xffff,
            message_at,
            message.len(),
            0xffff,
        ] {
            data.extend((field as u16).to_le_bytes());
        }
        body.extend(key);
        body.extend(signature);
        body.extend(message);
    }
    data.extend(body);
    Instruction {
        program_id: ED25519,
        accounts: vec![],
        data,
    }
}
fn both_signed(state: &Value) -> Instruction {
    ed25519(&[
        (
            session_key(0),
            bytes(&state["signatures"][0]),
            bytes(&state["message"]),
        ),
        (
            session_key(1),
            bytes(&state["signatures"][1]),
            bytes(&state["message"]),
        ),
    ])
}
struct H {
    svm: LiteSVM,
    a: Keypair,
    b: Keypair,
    stranger: Keypair,
    vault: Address,
    buffers: Vec<(Address, [u8; 32])>,
}
impl H {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        // Also run against the channel-only build, by pointing this at its artifact.
        let path = std::env::var("AGENT_STACKS_PROGRAM_SO")
            .map(PathBuf::from)
            .unwrap_or_else(|_| root().join("target/deploy/agent_stacks_escrow.so"));
        assert!(path.exists(), "Build SBF first: npm run solana:build");
        svm.add_program_from_file(PROGRAM, path).unwrap();
        let (a, b, stranger) = (wallet_a(), wallet_b(), Keypair::new());
        for key in [&a, &b, &stranger] {
            svm.airdrop(&key.pubkey(), 1_000_000_000).unwrap();
        }
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = 1_000_000;
        svm.set_sysvar(&clock);
        let mut h = Self {
            svm,
            a,
            b,
            stranger,
            vault: vault(),
            buffers: vec![],
        };
        let mut data = vec![30];
        data.extend(NONCE);
        data.extend(BUY_IN.to_le_bytes());
        data.extend((SECONDS as u32).to_le_bytes());
        data.extend(GENESIS);
        data.extend(BIG_BLIND.to_le_bytes());
        data.extend(1u32.to_le_bytes());
        data.extend(session_key(0));
        data.extend(session_key(1));
        let ix = Instruction {
            program_id: PROGRAM,
            accounts: vec![
                AccountMeta::new(h.a.pubkey(), true),
                AccountMeta::new_readonly(h.b.pubkey(), false),
                AccountMeta::new(h.vault, false),
                AccountMeta::new_readonly(Address::default(), false),
            ],
            data,
        };
        h.send(&[&wallet_a()], vec![ix]).unwrap();
        h
    }
    fn joined() -> Self {
        let mut h = Self::new();
        h.join().unwrap();
        h
    }
    fn send(&mut self, signers: &[&Keypair], instructions: Vec<Instruction>) -> TxResult {
        self.svm.expire_blockhash();
        let message = Message::new(&instructions, Some(&signers[0].pubkey()));
        let transaction = Transaction::new(signers, message, self.svm.latest_blockhash());
        self.svm.send_transaction(transaction).map_err(Box::new)
    }
    fn state(&self) -> Vec<u8> {
        self.svm.get_account(&self.vault).unwrap().data
    }
    fn phase(&self) -> u8 {
        self.state()[8]
    }
    fn seq(&self) -> u64 {
        int(&self.state(), channel::SEQ)
    }
    fn lamports(&self, key: &Address) -> u64 {
        self.svm.get_account(key).unwrap().lamports
    }
    fn at(&mut self, time: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = time;
        self.svm.set_sysvar(&clock);
    }
    fn window(&self) -> i64 {
        int(&self.state(), channel::WINDOW) as i64
    }
    fn deadline(&self) -> i64 {
        int(&self.state(), 97) as i64
    }
    fn ix(&self, tag: u8, args: Vec<u8>, extra: Vec<AccountMeta>) -> Instruction {
        let mut accounts = vec![AccountMeta::new(self.vault, false)];
        accounts.extend(extra);
        let mut data = vec![tag];
        data.extend(args);
        Instruction {
            program_id: PROGRAM,
            accounts,
            data,
        }
    }
    fn wallets(&self) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.a.pubkey(), false),
            AccountMeta::new(self.b.pubkey(), false),
        ]
    }
    fn join(&mut self) -> TxResult {
        let ix = self.ix(
            31,
            terms(),
            vec![
                AccountMeta::new(self.b.pubkey(), true),
                AccountMeta::new_readonly(Address::default(), false),
            ],
        );
        self.send(&[&wallet_b()], vec![ix])
    }
    fn timeout(&mut self) -> TxResult {
        let ix = self.ix(41, vec![], self.wallets());
        let payer = Keypair::new_from_array(self.stranger.to_bytes()[..32].try_into().unwrap());
        self.send(&[&payer], vec![ix])
    }
    /// Uploads a hand state into a fresh buffer owned by player A.
    fn upload(&mut self, blob: &[u8]) -> Address {
        self.upload_as(&wallet_a(), blob)
    }
    fn buffer_key(&self, address: &Address) -> Keypair {
        let secret = self.buffers.iter().find(|(a, _)| a == address).unwrap().1;
        Keypair::new_from_array(secret)
    }
    fn upload_as(&mut self, poster: &Keypair, blob: &[u8]) -> Address {
        let buffer = Keypair::new();
        let secret: [u8; 32] = buffer.to_bytes()[..32].try_into().unwrap();
        self.buffers.push((buffer.pubkey(), secret));
        let rent = self
            .svm
            .minimum_balance_for_rent_exemption(channel::BUFFER_SPACE);
        let mut create = vec![0, 0, 0, 0];
        create.extend(rent.to_le_bytes());
        create.extend((channel::BUFFER_SPACE as u64).to_le_bytes());
        create.extend(PROGRAM.as_ref());
        let allocate = Instruction {
            program_id: Address::default(),
            accounts: vec![
                AccountMeta::new(poster.pubkey(), true),
                AccountMeta::new(buffer.pubkey(), true),
            ],
            data: create,
        };
        let init = Instruction {
            program_id: PROGRAM,
            accounts: vec![
                AccountMeta::new(buffer.pubkey(), true),
                AccountMeta::new(poster.pubkey(), true),
                AccountMeta::new_readonly(self.vault, false),
            ],
            data: vec![35],
        };
        self.send(&[poster, &buffer], vec![allocate, init]).unwrap();
        for (i, chunk) in blob.chunks(1000).enumerate() {
            let mut data = vec![36];
            data.extend(((i * 1000) as u32).to_le_bytes());
            data.extend(chunk);
            let write = Instruction {
                program_id: PROGRAM,
                accounts: vec![
                    AccountMeta::new(buffer.pubkey(), false),
                    AccountMeta::new_readonly(poster.pubkey(), true),
                ],
                data,
            };
            self.send(&[poster], vec![write]).unwrap();
        }
        buffer.pubkey()
    }
    /// Uploads a hand state and posts it with whatever signature instruction it's given.
    fn post_hand_with(&mut self, blob: &[u8], seq: u64, signed: Instruction) -> TxResult {
        let buffer = self.upload(blob);
        let poster = wallet_a();
        let post = self.ix(
            38,
            seq.to_le_bytes().to_vec(),
            vec![
                AccountMeta::new_readonly(poster.pubkey(), true),
                AccountMeta::new_readonly(buffer, false),
                AccountMeta::new_readonly(INSTRUCTIONS, false),
            ],
        );
        self.send(&[&poster], vec![signed, post])
    }
    fn post_state(&mut self, state: &Value) -> TxResult {
        let (blob, seq) = (bytes(&state["blob"]), state["seq"].as_u64().unwrap());
        self.post_hand_with(&blob, seq, both_signed(state))
    }
    fn apply(&mut self, step: &Value) -> TxResult {
        let seat = step["seat"].as_u64().unwrap() as usize;
        let mut args = (step["seq"].as_u64().unwrap() - 1).to_le_bytes().to_vec();
        args.extend(bytes(&step["args"]));
        let player = mover(seat);
        let ix = self.ix(
            step["tag"].as_u64().unwrap() as u8,
            args,
            vec![
                AccountMeta::new_readonly(player.pubkey(), true),
                AccountMeta::new_readonly(INSTRUCTIONS, false),
            ],
        );
        let signed = ed25519(&[(
            session_key(seat),
            bytes(&step["signature"]),
            bytes(&step["message"]),
        )]);
        self.send(&[&player], vec![signed, ix])
    }
    fn close_ix(&self, close: &Value) -> Instruction {
        let mut args = close["seq"].as_u64().unwrap().to_le_bytes().to_vec();
        args.extend(close["stacks"][0].as_u64().unwrap().to_le_bytes());
        args.extend(close["stacks"][1].as_u64().unwrap().to_le_bytes());
        let mut extra = self.wallets();
        extra.push(AccountMeta::new_readonly(INSTRUCTIONS, false));
        self.ix(33, args, extra)
    }
    fn post_stacks_ix(&self, payload: Vec<u8>, seq: u64, player: &Keypair) -> Instruction {
        let mut args = seq.to_le_bytes().to_vec();
        args.extend(payload);
        self.ix(
            34,
            args,
            vec![
                AccountMeta::new_readonly(player.pubkey(), true),
                AccountMeta::new_readonly(INSTRUCTIONS, false),
            ],
        )
    }
    fn exit_with_deposits(&mut self) -> TxResult {
        let mut payload = 1u32.to_le_bytes().to_vec();
        payload.extend(BUY_IN.to_le_bytes());
        payload.extend(BUY_IN.to_le_bytes());
        let ix = self.post_stacks_ix(payload, 0, &wallet_a());
        self.send(&[&wallet_a()], vec![ix])
    }
}
#[test]
fn invitation_can_be_cancelled_or_expires_with_only_the_deposit_refunded() {
    let mut h = H::new();
    assert_eq!(h.phase(), channel::WAITING);
    let ix = h.ix(
        32,
        vec![],
        vec![AccountMeta::new(wallet_b().pubkey(), true)],
    );
    assert!(
        h.send(&[&wallet_b()], vec![ix]).is_err(),
        "only the creator"
    );
    let before = h.lamports(&h.a.pubkey());
    let ix = h.ix(32, vec![], vec![AccountMeta::new(h.a.pubkey(), true)]);
    h.send(&[&wallet_a()], vec![ix]).unwrap();
    assert_eq!(h.phase(), channel::COMPLETE);
    assert!(h.lamports(&h.a.pubkey()) >= before + BUY_IN - 10_000);
    let mut h = H::new();
    assert!(h.timeout().is_err(), "the invitation hasn't expired");
    let deadline = h.deadline();
    h.at(deadline);
    let before = h.lamports(&h.a.pubkey());
    h.timeout().unwrap();
    assert_eq!(h.lamports(&h.a.pubkey()), before + BUY_IN);
    // An expired invitation can't be joined any more, on a fresh match at the same moment.
    let mut h = H::new();
    let deadline = h.deadline();
    h.at(deadline);
    assert!(h.join().is_err());
}
#[test]
fn a_normal_match_touches_the_chain_three_times_and_settles_at_once() {
    let mut h = H::joined();
    assert_eq!(h.phase(), channel::OPEN);
    assert_eq!(h.deadline(), 0, "no clock runs while agents play off-chain");
    let v = vectors();
    let final_stacks = [
        v["close"]["stacks"][0].as_u64().unwrap(),
        v["close"]["stacks"][1].as_u64().unwrap(),
    ];
    let (a, b) = (h.lamports(&h.a.pubkey()), h.lamports(&h.b.pubkey()));
    let ix = h.close_ix(&v["close"]);
    let payer = Keypair::new();
    h.svm.airdrop(&payer.pubkey(), 1_000_000).unwrap();
    h.send(&[&payer], vec![both_signed(&v["close"]), ix])
        .unwrap();
    assert_eq!(h.phase(), channel::COMPLETE);
    assert_eq!(h.lamports(&h.a.pubkey()), a + final_stacks[0]);
    assert_eq!(h.lamports(&h.b.pubkey()), b + final_stacks[1]);
    // Retiring reclaims the rent and leaves a tombstone, so the address can't be reused.
    let ix = h.ix(44, vec![], vec![AccountMeta::new(h.a.pubkey(), true)]);
    h.send(&[&wallet_a()], vec![ix]).unwrap();
    assert_eq!(h.state(), b"ASTKEND5");
}
#[test]
fn signature_checks_cannot_be_dodged() {
    let v = vectors();
    let close = &v["close"];
    let (key0, key1) = (session_key(0), session_key(1));
    let (sig0, sig1) = (
        bytes(&close["signatures"][0]),
        bytes(&close["signatures"][1]),
    );
    let good = bytes(&close["message"]);
    let mut other = good.clone();
    other[0] ^= 1;
    let cases: Vec<(&str, Vec<Entry>)> = vec![
        (
            "one signature",
            vec![(key0.clone(), sig0.clone(), good.clone())],
        ),
        (
            "the same key twice",
            vec![
                (key0.clone(), sig0.clone(), good.clone()),
                (key0.clone(), sig0.clone(), good.clone()),
            ],
        ),
        (
            "keys in the wrong order",
            vec![
                (key1.clone(), sig1.clone(), good.clone()),
                (key0.clone(), sig0.clone(), good.clone()),
            ],
        ),
    ];
    for (name, entries) in cases {
        let mut h = H::joined();
        let ix = h.close_ix(close);
        assert!(
            h.send(&[&wallet_a()], vec![ed25519(&entries), ix]).is_err(),
            "{name}"
        );
        assert_eq!(h.phase(), channel::OPEN, "{name}");
    }
    // A bad signature fails in the runtime's own check.
    let mut h = H::joined();
    let mut bad = sig1.clone();
    bad[0] ^= 1;
    let ix = h.close_ix(close);
    let signed = ed25519(&[
        (key0.clone(), sig0.clone(), good.clone()),
        (key1.clone(), bad, good.clone()),
    ]);
    assert!(h.send(&[&wallet_a()], vec![signed, ix]).is_err());
    // Valid signatures over some other message don't count.
    let mut h = H::joined();
    let ix = h.close_ix(close);
    let stranger_message = bytes(&v["accept"]["message"]);
    let signed = ed25519(&[
        (
            key0.clone(),
            bytes(&v["accept"]["signatures"][0]),
            stranger_message.clone(),
        ),
        (
            key1.clone(),
            bytes(&v["accept"]["signatures"][1]),
            stranger_message,
        ),
    ]);
    assert!(h.send(&[&wallet_a()], vec![signed, ix]).is_err());
    // No signature instruction, or one that isn't directly before, doesn't count either.
    let mut h = H::joined();
    let ix = h.close_ix(close);
    assert!(h.send(&[&wallet_a()], vec![ix.clone()]).is_err());
    let filler = Instruction {
        program_id: Address::default(),
        accounts: vec![
            AccountMeta::new(wallet_a().pubkey(), true),
            AccountMeta::new(wallet_b().pubkey(), false),
        ],
        data: {
            let mut d = 2u32.to_le_bytes().to_vec();
            d.extend(1u64.to_le_bytes());
            d
        },
    };
    assert!(h
        .send(&[&wallet_a()], vec![both_signed(close), filler, ix.clone()])
        .is_err());
    // Offsets pointing into another instruction would let a key sit there unverified.
    let mut forged = both_signed(close);
    forged.data[2 + 2] = 1; // first entry's signature instruction index
    forged.data[2 + 3] = 0;
    assert!(h.send(&[&wallet_a()], vec![forged, ix.clone()]).is_err());
    // A fake sysvar account can't stand in for the real instructions list.
    let mut fake = ix.clone();
    let imposter = Keypair::new();
    h.svm.airdrop(&imposter.pubkey(), 1_000_000).unwrap();
    fake.accounts.last_mut().unwrap().pubkey = imposter.pubkey();
    assert!(h
        .send(&[&wallet_a()], vec![both_signed(close), fake])
        .is_err());
    // Stacks that don't add up to the escrow are refused even with both signatures in place.
    let mut wrong = close.clone();
    wrong["stacks"][0] = Value::from(close["stacks"][0].as_u64().unwrap() + 1);
    let ix = h.close_ix(&wrong);
    assert!(h
        .send(&[&wallet_a()], vec![both_signed(close), ix])
        .is_err());
    assert_eq!(h.phase(), channel::OPEN);
}
#[test]
fn walking_away_before_anything_is_signed_returns_both_deposits_after_the_window() {
    let mut h = H::joined();
    let ix = {
        let mut payload = 1u32.to_le_bytes().to_vec();
        payload.extend((BUY_IN + 1).to_le_bytes());
        payload.extend((BUY_IN - 1).to_le_bytes());
        h.post_stacks_ix(payload, 0, &wallet_a())
    };
    assert!(
        h.send(&[&wallet_a()], vec![ix]).is_err(),
        "sequence 0 can only mean the original deposits"
    );
    let mut payload = 1u32.to_le_bytes().to_vec();
    payload.extend(BUY_IN.to_le_bytes());
    payload.extend(BUY_IN.to_le_bytes());
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000).unwrap();
    let ix = h.post_stacks_ix(payload, 0, &stranger);
    assert!(h.send(&[&stranger], vec![ix]).is_err(), "players only");
    h.exit_with_deposits().unwrap();
    assert_eq!(h.phase(), channel::EXIT);
    assert!(h.timeout().is_err(), "the other player gets the window");
    let window = h.window();
    h.at(window);
    let (a, b) = (h.lamports(&h.a.pubkey()), h.lamports(&h.b.pubkey()));
    h.timeout().unwrap();
    assert_eq!(h.lamports(&h.a.pubkey()), a + BUY_IN);
    assert_eq!(h.lamports(&h.b.pubkey()), b + BUY_IN);
}
#[test]
fn a_newer_state_beats_an_old_one_during_the_window_and_never_after() {
    let v = vectors();
    let mut h = H::joined();
    h.exit_with_deposits().unwrap();
    // The other player answers a stale exit with what was really agreed.
    h.post_state(&v["accept"]).unwrap();
    assert_eq!(h.seq(), 1);
    assert_eq!(h.phase(), play::HOLE_B);
    h.post_state(&v["middle"]).unwrap();
    assert_eq!(h.seq(), v["middle"]["seq"].as_u64().unwrap());
    // Older states bounce, including an identical one.
    assert!(h.post_state(&v["accept"]).is_err());
    assert!(h.post_state(&v["middle"]).is_err());
    let window = h.window();
    h.at(window);
    // Rollback attack: once play can resume on chain, a state both players really signed can't be
    // posted any more, even a newer one. Otherwise a player could reveal a card and then roll back.
    let newer = &v["later"];
    assert!(newer["seq"].as_u64().unwrap() > v["middle"]["seq"].as_u64().unwrap());
    h.at(window - 1);
    let before = h.state();
    h.at(window);
    assert!(h.post_state(newer).is_err());
    assert_eq!(h.state(), before);
    // One second earlier the same post would have worked, so the refusal above is about the window.
    let mut h = H::joined();
    h.post_state(&v["middle"]).unwrap();
    let window = h.window();
    h.at(window - 1);
    h.post_state(newer).unwrap();
    assert_eq!(h.seq(), newer["seq"].as_u64().unwrap());
    assert_eq!(
        h.window(),
        window - 1 + SECONDS,
        "a newer state gets its own window"
    );
}
#[test]
fn a_post_needs_both_signatures_and_the_exact_bytes() {
    let v = vectors();
    let accept = &v["accept"];
    let blob = bytes(&accept["blob"]);
    let mut h = H::joined();
    let one_only = ed25519(&[(
        session_key(0),
        bytes(&accept["signatures"][0]),
        bytes(&accept["message"]),
    )]);
    assert!(h.post_hand_with(&blob, 1, one_only).is_err());
    // Changing any byte of the state changes what was signed.
    let mut tampered = blob.clone();
    tampered[646] ^= 1;
    assert!(h.post_hand_with(&tampered, 1, both_signed(accept)).is_err());
    // So does claiming another step for it.
    assert!(h.post_hand_with(&blob, 2, both_signed(accept)).is_err());
    assert_eq!(h.phase(), channel::OPEN);
    // Another player's key doesn't help, even over the right message.
    let imposter = ed25519(&[
        (
            session_key(0),
            bytes(&accept["signatures"][0]),
            bytes(&accept["message"]),
        ),
        (
            bytes(&v["stranger"]),
            bytes(&accept["strangerSignature"]),
            bytes(&accept["message"]),
        ),
    ]);
    assert!(h.post_hand_with(&blob, 1, imposter).is_err());
    h.post_hand_with(&blob, 1, both_signed(accept)).unwrap();
    assert_eq!(h.phase(), play::HOLE_B);
}
#[test]
fn a_whole_hand_played_on_chain_matches_the_engine_byte_for_byte() {
    let v = vectors();
    let mut h = H::joined();
    h.post_state(&v["accept"]).unwrap();
    let steps = v["steps"].as_array().unwrap();
    // No game move can land during the window, or a card could be revealed before it closes.
    assert!(h.apply(&steps[0]).is_err());
    let window = h.window();
    h.at(window);
    let mut consumed = (0u64, 0u64);
    for (i, step) in steps.iter().enumerate() {
        let result = h.apply(step);
        let meta = result.unwrap_or_else(|e| panic!("step {i}: {:?}", e.meta.logs));
        let tag = step["tag"].as_u64().unwrap();
        if tag == 40 {
            consumed.0 = consumed.0.max(meta.compute_units_consumed);
        } else {
            consumed.1 = consumed.1.max(meta.compute_units_consumed);
        }
        assert_eq!(h.seq(), step["seq"].as_u64().unwrap(), "step {i}");
        assert_eq!(
            hex::encode(channel::blob(&h.state())),
            step["blob"].as_str().unwrap(),
            "step {i}"
        );
    }
    println!(
        "Peak compute: share move {}, betting move {}",
        consumed.0, consumed.1
    );
    assert_eq!(h.phase(), channel::EXIT);
    let (a, b) = (h.lamports(&h.a.pubkey()), h.lamports(&h.b.pubkey()));
    h.timeout().unwrap();
    assert_eq!(
        h.lamports(&h.a.pubkey()),
        a + v["final"][0].as_u64().unwrap()
    );
    assert_eq!(
        h.lamports(&h.b.pubkey()),
        b + v["final"][1].as_u64().unwrap()
    );
    assert_eq!(h.phase(), channel::COMPLETE);
}
#[test]
fn an_on_chain_move_must_carry_the_movers_signature_on_the_result() {
    let v = vectors();
    let steps = v["steps"].as_array().unwrap();
    let mut h = H::joined();
    h.post_state(&v["accept"]).unwrap();
    let window = h.window();
    h.at(window);
    let step = &steps[0];
    let seat = step["seat"].as_u64().unwrap() as usize;
    let attempt = |h: &mut H, signed: Instruction, player: Keypair| {
        let mut args = 1u64.to_le_bytes().to_vec();
        args.extend(bytes(&step["args"]));
        let ix = h.ix(
            step["tag"].as_u64().unwrap() as u8,
            args,
            vec![
                AccountMeta::new_readonly(player.pubkey(), true),
                AccountMeta::new_readonly(INSTRUCTIONS, false),
            ],
        );
        h.send(&[&player], vec![signed, ix])
    };
    // A signature on some other state.
    let wrong = ed25519(&[(
        session_key(seat),
        bytes(&steps[2]["signature"]),
        bytes(&steps[2]["message"]),
    )]);
    assert!(attempt(&mut h, wrong, mover(seat)).is_err());
    // The right state signed by the other player's key.
    let other_key = ed25519(&[(
        session_key(1 - seat),
        bytes(&v["middle"]["signatures"][1 - seat]),
        bytes(&v["middle"]["message"]),
    )]);
    assert!(attempt(&mut h, other_key, mover(seat)).is_err());
    // The obligated player's move sent by the other player.
    let right = ed25519(&[(
        session_key(seat),
        bytes(&step["signature"]),
        bytes(&step["message"]),
    )]);
    assert!(attempt(&mut h, right.clone(), mover(1 - seat)).is_err());
    assert_eq!(h.seq(), 1);
    attempt(&mut h, right, mover(seat)).unwrap();
    assert_eq!(h.seq(), 2);
    // Moves can't be replayed.
    assert!(h.apply(step).is_err());
}
#[test]
fn a_missed_deadline_counts_as_a_fold_and_only_the_pot_changes_hands() {
    let v = vectors();
    let mut h = H::joined();
    h.post_state(&v["accept"]).unwrap();
    assert!(h.timeout().is_err(), "the window hasn't even closed");
    let window = h.window();
    h.at(window);
    assert!(
        h.timeout().is_err(),
        "the obligated player gets a full clock"
    );
    let deadline = h.deadline();
    assert_eq!(deadline, window + SECONDS);
    h.at(deadline - 1);
    assert!(h.timeout().is_err());
    h.at(deadline);
    assert!(h.apply(&v["steps"][0]).is_err(), "too late to move");
    let (a, b) = (h.lamports(&h.a.pubkey()), h.lamports(&h.b.pubkey()));
    h.timeout().unwrap();
    // Seat 1 owed the first card shares. It loses its big blind against the small blind matched,
    // and keeps the rest of its stack, unlike the whole-match forfeit in older matches.
    let matched = BIG_BLIND / 2;
    assert_eq!(h.lamports(&h.a.pubkey()), a + BUY_IN + matched);
    assert_eq!(h.lamports(&h.b.pubkey()), b + BUY_IN - matched);
    assert_eq!(h.phase(), channel::COMPLETE);
}
#[test]
fn signing_two_states_at_one_step_forfeits_the_whole_escrow() {
    let v = vectors();
    let fork = &v["fork"];
    let seq = fork["seq"].as_u64().unwrap();
    let kind = fork["kind"].as_u64().unwrap() as u8;
    let entry = |i: usize| {
        (
            session_key(1),
            bytes(&fork["entries"][i]["signature"]),
            bytes(&fork["entries"][i]["message"]),
        )
    };
    let proof = |h: &H, seat: u8, first: usize, second: usize| {
        let mut args = vec![seat];
        args.extend(seq.to_le_bytes());
        args.push(kind);
        args.extend(bytes(&fork["entries"][first]["hash"]));
        args.push(kind);
        args.extend(bytes(&fork["entries"][second]["hash"]));
        let mut extra = h.wallets();
        extra.push(AccountMeta::new_readonly(INSTRUCTIONS, false));
        h.ix(42, args, extra)
    };
    let mut h = H::joined();
    let payer = Keypair::new();
    h.svm.airdrop(&payer.pubkey(), 1_000_000).unwrap();
    // The same state twice isn't a fork.
    let same = ed25519(&[entry(0), entry(0)]);
    let ix = proof(&h, 1, 0, 0);
    assert!(h.send(&[&payer], vec![same, ix]).is_err());
    // Blaming the honest player with the other's signatures fails.
    let ix = proof(&h, 0, 0, 1);
    assert!(h
        .send(&[&payer], vec![ed25519(&[entry(0), entry(1)]), ix])
        .is_err());
    assert_eq!(h.phase(), channel::OPEN);
    // Anyone holding the two signatures can prove it, whatever the match is doing.
    let a = h.lamports(&h.a.pubkey());
    let b = h.lamports(&h.b.pubkey());
    let ix = proof(&h, 1, 0, 1);
    h.send(&[&payer], vec![ed25519(&[entry(0), entry(1)]), ix])
        .unwrap();
    assert_eq!(h.phase(), channel::COMPLETE);
    assert_eq!(h.lamports(&h.a.pubkey()), a + 2 * BUY_IN);
    assert_eq!(h.lamports(&h.b.pubkey()), b);
}
#[test]
fn signed_stacks_settle_after_the_window_and_a_close_can_end_a_dispute() {
    let v = vectors();
    let mut h = H::joined();
    let stacks = &v["stacks"];
    let seq = stacks["seq"].as_u64().unwrap();
    let ix = h.post_stacks_ix(bytes(&stacks["payload"]), seq, &wallet_b());
    h.send(&[&wallet_b()], vec![both_signed(stacks), ix])
        .unwrap();
    assert_eq!(h.phase(), channel::EXIT);
    assert!(h.timeout().is_err());
    let window = h.window();
    h.at(window);
    let (a, b) = (h.lamports(&h.a.pubkey()), h.lamports(&h.b.pubkey()));
    h.timeout().unwrap();
    assert_eq!(
        h.lamports(&h.a.pubkey()),
        a + stacks["stacks"][0].as_u64().unwrap()
    );
    assert_eq!(
        h.lamports(&h.b.pubkey()),
        b + stacks["stacks"][1].as_u64().unwrap()
    );
    // Both players can still agree during a dispute, without waiting.
    let mut h = H::joined();
    h.post_state(&v["accept"]).unwrap();
    let ix = h.close_ix(&v["close"]);
    h.send(&[&wallet_a()], vec![both_signed(&v["close"]), ix])
        .unwrap();
    assert_eq!(h.phase(), channel::COMPLETE);
}
#[test]
fn channel_and_older_matches_cannot_touch_each_other() {
    let mut h = H::joined();
    let before = h.state();
    assert_eq!(before.len(), channel::SPACE);
    for tag in [2u8, 3, 4, 5, 6, 7, 13, 14, 15, 16, 18, 20] {
        let mut data = vec![tag];
        data.extend(int(&before, 9).to_le_bytes());
        data.extend([0u8; 32]);
        let ix = Instruction {
            program_id: PROGRAM,
            accounts: vec![
                AccountMeta::new(h.vault, false),
                AccountMeta::new(wallet_a().pubkey(), true),
                AccountMeta::new(wallet_b().pubkey(), true),
                AccountMeta::new_readonly(Address::default(), false),
            ],
            data,
        };
        assert!(
            h.send(&[&wallet_a(), &wallet_b()], vec![ix]).is_err(),
            "older tag {tag} reached a channel account"
        );
    }
    assert_eq!(h.state(), before);
    // Malformed channel instructions fail cleanly at every tag, with no accounts or short data.
    for tag in 30u8..=44 {
        let ix = Instruction {
            program_id: PROGRAM,
            accounts: vec![AccountMeta::new(h.vault, false)],
            data: vec![tag],
        };
        assert!(h.send(&[&wallet_a()], vec![ix]).is_err(), "tag {tag}");
    }
    assert_eq!(h.state(), before);
}
#[test]
fn only_the_named_opponent_can_join_and_only_on_the_exact_terms() {
    let mut h = H::new();
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let as_stranger = h.ix(
        31,
        terms(),
        vec![
            AccountMeta::new(stranger.pubkey(), true),
            AccountMeta::new_readonly(Address::default(), false),
        ],
    );
    assert!(h.send(&[&stranger], vec![as_stranger]).is_err());
    let wrong_terms = h.ix(
        31,
        [1u8; 32].to_vec(),
        vec![
            AccountMeta::new(wallet_b().pubkey(), true),
            AccountMeta::new_readonly(Address::default(), false),
        ],
    );
    assert!(h.send(&[&wallet_b()], vec![wrong_terms]).is_err());
    assert_eq!(h.phase(), channel::WAITING);
    h.join().unwrap();
    assert!(h.join().is_err(), "nobody can join twice");
}
#[test]
fn creation_refuses_unusable_session_keys_and_terms() {
    let mut h = H::joined();
    let a = wallet_a();
    let make =
        |nonce: [u8; 32], buy_in: u64, seconds: u32, blind: u64, s0: [u8; 32], s1: [u8; 32]| {
            let (address, _) =
                Address::find_program_address(&[b"channel", a.pubkey().as_ref(), &nonce], &PROGRAM);
            let mut data = vec![30];
            data.extend(nonce);
            data.extend(buy_in.to_le_bytes());
            data.extend(seconds.to_le_bytes());
            data.extend(GENESIS);
            data.extend(blind.to_le_bytes());
            data.extend(1u32.to_le_bytes());
            data.extend(s0);
            data.extend(s1);
            Instruction {
                program_id: PROGRAM,
                accounts: vec![
                    AccountMeta::new(a.pubkey(), true),
                    AccountMeta::new_readonly(wallet_b().pubkey(), false),
                    AccountMeta::new(address, false),
                    AccountMeta::new_readonly(Address::default(), false),
                ],
                data,
            }
        };
    let (one, two) = ([5u8; 32], [6u8; 32]);
    for (name, ix) in [
        (
            "same key twice",
            make([40; 32], BUY_IN, 3600, 20_000, one, one),
        ),
        (
            "empty key",
            make([41; 32], BUY_IN, 3600, 20_000, [0; 32], two),
        ),
        (
            "blind too big",
            make([42; 32], BUY_IN, 3600, BUY_IN, one, two),
        ),
        ("odd blind", make([43; 32], BUY_IN, 3600, 3, one, two)),
        (
            "clock too short",
            make([44; 32], BUY_IN, 1, 20_000, one, two),
        ),
    ] {
        assert!(h.send(&[&wallet_a()], vec![ix]).is_err(), "{name}");
    }
    // The same parameters with usable values do work, so the refusals above mean what they say.
    let ok = make([45; 32], BUY_IN, 3600, 20_000, one, two);
    h.send(&[&wallet_a()], vec![ok]).unwrap();
}
#[test]
fn both_signing_a_state_cannot_make_money_out_of_nothing() {
    let v = vectors();
    let mut h = H::joined();
    assert!(
        h.post_state(&v["inflated"]).is_err(),
        "stacks must add up to the escrow"
    );
    assert!(
        h.post_state(&v["wrongStage"]).is_err(),
        "the phase and game stage must agree"
    );
    assert!(
        h.post_state(&v["badAggressor"]).is_err(),
        "only a seat or nobody can be the player who got called"
    );
    assert_eq!(h.phase(), channel::OPEN);
}
#[test]
fn a_post_must_come_from_a_complete_buffer_the_poster_owns() {
    let v = vectors();
    let accept = &v["accept"];
    let blob = bytes(&accept["blob"]);
    let mut h = H::joined();
    // Half uploaded.
    assert!(h
        .post_hand_with(&blob[..1000], 1, both_signed(accept))
        .is_err());
    // Someone else's buffer: uploaded by A, posted by B.
    let buffer = h.upload(&blob);
    let post = h.ix(
        38,
        1u64.to_le_bytes().to_vec(),
        vec![
            AccountMeta::new_readonly(wallet_b().pubkey(), true),
            AccountMeta::new_readonly(buffer, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
        ],
    );
    assert!(h
        .send(&[&wallet_b()], vec![both_signed(accept), post])
        .is_err());
    assert_eq!(h.phase(), channel::OPEN);
    // A closed buffer returns its rent to its owner, and only its owner can close it.
    let close = |player: &Keypair| Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(buffer, false),
            AccountMeta::new(player.pubkey(), true),
        ],
        data: vec![37],
    };
    assert!(h.send(&[&wallet_b()], vec![close(&wallet_b())]).is_err());
    let before = h.lamports(&wallet_a().pubkey());
    h.send(&[&wallet_a()], vec![close(&wallet_a())]).unwrap();
    assert!(h.lamports(&wallet_a().pubkey()) > before);
}
#[test]
fn an_old_close_cannot_end_a_dispute_over_a_newer_state() {
    let v = vectors();
    let mut h = H::joined();
    h.post_state(&v["middle"]).unwrap();
    let ix = h.close_ix(&v["earlyClose"]);
    assert!(h
        .send(&[&wallet_a()], vec![both_signed(&v["earlyClose"]), ix])
        .is_err());
    assert_eq!(h.seq(), v["middle"]["seq"].as_u64().unwrap());
}
#[test]
fn a_player_with_an_empty_wallet_can_still_claim_a_small_payout() {
    let v = vectors();
    let close = &v["smallClose"];
    let mut h = H::joined();
    // Player B empties its wallet, so a payout below the rent minimum can't be delivered directly.
    let drained = h.lamports(&wallet_b().pubkey());
    let drain = Instruction {
        program_id: Address::default(),
        accounts: vec![
            AccountMeta::new(wallet_b().pubkey(), true),
            AccountMeta::new(h.stranger.pubkey(), false),
        ],
        data: {
            let mut d = 2u32.to_le_bytes().to_vec();
            d.extend(drained.to_le_bytes());
            d
        },
    };
    let payer = Keypair::new();
    h.svm.airdrop(&payer.pubkey(), 10_000_000).unwrap();
    h.send(&[&payer, &wallet_b()], vec![drain]).unwrap();
    let ix = h.close_ix(close);
    h.send(&[&payer], vec![both_signed(close), ix]).unwrap();
    assert_eq!(h.phase(), channel::COMPLETE);
    assert_eq!(h.state()[play::CURSOR], 2, "B's payout is held for it");
    // Retiring has to wait, so the held payout can't be swept away with the rent.
    let retire = h.ix(44, vec![], vec![AccountMeta::new(h.a.pubkey(), true)]);
    assert!(h.send(&[&wallet_a()], vec![retire.clone()]).is_err());
    // Only B can claim it, and it can send it somewhere usable.
    let destination = Keypair::new();
    h.svm.airdrop(&destination.pubkey(), 1_000_000).unwrap();
    let claim = |player: &Keypair, seat: u8, h: &H| {
        h.ix(
            43,
            vec![seat],
            vec![
                AccountMeta::new_readonly(player.pubkey(), true),
                AccountMeta::new(destination.pubkey(), false),
            ],
        )
    };
    let wrong = claim(&wallet_a(), 1, &h);
    assert!(h.send(&[&payer, &wallet_a()], vec![wrong]).is_err());
    let right = claim(&wallet_b(), 1, &h);
    let before = h.lamports(&destination.pubkey());
    h.send(&[&payer, &wallet_b()], vec![right.clone()]).unwrap();
    assert_eq!(h.lamports(&destination.pubkey()), before + 1000);
    assert!(
        h.send(&[&payer, &wallet_b()], vec![right]).is_err(),
        "a payout can't be claimed twice"
    );
    h.send(&[&wallet_a()], vec![retire]).unwrap();
}
#[test]
fn the_contract_computes_the_terms_so_a_creator_cannot_change_them_behind_a_joiners_back() {
    let mut h = H::new();
    assert_eq!(
        h.state()[105..137],
        terms(),
        "the contract and the JavaScript client compute the same terms hash"
    );
    assert_eq!(h.vault.to_string(), vectors()["match"].as_str().unwrap());
    // A dishonest creator stores something else, and offers the joiner the terms it agreed to.
    let attacker = [99u8; 32];
    let honest: [u8; 32] = session_key(1).try_into().unwrap();
    let cases: [Terms; 6] = [
        (
            "its own key in the opponent's seat",
            BUY_IN,
            BIG_BLIND,
            SECONDS as u32,
            attacker,
            GENESIS,
        ),
        (
            "a bigger stake",
            BUY_IN * 2,
            BIG_BLIND,
            SECONDS as u32,
            honest,
            GENESIS,
        ),
        (
            "a different blind",
            BUY_IN,
            BIG_BLIND * 2,
            SECONDS as u32,
            honest,
            GENESIS,
        ),
        ("a shorter clock", BUY_IN, BIG_BLIND, 30, honest, GENESIS),
        (
            "another chain",
            BUY_IN,
            BIG_BLIND,
            SECONDS as u32,
            honest,
            [1; 32],
        ),
        (
            "exactly what was agreed",
            BUY_IN,
            BIG_BLIND,
            SECONDS as u32,
            honest,
            GENESIS,
        ),
    ];
    for (i, (name, buy_in, blind, seconds, session_b, genesis)) in cases.iter().enumerate() {
        let nonce = [100 + i as u8; 32];
        let (address, _) = Address::find_program_address(
            &[b"channel", wallet_a().pubkey().as_ref(), &nonce],
            &PROGRAM,
        );
        let mut data = vec![30];
        data.extend(nonce);
        data.extend(buy_in.to_le_bytes());
        data.extend(seconds.to_le_bytes());
        data.extend(genesis);
        data.extend(blind.to_le_bytes());
        data.extend(1u32.to_le_bytes());
        data.extend(session_key(0));
        data.extend(session_b);
        let create = Instruction {
            program_id: PROGRAM,
            accounts: vec![
                AccountMeta::new(wallet_a().pubkey(), true),
                AccountMeta::new_readonly(wallet_b().pubkey(), false),
                AccountMeta::new(address, false),
                AccountMeta::new_readonly(Address::default(), false),
            ],
            data,
        };
        h.send(&[&wallet_a()], vec![create]).unwrap();
        let mut join_data = vec![31];
        join_data.extend(terms());
        let join = Instruction {
            program_id: PROGRAM,
            accounts: vec![
                AccountMeta::new(address, false),
                AccountMeta::new(wallet_b().pubkey(), true),
                AccountMeta::new_readonly(Address::default(), false),
            ],
            data: join_data,
        };
        let outcome = h.send(&[&wallet_b()], vec![join]);
        if i == cases.len() - 1 {
            outcome.unwrap_or_else(|e| panic!("{name}: {:?}", e.meta.logs));
        } else {
            assert!(outcome.is_err(), "{name}");
        }
    }
}
fn valid_entries() -> (Vec<u8>, Vec<KeyAndMessage>) {
    let v = vectors();
    let close = &v["close"];
    let message: [u8; 32] = bytes(&close["message"]).try_into().unwrap();
    let keys: [[u8; 32]; 2] = [
        session_key(0).try_into().unwrap(),
        session_key(1).try_into().unwrap(),
    ];
    (
        both_signed(close).data,
        vec![(keys[0], message), (keys[1], message)],
    )
}
#[test]
fn the_signature_instruction_must_cover_exactly_these_keys_and_messages() {
    let (good, expected) = valid_entries();
    assert!(channel::covers(&ED25519, false, &good, &expected));
    assert!(
        !channel::covers(&PROGRAM, false, &good, &expected),
        "another program's instruction proves nothing, whatever its data says"
    );
    assert!(
        !channel::covers(&ED25519, true, &good, &expected),
        "the real signature instruction takes no accounts"
    );
    assert!(
        !channel::covers(&ED25519, false, &good, &expected[..1]),
        "the entry count must be exact"
    );
    // Every offset must point inside this instruction, or the bytes checked aren't the bytes verified.
    for (entry, name) in [(0usize, "first"), (1, "second")] {
        for (field, what) in [(2usize, "signature"), (6, "key"), (12, "message")] {
            let mut bad = good.clone();
            bad[2 + entry * 14 + field] = 0;
            bad[2 + entry * 14 + field + 1] = 0;
            assert!(
                !channel::covers(&ED25519, false, &bad, &expected),
                "{name} entry's {what} in another instruction"
            );
        }
        let mut short = good.clone();
        short[2 + entry * 14 + 10] = 31;
        assert!(
            !channel::covers(&ED25519, false, &short, &expected),
            "{name} entry signs a shorter message"
        );
    }
    let mut swapped = expected.clone();
    swapped.swap(0, 1);
    assert!(
        !channel::covers(&ED25519, false, &good, &swapped),
        "keys in the wrong order"
    );
    let mut other = expected.clone();
    other[1].1[0] ^= 1;
    assert!(
        !channel::covers(&ED25519, false, &good, &other),
        "another message"
    );
    // Malformed data is refused without a panic, at every truncation.
    for len in 0..good.len() {
        assert!(!channel::covers(&ED25519, false, &good[..len], &expected));
    }
    assert!(!channel::covers(&ED25519, false, &[], &expected));
}
#[test]
fn signed_totals_must_still_add_up_to_the_escrow() {
    let v = vectors();
    let mut h = H::joined();
    let close = &v["inflatedClose"];
    let ix = h.close_ix(close);
    assert!(h
        .send(&[&wallet_a()], vec![both_signed(close), ix])
        .is_err());
    let stacks = &v["inflatedStacks"];
    let ix = h.post_stacks_ix(
        bytes(&stacks["payload"]),
        stacks["seq"].as_u64().unwrap(),
        &wallet_a(),
    );
    assert!(h
        .send(&[&wallet_a()], vec![both_signed(stacks), ix])
        .is_err());
    assert!(
        h.post_state(&v["otherBlind"]).is_err(),
        "a state can't change the agreed blind"
    );
    assert_eq!(h.phase(), channel::OPEN);
}
#[test]
fn posting_stacks_needs_both_signatures() {
    let v = vectors();
    let stacks = &v["stacks"];
    let seq = stacks["seq"].as_u64().unwrap();
    let mut h = H::joined();
    let unsigned = h.post_stacks_ix(bytes(&stacks["payload"]), seq, &wallet_a());
    assert!(h.send(&[&wallet_a()], vec![unsigned.clone()]).is_err());
    let one = ed25519(&[(
        session_key(0),
        bytes(&stacks["signatures"][0]),
        bytes(&stacks["message"]),
    )]);
    assert!(h.send(&[&wallet_a()], vec![one, unsigned]).is_err());
    assert_eq!(h.phase(), channel::OPEN);
}
#[test]
fn only_a_player_can_post_a_hand() {
    let v = vectors();
    let accept = &v["accept"];
    let mut h = H::joined();
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let buffer = h.upload_as(&stranger, &bytes(&accept["blob"]));
    let post = h.ix(
        38,
        1u64.to_le_bytes().to_vec(),
        vec![
            AccountMeta::new_readonly(stranger.pubkey(), true),
            AccountMeta::new_readonly(buffer, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
        ],
    );
    assert!(h
        .send(&[&stranger], vec![both_signed(accept), post])
        .is_err());
    assert_eq!(h.phase(), channel::OPEN);
}
#[test]
fn a_buffer_cannot_be_reset_overrun_or_written_out_of_order() {
    let v = vectors();
    let blob = bytes(&v["accept"]["blob"]);
    let mut h = H::joined();
    let buffer = h.upload(&blob[..500]);
    let a = wallet_a();
    let write = |offset: u32, data: &[u8]| {
        let mut body = vec![36];
        body.extend(offset.to_le_bytes());
        body.extend(data);
        Instruction {
            program_id: PROGRAM,
            accounts: vec![
                AccountMeta::new(buffer, false),
                AccountMeta::new_readonly(a.pubkey(), true),
            ],
            data: body,
        }
    };
    assert!(
        h.send(&[&a], vec![write(0, &blob[..10])]).is_err(),
        "rewind"
    );
    assert!(h.send(&[&a], vec![write(600, &blob[..10])]).is_err(), "gap");
    h.send(&[&a], vec![write(500, &blob[500..1000])]).unwrap();
    h.send(&[&a], vec![write(1000, &blob[1000..])]).unwrap();
    assert!(
        h.send(&[&a], vec![write(blob.len() as u32, &[1])]).is_err(),
        "overrun"
    );
    // An account that already holds a buffer can't be initialized over.
    let again = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(buffer, true),
            AccountMeta::new(a.pubkey(), true),
            AccountMeta::new_readonly(h.vault, false),
        ],
        data: vec![35],
    };
    assert!(again.accounts[0].is_signer);
    let signer_for_buffer = h.buffer_key(&buffer);
    assert!(h.send(&[&a, &signer_for_buffer], vec![again]).is_err());
}
#[test]
fn a_stale_move_is_refused_even_with_a_valid_signature() {
    let v = vectors();
    let mut h = H::joined();
    h.post_state(&v["accept"]).unwrap();
    let window = h.window();
    h.at(window);
    let step = &v["steps"][0];
    let seat = step["seat"].as_u64().unwrap() as usize;
    let player = mover(seat);
    let mut args = 9u64.to_le_bytes().to_vec();
    args.extend(bytes(&step["args"]));
    let ix = h.ix(
        step["tag"].as_u64().unwrap() as u8,
        args,
        vec![
            AccountMeta::new_readonly(player.pubkey(), true),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
        ],
    );
    let signed = ed25519(&[(
        session_key(seat),
        bytes(&step["signature"]),
        bytes(&step["message"]),
    )]);
    assert!(h.send(&[&player], vec![signed, ix]).is_err());
    assert_eq!(h.seq(), 1);
}
#[test]
fn a_settlement_pays_only_the_two_players_and_only_the_creator_retires() {
    let mut h = H::joined();
    h.exit_with_deposits().unwrap();
    let window = h.window();
    h.at(window);
    let thief = Keypair::new();
    h.svm.airdrop(&thief.pubkey(), 1_000_000).unwrap();
    let rerouted = h.ix(
        41,
        vec![],
        vec![
            AccountMeta::new(thief.pubkey(), false),
            AccountMeta::new(h.b.pubkey(), false),
        ],
    );
    assert!(h.send(&[&thief], vec![rerouted]).is_err());
    assert_eq!(h.phase(), channel::EXIT);
    h.timeout().unwrap();
    let as_opponent = h.ix(
        44,
        vec![],
        vec![AccountMeta::new(wallet_b().pubkey(), true)],
    );
    assert!(h.send(&[&wallet_b()], vec![as_opponent]).is_err());
    assert_eq!(h.phase(), channel::COMPLETE);
}
fn play_trace(h: &mut H, trace: &Value, upto: usize) {
    h.post_state(&vectors()["accept"]).unwrap();
    let window = h.window();
    h.at(window);
    for (i, step) in trace["steps"]
        .as_array()
        .unwrap()
        .iter()
        .take(upto)
        .enumerate()
    {
        let result = h.apply(step);
        result.unwrap_or_else(|e| panic!("step {i}: {:?}", e.meta.logs));
        assert_eq!(
            hex::encode(channel::blob(&h.state())),
            step["blob"].as_str().unwrap(),
            "step {i}"
        );
    }
}
fn first_show_step(trace: &Value) -> usize {
    trace["illegal"]["firstMuck"]["index"].as_u64().unwrap() as usize
}
const SHOW_A: u8 = 11;
const SHOW_B: u8 = 12;
#[test]
fn whoever_got_called_shows_first_and_the_caller_can_then_muck() {
    let trace = &vectors()["traces"]["riverBetMucked"];
    assert_eq!(trace["first"], 0, "seat 0 bet the river and got called");
    let mut h = H::joined();
    play_trace(&mut h, trace, first_show_step(trace));
    assert_eq!(h.phase(), SHOW_A, "the player who got called shows first");
    let steps = trace["steps"].as_array().unwrap();
    for step in &steps[first_show_step(trace)..] {
        h.apply(step).unwrap();
    }
    assert_eq!(steps.last().unwrap()["tag"], 45);
    assert_eq!(h.phase(), channel::EXIT);
    let state = h.state();
    assert_eq!(
        hex::encode(channel::blob(&state)),
        steps.last().unwrap()["blob"].as_str().unwrap()
    );
    // The first player's cards are public, and the mucked ones were never revealed.
    let g = play::read(&state).unwrap();
    assert!(g.holes[0].iter().all(|c| *c < 52));
    assert_eq!(g.holes[1], [255, 255]);
    assert_eq!(g.reason, 3);
    assert_eq!(g.winner, 0);
    for logical in [1usize, 3] {
        let slot = play::SHARES_OFFSET + logical * 64 + 32;
        assert_eq!(
            state[slot..slot + 32],
            [0; 32],
            "no share for a mucked card"
        );
    }
    let (a, b) = (h.lamports(&h.a.pubkey()), h.lamports(&h.b.pubkey()));
    h.timeout().unwrap();
    assert_eq!(
        h.lamports(&h.a.pubkey()),
        a + trace["final"][0].as_u64().unwrap()
    );
    assert_eq!(
        h.lamports(&h.b.pubkey()),
        b + trace["final"][1].as_u64().unwrap()
    );
    assert!(
        trace["final"][0].as_u64().unwrap() > BUY_IN,
        "the pot went to the player who showed"
    );
}
#[test]
fn a_caller_who_wants_to_show_can_and_the_best_hand_wins() {
    let trace = &vectors()["traces"]["riverBetShown"];
    let mut h = H::joined();
    let count = trace["steps"].as_array().unwrap().len();
    play_trace(&mut h, trace, count);
    assert_eq!(h.phase(), channel::EXIT);
    let g = play::read(&h.state()).unwrap();
    assert_eq!(g.reason, 1, "settled by comparing hands");
    assert!(g.holes.iter().flatten().all(|c| *c < 52));
}
#[test]
fn with_no_bet_on_the_river_the_first_to_act_shows_first() {
    let trace = &vectors()["traces"]["checkedDownMucked"];
    assert_eq!(
        trace["first"], 1,
        "the button is seat 0, so seat 1 acts first"
    );
    let mut h = H::joined();
    play_trace(&mut h, trace, first_show_step(trace));
    assert_eq!(h.phase(), SHOW_B);
    for step in &trace["steps"].as_array().unwrap()[first_show_step(trace)..] {
        h.apply(step).unwrap();
    }
    assert_eq!(play::read(&h.state()).unwrap().winner, 1);
}
#[test]
fn an_earlier_bet_does_not_count_once_a_later_street_is_checked_through() {
    // The main hand raises on the flop, and the river is checked through.
    let v = vectors();
    assert_eq!(
        v["mainFirst"], 1,
        "the river's first to act, not the flop's raiser"
    );
}
#[test]
fn an_all_in_that_gets_called_shows_first_after_the_board_runs_out() {
    let trace = &vectors()["traces"]["allInCalled"];
    assert_eq!(
        trace["first"], 0,
        "seat 0 shoved, and no betting could follow"
    );
    let mut h = H::joined();
    play_trace(&mut h, trace, first_show_step(trace));
    assert_eq!(h.phase(), SHOW_A);
    let count = trace["steps"].as_array().unwrap().len();
    for step in &trace["steps"].as_array().unwrap()[first_show_step(trace)..count] {
        h.apply(step).unwrap();
    }
    assert_eq!(h.phase(), channel::EXIT);
}
#[test]
fn the_player_who_got_called_cannot_muck_even_with_a_valid_signature() {
    let trace = &vectors()["traces"]["riverBetShown"];
    let mut h = H::joined();
    play_trace(&mut h, trace, first_show_step(trace));
    let before = h.state();
    assert!(h.apply(&trace["illegal"]["firstMuck"]).is_err());
    assert_eq!(h.state(), before);
    h.apply(&trace["steps"][first_show_step(trace)]).unwrap();
}
#[test]
fn a_hand_cannot_be_mucked_once_part_of_it_is_shown() {
    let trace = &vectors()["traces"]["riverBetShown"];
    let illegal = &trace["illegal"]["partialMuck"];
    let mut h = H::joined();
    play_trace(&mut h, trace, illegal["index"].as_u64().unwrap() as usize);
    assert_eq!(h.state()[play::CURSOR], 1);
    let before = h.state();
    assert!(h.apply(illegal).is_err());
    assert_eq!(h.state(), before);
}
#[test]
fn a_muck_is_refused_before_showdown_and_needs_the_movers_signature() {
    let trace = &vectors()["traces"]["riverBetMucked"];
    let steps = trace["steps"].as_array().unwrap();
    let mut h = H::joined();
    play_trace(&mut h, trace, 3);
    // Mucking early, with the signature from the real muck later on.
    let mut early = steps.last().unwrap().clone();
    early["seq"] = Value::from(4);
    assert!(h.apply(&early).is_err());
    let mut h = H::joined();
    play_trace(&mut h, trace, steps.len() - 1);
    // The right moment, with a signature over some other state.
    let mut unsigned = steps.last().unwrap().clone();
    unsigned["message"] = steps[steps.len() - 2]["message"].clone();
    unsigned["signature"] = steps[steps.len() - 2]["signature"].clone();
    assert!(h.apply(&unsigned).is_err());
    // A player who owes nothing can't send it either.
    let mut other = steps.last().unwrap().clone();
    other["seat"] = Value::from(0);
    assert!(h.apply(&other).is_err());
    h.apply(steps.last().unwrap()).unwrap();
}
#[test]
fn a_timed_out_showdown_counts_as_a_fold_and_reveals_nothing_more() {
    let trace = &vectors()["traces"]["riverBetMucked"];
    let mut h = H::joined();
    play_trace(&mut h, trace, first_show_step(trace));
    // The called player refuses to show. Its cards stay hidden, and it loses the pot.
    let deadline = h.deadline();
    h.at(deadline);
    let (a, b) = (h.lamports(&h.a.pubkey()), h.lamports(&h.b.pubkey()));
    h.timeout().unwrap();
    let g = play::read(&h.state()).unwrap();
    assert_eq!(g.holes, [[255, 255], [255, 255]]);
    assert!(h.lamports(&h.b.pubkey()) - b > h.lamports(&h.a.pubkey()) - a);
}
// A state both players can sign but the contract won't take can't be defended, and if it's the newest one the
// match can get stuck. So every state of every kind of hand has to be accepted, at every step.
const ALL_TRACES: [&str; 9] = [
    "riverBetMucked",
    "riverBetShown",
    "checkedDownMucked",
    "allInCalled",
    "smallBlindAllIn",
    "underSmallBlind",
    "bigBlindSameAsSmall",
    "underBothBlinds",
    "betweenTheBlinds",
];
#[test]
fn every_state_two_players_can_sign_can_be_posted() {
    let mut main = vec![vectors()["accept"].clone()];
    main.extend(vectors()["steps"].as_array().unwrap().iter().cloned());
    let mut posted = 0;
    for name in ALL_TRACES {
        let trace = &vectors()["traces"][name];
        let mut states = main.clone();
        if !trace["accept"].is_null() {
            states = vec![trace["accept"].clone()];
        }
        states.extend(trace["steps"].as_array().unwrap().iter().cloned());
        for state in &states {
            let mut h = H::joined();
            if let Err(error) = h.post_state(state) {
                panic!(
                    "{name}: the state at step {} was refused: {error:?}",
                    state["seq"]
                );
            }
            posted += 1;
        }
    }
    assert!(posted > 200, "only {posted} states were tried");
}
#[test]
fn a_player_all_in_from_a_blind_can_finish_the_hand_on_chain() {
    for name in [
        "smallBlindAllIn",
        "underSmallBlind",
        "bigBlindSameAsSmall",
        "underBothBlinds",
        "betweenTheBlinds",
    ] {
        let trace = &vectors()["traces"][name];
        let mut h = H::joined();
        h.post_state(&trace["accept"])
            .unwrap_or_else(|error| panic!("{name}: the first state was refused: {error:?}"));
        let window = h.window();
        h.at(window);
        let steps = trace["steps"].as_array().unwrap();
        for step in steps {
            h.apply(step).unwrap_or_else(|error| {
                panic!("{name}: the move at step {} failed: {error:?}", step["seq"])
            });
        }
        let state = h.state();
        assert_eq!(
            hex::encode(channel::blob(&state)),
            steps.last().unwrap()["blob"].as_str().unwrap(),
            "{name}: the contract reached the same state as the players"
        );
        assert_eq!(h.phase(), channel::EXIT, "{name}");
        let (a, b) = (h.lamports(&h.a.pubkey()), h.lamports(&h.b.pubkey()));
        h.timeout().unwrap();
        let final_stacks = &trace["final"];
        assert_eq!(
            h.lamports(&h.a.pubkey()) - a,
            final_stacks[0].as_u64().unwrap(),
            "{name}: seat 0's payout"
        );
        assert_eq!(
            h.lamports(&h.b.pubkey()) - b,
            final_stacks[1].as_u64().unwrap(),
            "{name}: seat 1's payout"
        );
    }
}
