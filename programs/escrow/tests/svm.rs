use agent_stacks_escrow::{key_context, proof, SPACE};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{path::PathBuf, process::Command};

type TxResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

const BUY_IN: u64 = 1_000_000;
const TERMS: [u8; 32] = [42; 32];
struct Harness {
    svm: LiteSVM,
    program: Address,
    a: Keypair,
    b: Keypair,
    stranger: Keypair,
    vault: Address,
    previous_share: Option<Vec<u8>>,
}
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}
fn vector(context: &str, secret: &str) -> Vec<u8> {
    let output = Command::new("node")
        .current_dir(root())
        .args(["scripts/proof-vector.js", context, secret])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    hex::decode(json["wireHex"].as_str().unwrap()).unwrap()
}
impl Harness {
    fn new() -> Self {
        Self::with_hands(1)
    }
    fn with_hands(max_hands: u32) -> Self {
        let mut svm = LiteSVM::new();
        let program = Address::new_unique();
        let path = root().join("target/deploy/agent_stacks_escrow.so");
        assert!(path.exists(), "Build SBF first: npm run solana:build");
        svm.add_program_from_file(program, path).unwrap();
        let a = Keypair::new();
        let b = Keypair::new();
        let stranger = Keypair::new();
        for key in [&a, &b, &stranger] {
            svm.airdrop(&key.pubkey(), 1_000_000_000).unwrap();
        }
        let nonce = [7; 32];
        let (vault, _) =
            Address::find_program_address(&[b"escrow", a.pubkey().as_ref(), &nonce], &program);
        let mut h = Self {
            svm,
            program,
            a,
            b,
            stranger,
            vault,
            previous_share: None,
        };
        let mut data = vec![1];
        data.extend(nonce);
        data.extend(BUY_IN.to_le_bytes());
        data.extend(30u32.to_le_bytes());
        data.extend(TERMS);
        data.extend(20_000u64.to_le_bytes());
        data.extend(max_hands.to_le_bytes());
        let accounts = vec![
            AccountMeta::new(h.a.pubkey(), true),
            AccountMeta::new_readonly(h.b.pubkey(), false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(Address::default(), false),
        ];
        let ix = Instruction {
            program_id: program,
            accounts,
            data,
        };
        send(&mut h.svm, &[&h.a], ix).unwrap();
        h
    }
    fn state(&self) -> Vec<u8> {
        self.svm.get_account(&self.vault).unwrap().data
    }
    fn version(&self) -> u64 {
        read_u64(&self.state(), 9)
    }
    fn data(&self, tag: u8) -> Vec<u8> {
        let mut data = vec![tag];
        data.extend(self.version().to_le_bytes());
        data
    }
    fn ix(&self, data: Vec<u8>, extra: Vec<AccountMeta>) -> Instruction {
        let mut accounts = vec![AccountMeta::new(self.vault, false)];
        accounts.extend(extra);
        Instruction {
            program_id: self.program,
            accounts,
            data,
        }
    }
    fn join(&mut self) {
        let mut data = self.data(2);
        data.extend(TERMS);
        let ix = self.ix(
            data,
            vec![
                AccountMeta::new(self.b.pubkey(), true),
                AccountMeta::new_readonly(Address::default(), false),
            ],
        );
        send(&mut self.svm, &[&self.b], ix).unwrap();
    }
    fn key(&mut self, seat: usize, secret: &str) -> TxResult {
        let context = key_context(
            &self.program,
            &self.vault,
            seat,
            &TERMS,
            agent_stacks_escrow::play::hand(&self.state()),
        );
        let mut data = self.data(3);
        data.extend(vector(&context, secret));
        let player = if seat == 0 { &self.a } else { &self.b };
        let ix = self.ix(data, vec![AccountMeta::new_readonly(player.pubkey(), true)]);
        send(&mut self.svm, &[player], ix)
    }
    fn deadline(&mut self) {
        let state = self.state();
        let deadline = i64::from_le_bytes(state[97..105].try_into().unwrap());
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = deadline;
        self.svm.set_sysvar(&clock);
    }
    fn timeout_ix(&self) -> Instruction {
        self.ix(
            self.data(5),
            vec![
                AccountMeta::new(self.a.pubkey(), false),
                AccountMeta::new(self.b.pubkey(), false),
            ],
        )
    }
}
fn send(svm: &mut LiteSVM, signers: &[&Keypair], ix: Instruction) -> TxResult {
    svm.expire_blockhash();
    let message = Message::new(&[ix], Some(&signers[0].pubkey()));
    let transaction = Transaction::new(signers, message, svm.latest_blockhash());
    svm.send_transaction(transaction).map_err(Box::new)
}
#[test]
fn javascript_proofs_execute_in_real_sbf_vm_and_reject_tampering() {
    let mut h = Harness::new();
    let wire = vector("agent-stacks/cross-language/test/v1", "1");
    proof::verify(&wire, Some("agent-stacks/cross-language/test/v1")).unwrap();
    let mut data = vec![0];
    data.extend(&wire);
    let ix = Instruction {
        program_id: h.program,
        accounts: vec![],
        data: data.clone(),
    };
    let meta = send(&mut h.svm, &[&h.stranger], ix).unwrap();
    println!("DLEQ SBF verification: {} CU", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < 200_000);
    *data.last_mut().unwrap() ^= 1;
    let invalid = Instruction {
        program_id: h.program,
        accounts: vec![],
        data,
    };
    assert!(send(&mut h.svm, &[&h.stranger], invalid).is_err());
    let mut malformed = vec![0];
    malformed.extend(&wire);
    malformed.push(0);
    assert!(send(
        &mut h.svm,
        &[&h.stranger],
        Instruction {
            program_id: h.program,
            accounts: vec![],
            data: malformed
        }
    )
    .is_err());
}
#[test]
fn deposits_key_registration_cooperative_settlement_and_close() {
    let mut h = Harness::new();
    let rent = h.svm.minimum_balance_for_rent_exemption(SPACE);
    assert_eq!(h.svm.get_account(&h.vault).unwrap().lamports, rent + BUY_IN);
    h.join();
    assert_eq!(
        h.svm.get_account(&h.vault).unwrap().lamports,
        rent + 2 * BUY_IN
    );
    let a = h.key(0, "1").unwrap();
    let b = h.key(1, "2").unwrap();
    println!(
        "Register key A/B: {}/{} CU",
        a.compute_units_consumed, b.compute_units_consumed
    );
    assert_eq!(h.state()[8], 3);
    assert_ne!(read_u64(&h.state(), 97), 0);
    // A now owes a shuffle; an early setup timeout must fail.
    let ix = h.timeout_ix();
    assert!(send(&mut h.svm, &[&h.stranger], ix).is_err());
    let mut data = h.data(4);
    data.extend(500_000u64.to_le_bytes());
    data.extend(1_500_000u64.to_le_bytes());
    let ix = h.ix(
        data.clone(),
        vec![
            AccountMeta::new(h.a.pubkey(), true),
            AccountMeta::new(h.b.pubkey(), false),
        ],
    );
    assert!(send(&mut h.svm, &[&h.a], ix).is_err());
    let b_before = h.svm.get_account(&h.b.pubkey()).unwrap().lamports;
    let ix = h.ix(
        data.clone(),
        vec![
            AccountMeta::new(h.a.pubkey(), true),
            AccountMeta::new(h.b.pubkey(), true),
        ],
    );
    send(&mut h.svm, &[&h.a, &h.b], ix).unwrap();
    assert_eq!(
        h.svm.get_account(&h.b.pubkey()).unwrap().lamports,
        b_before + 1_500_000
    );
    assert_eq!(h.svm.get_account(&h.vault).unwrap().lamports, rent);
    assert_eq!(h.state()[8], 6);
    let ix = h.ix(
        data,
        vec![
            AccountMeta::new(h.a.pubkey(), true),
            AccountMeta::new(h.b.pubkey(), true),
        ],
    );
    assert!(send(&mut h.svm, &[&h.a, &h.b], ix).is_err());
    let ix = h.ix(h.data(7), vec![AccountMeta::new(h.a.pubkey(), true)]);
    send(&mut h.svm, &[&h.a], ix).unwrap();
    let tombstone = h.svm.get_account(&h.vault).unwrap();
    assert_eq!(tombstone.owner, h.program);
    assert_eq!(tombstone.data, agent_stacks_escrow::CLOSED_MAGIC);
    assert_eq!(
        tombstone.lamports,
        h.svm.minimum_balance_for_rent_exemption(8)
    );
}

#[test]
fn closed_match_address_cannot_be_recreated_with_replayable_hand_contexts() {
    let mut h = Harness::new();
    let cancel = h.ix(h.data(6), vec![AccountMeta::new(h.a.pubkey(), true)]);
    send(&mut h.svm, &[&h.a], cancel).unwrap();
    let close = h.ix(h.data(7), vec![AccountMeta::new(h.a.pubkey(), true)]);
    send(&mut h.svm, &[&h.a], close).unwrap();
    let mut data = vec![1];
    data.extend([7; 32]);
    data.extend(BUY_IN.to_le_bytes());
    data.extend(30u32.to_le_bytes());
    data.extend(TERMS);
    data.extend(20_000u64.to_le_bytes());
    data.extend(1u32.to_le_bytes());
    let create = Instruction {
        program_id: h.program,
        data,
        accounts: vec![
            AccountMeta::new(h.a.pubkey(), true),
            AccountMeta::new_readonly(h.b.pubkey(), false),
            AccountMeta::new(h.vault, false),
            AccountMeta::new_readonly(Address::default(), false),
        ],
    };
    assert!(
        send(&mut h.svm, &[&h.a], create).is_err(),
        "A reused PDA reuses key/share/shuffle contexts and private agent caches"
    );
}

#[test]
fn empty_recipient_cannot_block_settlement_with_a_sub_rent_payout() {
    let mut h = Harness::new();
    h.join();
    // A can empty its wallet at any time, paying the transaction fee elsewhere.
    let mut transfer = 2u32.to_le_bytes().to_vec();
    transfer.extend(
        h.svm
            .get_account(&h.a.pubkey())
            .unwrap()
            .lamports
            .to_le_bytes(),
    );
    send(
        &mut h.svm,
        &[&h.stranger, &h.a],
        Instruction {
            program_id: Address::default(),
            accounts: vec![
                AccountMeta::new(h.a.pubkey(), true),
                AccountMeta::new(h.stranger.pubkey(), false),
            ],
            data: transfer,
        },
    )
    .unwrap();
    let mut data = h.data(4);
    data.extend(1u64.to_le_bytes());
    data.extend((2 * BUY_IN - 1).to_le_bytes());
    let ix = h.ix(
        data,
        vec![
            AccountMeta::new(h.a.pubkey(), true),
            AccountMeta::new(h.b.pubkey(), true),
        ],
    );
    let result = send(&mut h.svm, &[&h.stranger, &h.a, &h.b], ix);
    assert!(
        result.is_ok(),
        "A sub-rent credit to an empty wallet blocked settlement: {result:?}"
    );
    assert_eq!(h.state()[8], 6);
    assert_eq!(h.state()[agent_stacks_escrow::play::CURSOR], 1);
    let rent = h.svm.minimum_balance_for_rent_exemption(SPACE);
    assert_eq!(h.svm.get_account(&h.vault).unwrap().lamports, rent + 1);
    // Unclaimed money cannot be stolen through close or another player's claim.
    let close = h.ix(h.data(7), vec![AccountMeta::new(h.a.pubkey(), true)]);
    assert!(send(&mut h.svm, &[&h.stranger, &h.a], close).is_err());
    let mut data = h.data(20);
    data.push(0);
    let bad = h.ix(
        data.clone(),
        vec![
            AccountMeta::new_readonly(h.b.pubkey(), true),
            AccountMeta::new(h.stranger.pubkey(), false),
        ],
    );
    assert!(send(&mut h.svm, &[&h.b], bad).is_err());
    let failed = h.ix(
        data.clone(),
        vec![
            AccountMeta::new_readonly(h.a.pubkey(), true),
            AccountMeta::new(h.a.pubkey(), false),
        ],
    );
    assert!(send(&mut h.svm, &[&h.stranger, &h.a], failed).is_err());
    assert_eq!(h.state()[agent_stacks_escrow::play::CURSOR], 1);
    let claim = h.ix(
        data,
        vec![
            AccountMeta::new_readonly(h.a.pubkey(), true),
            AccountMeta::new(h.stranger.pubkey(), false),
        ],
    );
    send(&mut h.svm, &[&h.stranger, &h.a], claim).unwrap();
    assert_eq!(h.state()[agent_stacks_escrow::play::CURSOR], 0);
    assert_eq!(read_u64(&h.state(), 201), 1); // Retain the award receipt.
    assert_eq!(h.svm.get_account(&h.vault).unwrap().lamports, rent);
    let mut data = h.data(20);
    data.push(0);
    let again = h.ix(
        data,
        vec![
            AccountMeta::new_readonly(h.a.pubkey(), true),
            AccountMeta::new(h.stranger.pubkey(), false),
        ],
    );
    assert!(send(&mut h.svm, &[&h.stranger, &h.a], again).is_err());
}

#[test]
fn malformed_dispatch_never_mutates_escrow_or_panics() {
    let mut h = Harness::new();
    let before = h.state();
    let held = h.svm.get_account(&h.vault).unwrap().lamports;
    for tag in 0..=20 {
        for len in 0..8 {
            let mut data = vec![tag];
            data.extend(vec![0; len]);
            let ix = h.ix(
                data,
                vec![
                    AccountMeta::new(h.a.pubkey(), true),
                    AccountMeta::new(h.b.pubkey(), true),
                    AccountMeta::new_readonly(Address::default(), false),
                ],
            );
            let err = send(&mut h.svm, &[&h.stranger, &h.a, &h.b], ix).unwrap_err();
            assert!(
                !err.meta.logs.iter().any(|line| line.contains("panicked")),
                "{tag}/{len}: {:?}",
                err.meta.logs
            );
            assert_eq!(h.state(), before);
            assert_eq!(h.svm.get_account(&h.vault).unwrap().lamports, held);
        }
    }
    for tag in 21..=255 {
        let ix = h.ix(h.data(tag), vec![]);
        assert!(send(&mut h.svm, &[&h.stranger], ix).is_err());
        assert_eq!(h.state(), before);
    }
}

#[test]
fn an_uninitialized_proof_account_cannot_be_claimed_by_a_third_party() {
    let mut h = Harness::new();
    let pair = Keypair::new();
    let size = agent_stacks_escrow::shuffle::HEADER + 652325;
    h.svm.airdrop(&h.a.pubkey(), 10_000_000_000).unwrap();
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend(h.svm.minimum_balance_for_rent_exemption(size).to_le_bytes());
    data.extend((size as u64).to_le_bytes());
    data.extend(h.program.to_bytes());
    send(
        &mut h.svm,
        &[&h.a, &pair],
        Instruction {
            program_id: Address::default(),
            data,
            accounts: vec![
                AccountMeta::new(h.a.pubkey(), true),
                AccountMeta::new(pair.pubkey(), true),
            ],
        },
    )
    .unwrap();
    let mut data = vec![8];
    data.extend(652325u32.to_le_bytes());
    let attack = Instruction {
        program_id: h.program,
        data: data.clone(),
        accounts: vec![
            AccountMeta::new(pair.pubkey(), false),
            AccountMeta::new_readonly(h.stranger.pubkey(), true),
        ],
    };
    assert!(
        send(&mut h.svm, &[&h.stranger], attack).is_err(),
        "A third party claimed ownership of someone else's funded proof buffer"
    );
    let authorized = Instruction {
        program_id: h.program,
        data,
        accounts: vec![
            AccountMeta::new(pair.pubkey(), true),
            AccountMeta::new_readonly(h.a.pubkey(), true),
        ],
    };
    send(&mut h.svm, &[&h.a, &pair], authorized).unwrap();
}
#[test]
fn invitation_timeout_is_permissionless_at_exact_deadline_and_refunds_only_deposit() {
    let mut h = Harness::new();
    let before = h.state();
    let ix = h.timeout_ix();
    assert!(send(&mut h.svm, &[&h.stranger], ix).is_err());
    assert_eq!(h.state(), before);
    h.deadline();
    let a_before = h.svm.get_account(&h.a.pubkey()).unwrap().lamports;
    let b_before = h.svm.get_account(&h.b.pubkey()).unwrap().lamports;
    let ix = h.timeout_ix();
    send(&mut h.svm, &[&h.stranger], ix).unwrap();
    assert_eq!(
        h.svm.get_account(&h.a.pubkey()).unwrap().lamports,
        a_before + BUY_IN
    );
    assert_eq!(h.svm.get_account(&h.b.pubkey()).unwrap().lamports, b_before);
}
#[test]
fn both_key_setup_timeouts_assign_forfeit_to_obligated_player() {
    for seat in 0..2 {
        let mut h = Harness::new();
        h.join();
        if seat == 1 {
            h.key(0, "1").unwrap();
        }
        h.deadline();
        let winner = if seat == 0 {
            h.b.pubkey()
        } else {
            h.a.pubkey()
        };
        let before = h.svm.get_account(&winner).unwrap().lamports;
        let ix = h.timeout_ix();
        send(&mut h.svm, &[&h.stranger], ix).unwrap();
        assert_eq!(
            h.svm.get_account(&winner).unwrap().lamports,
            before + 2 * BUY_IN
        );
    }
}
#[test]
fn stale_versions_wrong_terms_unauthorized_cancel_and_account_substitution_fail_atomically() {
    let mut h = Harness::new();
    let before = h.state();
    let ix = h.ix(h.data(6), vec![AccountMeta::new(h.b.pubkey(), true)]);
    assert!(send(&mut h.svm, &[&h.b], ix).is_err());
    let mut data = h.data(2);
    data.extend([0u8; 32]);
    let ix = h.ix(
        data,
        vec![
            AccountMeta::new(h.b.pubkey(), true),
            AccountMeta::new_readonly(Address::default(), false),
        ],
    );
    assert!(send(&mut h.svm, &[&h.b], ix).is_err());
    let mut data = vec![6];
    data.extend(0u64.to_le_bytes());
    let ix = h.ix(data, vec![AccountMeta::new(h.a.pubkey(), true)]);
    assert!(send(&mut h.svm, &[&h.a], ix).is_err());
    let ix = h.ix(
        h.data(5),
        vec![
            AccountMeta::new(h.a.pubkey(), false),
            AccountMeta::new(h.stranger.pubkey(), false),
        ],
    );
    assert!(send(&mut h.svm, &[&h.stranger], ix).is_err());
    assert_eq!(h.state(), before);
    let ix = h.ix(h.data(6), vec![AccountMeta::new(h.a.pubkey(), true)]);
    send(&mut h.svm, &[&h.a], ix).unwrap();
    assert_eq!(h.state()[8], 6);
}
#[test]
fn expired_join_and_wrong_seat_key_fail_without_advancing_state() {
    let mut h = Harness::new();
    h.deadline();
    let mut data = h.data(2);
    data.extend(TERMS);
    let ix = h.ix(
        data,
        vec![
            AccountMeta::new(h.b.pubkey(), true),
            AccountMeta::new_readonly(Address::default(), false),
        ],
    );
    assert!(send(&mut h.svm, &[&h.b], ix).is_err());
    let mut h = Harness::new();
    h.join();
    let before = h.state();
    assert!(h.key(1, "2").is_err());
    assert_eq!(h.state(), before);
}
#[test]
fn canonical_but_canceling_key_is_rejected() {
    let mut h = Harness::new();
    h.join();
    h.key(0, "1").unwrap();
    let before = h.state();
    assert!(h
        .key(
            1,
            "7237005577332262213973186563042994240857116359379907606001950938285454250988"
        )
        .is_err());
    assert_eq!(h.state(), before);
}

#[test]
fn full_52_card_shuffle_uploads_seals_and_verifies_in_sbf() {
    use std::str::FromStr;
    let mut h = Harness::new();
    h.svm.airdrop(&h.a.pubkey(), 10_000_000_000).unwrap();
    let proof_keypair = Keypair::new();
    let proof_address = proof_keypair.pubkey();
    let file = std::env::temp_dir().join(format!("agent-stacks-shuffle-{proof_address}.bin"));
    let generated = Command::new("node")
        .current_dir(root())
        .arg("scripts/shuffle-vector.js")
        .arg(&file)
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let wire = std::fs::read(&file).unwrap();
    std::fs::remove_file(file).unwrap();
    let size = agent_stacks_escrow::shuffle::HEADER + wire.len();
    let rent = h.svm.minimum_balance_for_rent_exemption(size);
    let mut create = 0u32.to_le_bytes().to_vec();
    create.extend(rent.to_le_bytes());
    create.extend((size as u64).to_le_bytes());
    create.extend(h.program.to_bytes());
    let ix = Instruction {
        program_id: Address::default(),
        data: create,
        accounts: vec![
            AccountMeta::new(h.a.pubkey(), true),
            AccountMeta::new(proof_address, true),
        ],
    };
    send(&mut h.svm, &[&h.a, &proof_keypair], ix).unwrap();
    let proof_ix = |data: Vec<u8>, authority: Address| Instruction {
        program_id: h.program,
        data,
        accounts: vec![
            AccountMeta::new(proof_address, false),
            AccountMeta::new(authority, true),
        ],
    };
    let mut initialize = vec![8];
    initialize.extend((wire.len() as u32).to_le_bytes());
    let mut initialize_ix = proof_ix(initialize, h.a.pubkey());
    initialize_ix.accounts[0].is_signer = true;
    send(&mut h.svm, &[&h.a, &proof_keypair], initialize_ix).unwrap();
    let initial = h.svm.get_account(&proof_address).unwrap().data;
    let mut too_large = vec![9];
    too_large.extend(0u32.to_le_bytes());
    too_large.extend(vec![0; 1001]);
    assert!(send(&mut h.svm, &[&h.a], proof_ix(too_large, h.a.pubkey())).is_err());
    assert_eq!(h.svm.get_account(&proof_address).unwrap().data, initial);
    let mut upload_transactions = 0u64;
    let mut upload_cu = 0u64;
    for (chunk_index, chunk) in wire.chunks(1000).enumerate() {
        let mut data = vec![9];
        data.extend(((chunk_index * 1000) as u32).to_le_bytes());
        data.extend(chunk);
        let result = send(&mut h.svm, &[&h.a], proof_ix(data, h.a.pubkey())).unwrap();
        upload_cu += result.compute_units_consumed;
        upload_transactions += 1;
    }
    let before = h.svm.get_account(&proof_address).unwrap().data;
    let seal = proof_ix(vec![10], h.a.pubkey());
    assert!(send(
        &mut h.svm,
        &[&h.stranger],
        proof_ix(vec![10], h.stranger.pubkey())
    )
    .is_err());
    assert_eq!(h.svm.get_account(&proof_address).unwrap().data, before);
    let seal_meta = send_budgeted(&mut h.svm, &[&h.a], seal).unwrap();
    let mut overwrite = vec![9];
    overwrite.extend(0u32.to_le_bytes());
    overwrite.push(0);
    assert!(send(&mut h.svm, &[&h.a], proof_ix(overwrite, h.a.pubkey())).is_err());
    // This forged account models uploading the same commitments with a duplicate
    // permutation in round zero. Set-up bypasses 653 redundant upload transactions.
    let bad_address = Address::new_unique();
    let mut bad = h.svm.get_account(&proof_address).unwrap();
    let ctx = u16::from_le_bytes(wire[2..4].try_into().unwrap()) as usize;
    let first_opening =
        agent_stacks_escrow::shuffle::HEADER + 4 + ctx + 32 + 2 * 52 * 64 + 128 * 52 * 64;
    bad.data[first_opening] = bad.data[first_opening + 1];
    h.svm.set_account(bad_address, bad).unwrap();
    let mut data = vec![11];
    data.extend(0u16.to_le_bytes());
    data.push(1);
    let bad_ix = Instruction {
        program_id: h.program,
        data,
        accounts: vec![
            AccountMeta::new(bad_address, false),
            AccountMeta::new(h.a.pubkey(), true),
        ],
    };
    assert!(send_budgeted(&mut h.svm, &[&h.a], bad_ix).is_err());
    assert_eq!(
        h.svm.get_account(&bad_address).unwrap().data[49..51],
        [0, 0]
    );
    let mut verify_cu = 0u64;
    for round in (0u16..128).step_by(4) {
        let mut data = vec![11];
        data.extend(round.to_le_bytes());
        data.push(4);
        let meta = send_budgeted(&mut h.svm, &[&h.a], proof_ix(data, h.a.pubkey())).unwrap();
        verify_cu += meta.compute_units_consumed;
    }
    let account = h.svm.get_account(&proof_address).unwrap();
    assert_eq!(account.data[83], 1);
    assert_eq!(
        u16::from_le_bytes(account.data[49..51].try_into().unwrap()),
        128
    );
    let mut repeat = vec![11];
    repeat.extend(0u16.to_le_bytes());
    repeat.push(1);
    assert!(send_budgeted(&mut h.svm, &[&h.a], proof_ix(repeat, h.a.pubkey())).is_err());
    println!("FULL SHUFFLE: {} dense bytes, {} upload transactions / {} CU, seal {} CU, 32 verification transactions / {} CU, refundable rent {} lamports", wire.len(), upload_transactions, upload_cu, seal_meta.compute_units_consumed, verify_cu, rent);
    send(&mut h.svm, &[&h.a], proof_ix(vec![12], h.a.pubkey())).unwrap();
    assert!(h
        .svm
        .get_account(&proof_address)
        .is_none_or(|a| a.lamports == 0));
    // Keep address parsing exercised against the real Compute Budget program ID.
    assert_ne!(
        Address::from_str("ComputeBudget111111111111111111111111111111").unwrap(),
        Address::default()
    );
}
fn send_budgeted(svm: &mut LiteSVM, signers: &[&Keypair], ix: Instruction) -> TxResult {
    use std::str::FromStr;
    svm.expire_blockhash();
    let mut data = vec![2];
    data.extend(1_400_000u32.to_le_bytes());
    let budget = Instruction {
        program_id: Address::from_str("ComputeBudget111111111111111111111111111111").unwrap(),
        accounts: vec![],
        data,
    };
    let message = Message::new(&[budget, ix], Some(&signers[0].pubkey()));
    svm.send_transaction(Transaction::new(signers, message, svm.latest_blockhash()))
        .map_err(Box::new)
}

fn upload_verified(
    svm: &mut LiteSVM,
    program: Address,
    authority: &Keypair,
    wire: &[u8],
) -> Address {
    let pair = Keypair::new();
    let address = pair.pubkey();
    let space = agent_stacks_escrow::shuffle::HEADER + wire.len();
    let mut create = 0u32.to_le_bytes().to_vec();
    create.extend(svm.minimum_balance_for_rent_exemption(space).to_le_bytes());
    create.extend((space as u64).to_le_bytes());
    create.extend(program.to_bytes());
    send(
        svm,
        &[authority, &pair],
        Instruction {
            program_id: Address::default(),
            data: create,
            accounts: vec![
                AccountMeta::new(authority.pubkey(), true),
                AccountMeta::new(address, true),
            ],
        },
    )
    .unwrap();
    let ix = |data| Instruction {
        program_id: program,
        data,
        accounts: vec![
            AccountMeta::new(address, false),
            AccountMeta::new(authority.pubkey(), true),
        ],
    };
    let mut initialize = vec![8];
    initialize.extend((wire.len() as u32).to_le_bytes());
    let mut initialize_ix = ix(initialize);
    initialize_ix.accounts[0].is_signer = true;
    send(svm, &[authority, &pair], initialize_ix).unwrap();
    for (i, chunk) in wire.chunks(900).enumerate() {
        let mut data = vec![9];
        data.extend(((i * 900) as u32).to_le_bytes());
        data.extend(chunk);
        send(svm, &[authority], ix(data)).unwrap();
    }
    send_budgeted(svm, &[authority], ix(vec![10])).unwrap();
    for r in (0u16..128).step_by(4) {
        let mut data = vec![11];
        data.extend(r.to_le_bytes());
        data.push(4);
        send_budgeted(svm, &[authority], ix(data)).unwrap();
    }
    address
}

#[test]
fn two_hands_use_fresh_bound_shuffles_alternate_button_and_pay_only_at_match_end() {
    use agent_stacks_escrow::{shuffle_context, DECK_OFFSET};
    use solana_curve25519::ristretto::{add_ristretto, PodRistrettoPoint};
    let mut h = Harness::with_hands(2);
    h.join();
    for hand in 1..=2 {
        let vault_before = h.svm.get_account(&h.vault).unwrap().lamports;
        assert_eq!(agent_stacks_escrow::play::hand(&h.state()), hand);
        assert_eq!(
            agent_stacks_escrow::play::read(&h.state()).unwrap().button,
            (hand - 1) as u8
        );
        h.key(0, if hand == 1 { "1" } else { "3" }).unwrap();
        h.key(1, if hand == 1 { "2" } else { "4" }).unwrap();
        for key in [&h.a, &h.b] {
            h.svm.airdrop(&key.pubkey(), 10_000_000_000).unwrap();
        }
        assert_eq!(
            &h.state()[DECK_OFFSET..agent_stacks_escrow::play::DECK_END],
            &agent_stacks_escrow::cards::INITIAL_DECK
        );
        for seat in 0..2 {
            let state = h.state();
            let actor = if seat == 0 { &h.a } else { &h.b };
            let context = shuffle_context(
                &h.program,
                &h.vault,
                seat,
                &TERMS,
                agent_stacks_escrow::play::hand(&h.state()),
            );
            let joint = add_ristretto(
                &PodRistrettoPoint(state[137..169].try_into().unwrap()),
                &PodRistrettoPoint(state[169..201].try_into().unwrap()),
            )
            .unwrap();
            let base =
                std::env::temp_dir().join(format!("agent-stacks-binding-{}-{seat}", h.vault));
            let input = base.with_extension("input.bin");
            let output = base.with_extension("proof.bin");
            std::fs::write(
                &input,
                &state[DECK_OFFSET..agent_stacks_escrow::play::DECK_END],
            )
            .unwrap();
            let result = Command::new("node")
                .current_dir(root())
                .arg("scripts/shuffle-vector.js")
                .arg(&output)
                .arg(&context)
                .arg(hex::encode(joint.0))
                .arg(&input)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            let wire = std::fs::read(&output).unwrap();
            std::fs::remove_file(input).unwrap();
            std::fs::remove_file(output).unwrap();
            let proof = upload_verified(&mut h.svm, h.program, actor, &wire);
            // Uploading/verification does not reset the match's obligation deadline.
            let mut expired = h.svm.clone();
            let mut clock = expired.get_sysvar::<Clock>();
            clock.unix_timestamp = i64::from_le_bytes(state[97..105].try_into().unwrap());
            expired.set_sysvar(&clock);
            let winner = if seat == 0 {
                h.b.pubkey()
            } else {
                h.a.pubkey()
            };
            let before = expired.get_account(&winner).unwrap().lamports;
            send(&mut expired, &[&h.stranger], h.timeout_ix()).unwrap();
            assert_eq!(
                expired.get_account(&winner).unwrap().lamports,
                before + 2 * BUY_IN
            );

            let n = u16::from_le_bytes(wire[2..4].try_into().unwrap()) as usize;
            let output_start = 4 + n + 32 + 52 * 64;
            let expected = wire[output_start..output_start + 52 * 64].to_vec();
            let mut data = vec![13];
            data.extend(h.version().to_le_bytes());
            let ix = Instruction {
                program_id: h.program,
                data: data.clone(),
                accounts: vec![
                    AccountMeta::new(h.vault, false),
                    AccountMeta::new_readonly(actor.pubkey(), true),
                    AccountMeta::new_readonly(proof, false),
                ],
            };
            // A correctly verified proof with a different context cannot be consumed.
            // Fixture mutation isolates binding checks without repeating all upload/math work.
            let wrong = Address::new_unique();
            let mut account = h.svm.get_account(&proof).unwrap();
            account.data[agent_stacks_escrow::shuffle::HEADER + 4] ^= 1;
            h.svm.set_account(wrong, account).unwrap();
            let mut bad = ix.clone();
            bad.accounts[2] = AccountMeta::new_readonly(wrong, false);
            assert!(send(&mut h.svm, &[actor], bad).is_err());
            assert_eq!(h.state(), state);
            let meta = send(&mut h.svm, &[actor], ix.clone()).unwrap();
            println!(
                "Consume bound shuffle {seat}: {} CU",
                meta.compute_units_consumed
            );
            assert_eq!(
                &h.state()[DECK_OFFSET..agent_stacks_escrow::play::DECK_END],
                &expected
            );
            assert!(send(&mut h.svm, &[actor], ix).is_err()); // old version cannot advance twice
            let close = Instruction {
                program_id: h.program,
                data: vec![12],
                accounts: vec![
                    AccountMeta::new(proof, false),
                    AccountMeta::new(actor.pubkey(), true),
                ],
            };
            send(&mut h.svm, &[actor], close).unwrap();
            assert_eq!(
                &h.state()[DECK_OFFSET..agent_stacks_escrow::play::DECK_END],
                &expected
            );
        }
        assert_eq!(h.state()[8], 5);
        assert_ne!(read_u64(&h.state(), 97), 0);
        let claim = h.timeout_ix();
        assert!(send(&mut h.svm, &[&h.stranger], claim).is_err());
        play_to_showdown(&mut h);
        if hand == 1 {
            use agent_stacks_escrow::play;
            assert_eq!(h.state()[8], 1);
            assert_eq!(h.svm.get_account(&h.vault).unwrap().lamports, vault_before);
            assert_eq!(&h.state()[137..201], &[0; 64]);
            assert_eq!(&h.state()[play::SHARES_OFFSET..=play::CURSOR], &[0; 577]);
            assert_eq!(
                &h.state()[agent_stacks_escrow::DECK_OFFSET..play::DECK_END],
                &agent_stacks_escrow::cards::INITIAL_DECK
            );
            assert_eq!(&h.state()[201..217], &[0; 16]);
            // Refreshing expectedVersion does not make a previous-hand key proof valid.
            let old_context = key_context(&h.program, &h.vault, 0, &TERMS, 1);
            let mut data = h.data(3);
            data.extend(vector(&old_context, "1"));
            let before = h.state();
            let ix = h.ix(data, vec![AccountMeta::new_readonly(h.a.pubkey(), true)]);
            assert!(send(&mut h.svm, &[&h.a], ix).is_err());
            assert_eq!(h.state(), before);
        }
    }
}

fn play_to_showdown(h: &mut Harness) {
    use agent_stacks_escrow::{game, play};
    let mut checked = std::collections::BTreeSet::new();
    let mut messages = 0;
    let hand = play::hand(&h.state());
    let mut checked_fold = false;
    while h.state()[8] != 6 && play::hand(&h.state()) == hand {
        messages += 1;
        assert!(messages < 80);
        let state = h.state();
        let phase = state[8];
        let seat = play::actor(&state).unwrap();
        let g = play::read(&state).unwrap();
        if checked.insert((phase, seat, g.street)) {
            let mut fork = h.svm.clone();
            let mut clock = fork.get_sysvar::<Clock>();
            clock.unix_timestamp = i64::from_le_bytes(state[97..105].try_into().unwrap());
            fork.set_sysvar(&clock);
            let winner = if seat == 0 {
                h.b.pubkey()
            } else {
                h.a.pubkey()
            };
            let before = fork.get_account(&winner).unwrap().lamports;
            send(&mut fork, &[&h.stranger], h.timeout_ix()).unwrap();
            assert_eq!(
                fork.get_account(&winner).unwrap().lamports,
                before + 2 * BUY_IN
            );
        }
        let actor = if seat == 0 { &h.a } else { &h.b };
        if phase == play::BETTING && !checked_fold {
            checked_fold = true;
            let mut fork = h.svm.clone();
            let vault_before = fork.get_account(&h.vault).unwrap().lamports;
            let mut expected = g.clone();
            expected.act(seat as u8, 0, 0).unwrap();
            let mut fold = h.data(15);
            fold.push(0);
            fold.extend(0u64.to_le_bytes());
            let ix = h.ix(
                fold,
                vec![
                    AccountMeta::new_readonly(actor.pubkey(), true),
                    AccountMeta::new(h.a.pubkey(), false),
                    AccountMeta::new(h.b.pubkey(), false),
                ],
            );
            send_budgeted(&mut fork, &[&h.stranger, actor], ix).unwrap();
            let after = fork.get_account(&h.vault).unwrap();
            if hand < play::max_hands(&state) && !expected.stacks.contains(&0) {
                assert_eq!(after.data[8], 1);
                assert_eq!(play::hand(&after.data), hand + 1);
                assert_eq!(after.lamports, vault_before);
                let next = play::read(&after.data).unwrap();
                for s in 0..2 {
                    assert_eq!(next.stacks[s] + next.contributed[s], expected.stacks[s]);
                }
            } else {
                assert_eq!(after.data[8], 6);
                assert_eq!(after.lamports, vault_before - 2 * BUY_IN);
                assert_eq!(
                    [read_u64(&after.data, 201), read_u64(&after.data, 209)],
                    expected.stacks
                );
            }
        }
        let mut data;
        if phase == play::BETTING {
            data = h.data(15);
            let owed = g.current_bet.saturating_sub(g.bets[seat]);
            data.push(if owed == 0 { 1 } else { 2 });
            data.extend(0u64.to_le_bytes());
        } else {
            let positions = match phase {
                play::HOLE_B | play::SHOW_A => vec![0, 2],
                play::HOLE_A | play::SHOW_B => vec![1, 3],
                _ => match g.street {
                    1 => vec![4, 5, 6],
                    2 => vec![7],
                    3 => vec![8],
                    _ => panic!("wrong street"),
                },
            };
            let logical = positions[state[play::CURSOR] as usize];
            let context = play::share_context(
                &h.program,
                &h.vault,
                play::hand(&state),
                phase,
                seat,
                logical,
                &TERMS,
            );
            let physical = play::POSITIONS[logical];
            let base = hex::encode(
                &state[agent_stacks_escrow::DECK_OFFSET + physical * 64
                    ..agent_stacks_escrow::DECK_OFFSET + physical * 64 + 32],
            );
            let out = Command::new("node")
                .current_dir(root())
                .args([
                    "scripts/card-vector.js",
                    &context,
                    if hand == 1 {
                        if seat == 0 {
                            "1"
                        } else {
                            "2"
                        }
                    } else if seat == 0 {
                        "3"
                    } else {
                        "4"
                    },
                    &base,
                ])
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let wire = hex::decode(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
            data = h.data(14);
            data.push(logical as u8);
            data.extend(wire);
        }
        let accounts = vec![
            AccountMeta::new_readonly(actor.pubkey(), true),
            AccountMeta::new(h.a.pubkey(), false),
            AccountMeta::new(h.b.pubkey(), false),
        ];
        let ix = h.ix(data.clone(), accounts);
        if phase == play::HOLE_B && state[play::CURSOR] == 0 {
            if hand == 1 {
                h.previous_share = Some(data.clone());
            } else {
                let mut replay = ix.clone();
                replay.data = h.previous_share.clone().unwrap();
                replay.data[1..9].copy_from_slice(&h.version().to_le_bytes());
                assert!(send(&mut h.svm, &[&h.stranger, actor], replay).is_err());
                assert_eq!(h.state(), state);
            }
        }
        if data[0] == 14 {
            let mut bad = ix.clone();
            *bad.data.last_mut().unwrap() ^= 1;
            assert!(send(&mut h.svm, &[&h.stranger, actor], bad).is_err());
            assert_eq!(h.state(), state);
        }
        let meta = send_budgeted(&mut h.svm, &[&h.stranger, actor], ix).unwrap();
        if h.state()[8] == 6 {
            println!(
                "Automatic showdown payout: {} CU",
                meta.compute_units_consumed
            );
        }
        if matches!(
            h.state()[8],
            play::BETTING | play::BOARD_A | play::BOARD_B | play::HOLE_A | play::HOLE_B
        ) {
            assert_eq!(play::read(&h.state()).unwrap().holes, [[game::NONE; 2]; 2]);
        }
    }
    let state = h.state();
    if play::hand(&state) != hand {
        assert!(checked.contains(&(play::SHOW_B, 1, 3)));
        return;
    }
    let g = play::read(&state).unwrap();
    assert_eq!(g.stage, game::COMPLETE);
    assert_eq!(read_u64(&state, 201) + read_u64(&state, 209), 2 * BUY_IN);
    assert_eq!([read_u64(&state, 201), read_u64(&state, 209)], g.stacks);
    assert!(checked.contains(&(play::SHOW_B, 1, 3)));
    let ix = h.timeout_ix();
    assert!(send(&mut h.svm, &[&h.stranger], ix).is_err());
}

fn compact_buffer(h: &mut Harness, output: &[u8]) -> Address {
    use agent_stacks_escrow::compact;
    let pair = Keypair::new();
    let address = pair.pubkey();
    let mut create = 0u32.to_le_bytes().to_vec();
    create.extend(
        h.svm
            .minimum_balance_for_rent_exemption(compact::SPACE)
            .to_le_bytes(),
    );
    create.extend((compact::SPACE as u64).to_le_bytes());
    create.extend(h.program.to_bytes());
    let init = Instruction {
        program_id: Address::default(),
        data: create,
        accounts: vec![
            AccountMeta::new(h.a.pubkey(), true),
            AccountMeta::new(address, true),
        ],
    };
    send(&mut h.svm, &[&h.a, &pair], init).unwrap();
    let ix = Instruction {
        program_id: h.program,
        data: vec![16],
        accounts: vec![
            AccountMeta::new(address, true),
            AccountMeta::new_readonly(h.a.pubkey(), true),
            AccountMeta::new_readonly(h.vault, false),
        ],
    };
    let mut unsigned_init = ix.clone();
    unsigned_init.accounts[0].is_signer = false;
    assert!(send(&mut h.svm, &[&h.a], unsigned_init).is_err());
    send(&mut h.svm, &[&h.a, &pair], ix).unwrap();
    for (i, chunk) in output.chunks(1000).enumerate() {
        let mut data = vec![17];
        data.extend(((i * 1000) as u32).to_le_bytes());
        data.extend(chunk);
        send(
            &mut h.svm,
            &[&h.a],
            Instruction {
                program_id: h.program,
                data,
                accounts: vec![
                    AccountMeta::new(address, false),
                    AccountMeta::new_readonly(h.a.pubkey(), true),
                ],
            },
        )
        .unwrap();
    }
    address
}
#[test]
fn joint_deck_requires_both_signers_exact_hash_phase_hand_and_deadline() {
    use agent_stacks_escrow::{cards, compact, play, DECK_OFFSET};
    use solana_program::hash::hashv;
    let mut h = Harness::new();
    h.join();
    h.key(0, "1").unwrap();
    h.key(1, "2").unwrap();
    let state = h.state();
    let output = cards::INITIAL_DECK.to_vec();
    // The compact program accepts joint authorization, not a mathematical proof.
    // Agent-side tests require the actual full proof before producing signatures.
    let buffer = compact_buffer(&mut h, &output);
    assert_eq!(h.state(), state);
    let mut data = h.data(18);
    data.extend(hashv(&[&output]).to_bytes());
    let ix = h.ix(
        data,
        vec![
            AccountMeta::new_readonly(h.a.pubkey(), true),
            AccountMeta::new_readonly(h.b.pubkey(), true),
            AccountMeta::new_readonly(buffer, false),
        ],
    );
    let mut unsigned = ix.clone();
    unsigned.accounts[2].is_signer = false;
    assert!(send(&mut h.svm, &[&h.a], unsigned).is_err());
    assert_eq!(h.state(), state);
    let mut stranger = ix.clone();
    stranger.accounts[2] = AccountMeta::new_readonly(h.stranger.pubkey(), true);
    assert!(send(&mut h.svm, &[&h.a, &h.stranger], stranger).is_err());
    let mut hash = ix.clone();
    *hash.data.last_mut().unwrap() ^= 1;
    assert!(send(&mut h.svm, &[&h.a, &h.b], hash).is_err());
    assert_eq!(h.state(), state);
    // Mutation after signing cannot replace the committed output.
    let original = h.svm.get_account(&buffer).unwrap();
    let mut tampered = original.clone();
    tampered.data[compact::HEADER + 32] ^= 1;
    h.svm.set_account(buffer, tampered).unwrap();
    assert!(send(&mut h.svm, &[&h.a, &h.b], ix.clone()).is_err());
    h.svm.set_account(buffer, original.clone()).unwrap();
    let mut invalid = original.clone();
    invalid.data[compact::HEADER..compact::HEADER + 32].fill(255);
    let mut invalid_ix = ix.clone();
    invalid_ix.data[9..].copy_from_slice(&hashv(&[&invalid.data[compact::HEADER..]]).to_bytes());
    h.svm.set_account(buffer, invalid).unwrap();
    assert!(send(&mut h.svm, &[&h.a, &h.b], invalid_ix).is_err());
    h.svm.set_account(buffer, original.clone()).unwrap();
    let mut overwrite = vec![17];
    overwrite.extend(0u32.to_le_bytes());
    overwrite.push(0);
    assert!(send(
        &mut h.svm,
        &[&h.a],
        Instruction {
            program_id: h.program,
            data: overwrite,
            accounts: vec![
                AccountMeta::new(buffer, false),
                AccountMeta::new_readonly(h.a.pubkey(), true)
            ]
        }
    )
    .is_err());
    assert_eq!(h.svm.get_account(&buffer).unwrap().data, original.data);
    for at in [40, 72, 76, 77] {
        // match, hand, seat, completeness
        let mut bad = original.clone();
        bad.data[at] ^= 1;
        h.svm.set_account(buffer, bad).unwrap();
        assert!(send(&mut h.svm, &[&h.a, &h.b], ix.clone()).is_err());
        assert_eq!(h.state(), state);
    }
    h.svm.set_account(buffer, original.clone()).unwrap();
    // Uploads and unsigned offers cannot manufacture a new obligation/deadline.
    let mut expired = h.svm.clone();
    let mut clock = expired.get_sysvar::<Clock>();
    clock.unix_timestamp = read_u64(&state, 97) as i64;
    expired.set_sysvar(&clock);
    assert!(send(&mut expired, &[&h.a, &h.b], ix.clone()).is_err());
    send(&mut expired, &[&h.stranger], h.timeout_ix()).unwrap();
    assert_eq!(
        read_u64(&expired.get_account(&h.vault).unwrap().data, 209),
        2 * BUY_IN
    );
    // Refusing a receipt leaves the original unilateral verifier usable, even
    // with an uploaded compact buffer. No counterparty signature is necessary.
    let mut fallback = h.svm.clone();
    fallback.airdrop(&h.a.pubkey(), 10_000_000_000).unwrap();
    let context = agent_stacks_escrow::shuffle_context(&h.program, &h.vault, 0, &TERMS, 1);
    use solana_curve25519::ristretto::{add_ristretto, PodRistrettoPoint};
    let joint = add_ristretto(
        &PodRistrettoPoint(state[137..169].try_into().unwrap()),
        &PodRistrettoPoint(state[169..201].try_into().unwrap()),
    )
    .unwrap();
    let path = std::env::temp_dir().join(format!("agent-stacks-fallback-{}.bin", h.vault));
    let generated = Command::new("node")
        .current_dir(root())
        .arg("scripts/shuffle-vector.js")
        .arg(&path)
        .arg(&context)
        .arg(hex::encode(joint.0))
        .output()
        .unwrap();
    assert!(generated.status.success());
    let wire = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    let verified = upload_verified(&mut fallback, h.program, &h.a, &wire);
    assert_eq!(fallback.get_account(&h.vault).unwrap().data, state);
    let fallback_ix = h.ix(
        h.data(13),
        vec![
            AccountMeta::new_readonly(h.a.pubkey(), true),
            AccountMeta::new_readonly(verified, false),
        ],
    );
    send(&mut fallback, &[&h.a], fallback_ix).unwrap();
    assert_eq!(fallback.get_account(&h.vault).unwrap().data[8], 4);
    assert!(send(&mut fallback, &[&h.a, &h.b], ix.clone()).is_err());
    let meta = send(&mut h.svm, &[&h.a, &h.b], ix.clone()).unwrap();
    println!(
        "Joint deck acceptance: {} CU; unilateral fallback also passed",
        meta.compute_units_consumed
    );
    assert_eq!(h.state()[8], 4);
    assert_eq!(&h.state()[DECK_OFFSET..play::DECK_END], &output);
    assert!(send(&mut h.svm, &[&h.a, &h.b], ix).is_err());
    let before = h.svm.get_account(&h.a.pubkey()).unwrap().lamports;
    send(
        &mut h.svm,
        &[&h.stranger, &h.a],
        Instruction {
            program_id: h.program,
            data: vec![19],
            accounts: vec![
                AccountMeta::new(buffer, false),
                AccountMeta::new(h.a.pubkey(), true),
            ],
        },
    )
    .unwrap();
    assert_eq!(
        h.svm.get_account(&h.a.pubkey()).unwrap().lamports,
        before + original.lamports
    );
    assert_eq!(&h.state()[DECK_OFFSET..play::DECK_END], &output);
}
