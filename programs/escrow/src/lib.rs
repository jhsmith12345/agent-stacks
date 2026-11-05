//! Experimental multi-hand dealerless Hold'em, escrow, proofs and timeouts.
//! Research code for devnet testing only; never use real funds.
#![cfg_attr(feature = "channel-only", allow(dead_code, unused_imports))]
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
pub mod cards;
pub mod channel;
#[cfg(not(feature = "channel-only"))]
pub mod compact;
pub mod game;
pub mod play;
pub mod proof;
#[cfg(not(feature = "channel-only"))]
pub mod shuffle;
#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub const SPACE: usize = play::SPACE;
pub const DECK_OFFSET: usize = 250;
const MAGIC: &[u8; 8] = b"ASTKESC5";
pub const CLOSED_MAGIC: &[u8; 8] = b"ASTKEND5";
const SYSTEM: Pubkey = Pubkey::new_from_array([0; 32]);
const WAITING: u8 = 0;
const KEY_A: u8 = 1;
const KEY_B: u8 = 2;
const SHUFFLE_A: u8 = 3;
const SHUFFLE_B: u8 = 4;
const COMPLETE: u8 = 6;
fn fail() -> ProgramError {
    ProgramError::InvalidArgument
}
fn check(ok: bool) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(fail())
    }
}
fn u64_at(data: &[u8], n: usize) -> u64 {
    u64::from_le_bytes(data[n..n + 8].try_into().unwrap())
}
fn i64_at(data: &[u8], n: usize) -> i64 {
    i64::from_le_bytes(data[n..n + 8].try_into().unwrap())
}
fn key_at(data: &[u8], n: usize) -> Pubkey {
    Pubkey::new_from_array(data[n..n + 32].try_into().unwrap())
}
fn signer(a: &AccountInfo) -> ProgramResult {
    check(a.is_signer)
}
fn writable(a: &AccountInfo) -> ProgramResult {
    check(a.is_writable)
}
fn load(program: &Pubkey, account: &AccountInfo) -> Result<Vec<u8>, ProgramError> {
    check(account.owner == program && account.data_len() == SPACE)?;
    let data = account.try_borrow_data()?.to_vec();
    check(&data[..8] == MAGIC)?;
    let nonce: [u8; 32] = data[217..249].try_into().unwrap();
    let creator = key_at(&data, 17);
    let (expected, bump) =
        Pubkey::find_program_address(&[b"escrow", creator.as_ref(), &nonce], program);
    check(expected == *account.key && bump == data[249])?;
    Ok(data)
}
fn save(account: &AccountInfo, data: &mut [u8]) -> ProgramResult {
    writable(account)?;
    let version = u64_at(data, 9).checked_add(1).ok_or_else(fail)?;
    data[9..17].copy_from_slice(&version.to_le_bytes());
    account.try_borrow_mut_data()?.copy_from_slice(data);
    Ok(())
}
fn payout(vault: &AccountInfo, to: &AccountInfo, amount: u64) -> ProgramResult {
    writable(vault)?;
    writable(to)?;
    check(vault.key != to.key)?;
    let debit = vault.lamports().checked_sub(amount).ok_or_else(fail)?;
    let credit = to.lamports().checked_add(amount).ok_or_else(fail)?;
    **vault.try_borrow_mut_lamports()? = debit;
    **to.try_borrow_mut_lamports()? = credit;
    Ok(())
}
fn deposit<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    amount: u64,
) -> ProgramResult {
    check(*system.key == SYSTEM && from.owner == &SYSTEM && from.data_is_empty())?;
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend(amount.to_le_bytes());
    invoke_signed(
        &Instruction {
            program_id: SYSTEM,
            accounts: vec![
                AccountMeta::new(*from.key, true),
                AccountMeta::new(*to.key, false),
            ],
            data,
        },
        &[from.clone(), to.clone(), system.clone()],
        &[],
    )
}
pub fn key_context(
    program: &Pubkey,
    account: &Pubkey,
    seat: usize,
    terms: &[u8],
    hand: u32,
) -> String {
    let hex: String = terms.iter().map(|b| format!("{b:02x}")).collect();
    format!("agent-stacks/escrow/key/v2/{program}/{account}/{hand}/{seat}/{hex}")
}

pub fn shuffle_context(
    program: &Pubkey,
    account: &Pubkey,
    seat: usize,
    terms: &[u8],
    hand: u32,
) -> String {
    let hex: String = terms.iter().map(|b| format!("{b:02x}")).collect();
    format!("agent-stacks/escrow/shuffle/v3/{program}/{account}/{hand}/{seat}/{hex}")
}

#[cfg(feature = "channel-only")]
pub fn process_instruction(
    program: &Pubkey,
    accounts: &[AccountInfo],
    instruction: &[u8],
) -> ProgramResult {
    let (&tag, args) = instruction.split_first().ok_or_else(fail)?;
    check((30..=44).contains(&tag))?;
    channel::process(program, accounts, tag, args)
}
// Tags: 0 verify DLEQ, 1 create, 2 join, 3 register key, 4 cooperative
// settlement, 5 permissionless obligation timeout, 6 cancel invitation, 7 close,
// 8–12 proof-account lifecycle, 13 consume verified shuffle, 14 card share, 15 action,
// 16–19 joint shuffle buffers, 20 claim a deferred payout, 30–44 channel matches (see channel.rs).
#[cfg(not(feature = "channel-only"))]
pub fn process_instruction(
    program: &Pubkey,
    accounts: &[AccountInfo],
    instruction: &[u8],
) -> ProgramResult {
    let (&tag, args) = instruction.split_first().ok_or_else(fail)?;
    if tag == 0 {
        proof::verify(args, None)?;
        return Ok(());
    }
    if (30..=44).contains(&tag) {
        return channel::process(program, accounts, tag, args);
    }
    let mut it = accounts.iter();
    if (8..=12).contains(&tag) {
        let proof_account = next_account_info(&mut it)?;
        let authority = next_account_info(&mut it)?;
        return shuffle::process(program, proof_account, authority, tag, args);
    }
    if tag == 17 || tag == 19 {
        let buffer = next_account_info(&mut it)?;
        let actor = next_account_info(&mut it)?;
        return compact::process(program, buffer, actor, tag, args);
    }
    if tag == 16 {
        check(args.is_empty())?;
        let buffer = next_account_info(&mut it)?;
        let actor = next_account_info(&mut it)?;
        let vault = next_account_info(&mut it)?;
        let state = load(program, vault)?;
        check(Clock::get()?.unix_timestamp < i64_at(&state, 97))?;
        return compact::initialize(program, buffer, actor, vault.key, &state);
    }
    if tag == 1 {
        check(args.len() == 88)?;
        let creator = next_account_info(&mut it)?;
        let opponent = next_account_info(&mut it)?;
        let vault = next_account_info(&mut it)?;
        let system = next_account_info(&mut it)?;
        signer(creator)?;
        writable(creator)?;
        writable(vault)?;
        check(creator.key != opponent.key && *opponent.key != SYSTEM && *system.key == SYSTEM)?;
        check(creator.owner == &SYSTEM && creator.data_is_empty())?;
        let nonce = &args[..32];
        let buy_in = u64_at(args, 32);
        let seconds = u32::from_le_bytes(args[40..44].try_into().unwrap());
        let big_blind = u64_at(args, 76);
        let max_hands = u32::from_le_bytes(args[84..88].try_into().unwrap());
        check((1..=1000).contains(&max_hands))?;
        check(big_blind >= 2 && big_blind.is_multiple_of(2) && big_blind <= buy_in / 10)?;
        check(buy_in > 0 && buy_in <= 1_000_000_000_000 && (30..=259_200).contains(&seconds))?;
        let (expected, bump) =
            Pubkey::find_program_address(&[b"escrow", creator.key.as_ref(), nonce], program);
        check(*vault.key == expected && vault.owner == &SYSTEM && vault.data_is_empty())?;
        let rent = Rent::get()?.minimum_balance(SPACE);
        // Prefunded PDAs are deliberately rejected; nonce is caller-selected and can be changed.
        check(vault.lamports() == 0)?;
        let amount = rent.checked_add(buy_in).ok_or_else(fail)?;
        let mut data = 0u32.to_le_bytes().to_vec();
        data.extend(amount.to_le_bytes());
        data.extend((SPACE as u64).to_le_bytes());
        data.extend(program.to_bytes());
        invoke_signed(
            &Instruction {
                program_id: SYSTEM,
                accounts: vec![
                    AccountMeta::new(*creator.key, true),
                    AccountMeta::new(*vault.key, true),
                ],
                data,
            },
            &[creator.clone(), vault.clone(), system.clone()],
            &[&[b"escrow", creator.key.as_ref(), nonce, &[bump]]],
        )?;
        let mut state = vec![0u8; SPACE];
        state[..8].copy_from_slice(MAGIC);
        state[8] = WAITING;
        state[17..49].copy_from_slice(creator.key.as_ref());
        state[49..81].copy_from_slice(opponent.key.as_ref());
        state[81..89].copy_from_slice(&buy_in.to_le_bytes());
        state[89..97].copy_from_slice(&(seconds as i64).to_le_bytes());
        let deadline = Clock::get()?
            .unix_timestamp
            .checked_add(seconds as i64)
            .ok_or_else(fail)?;
        state[97..105].copy_from_slice(&deadline.to_le_bytes());
        state[105..137].copy_from_slice(&args[44..76]);
        state[217..249].copy_from_slice(nonce);
        state[249] = bump;
        state[play::HAND..play::MAX_HANDS].copy_from_slice(&1u32.to_le_bytes());
        state[play::MAX_HANDS..SPACE].copy_from_slice(&max_hands.to_le_bytes());
        state[DECK_OFFSET..play::DECK_END].copy_from_slice(&cards::INITIAL_DECK);
        state[play::BLIND_OFFSET..play::GAME_OFFSET].copy_from_slice(&big_blind.to_le_bytes());
        play::write(&mut state, &game::Game::new([buy_in; 2], big_blind, 0)?);
        return save(vault, &mut state);
    }
    let vault = next_account_info(&mut it)?;
    let mut state = load(program, vault)?;
    writable(vault)?;
    if tag == 20 {
        check(args.len() == 9 && state[8] == COMPLETE && u64_at(args, 0) == u64_at(&state, 9))?;
        let seat = args[8] as usize;
        check(seat < 2 && state[play::CURSOR] & (1 << seat) != 0)?;
        let player = next_account_info(&mut it)?;
        let destination = next_account_info(&mut it)?;
        signer(player)?;
        check(*player.key == key_at(&state, 17 + seat * 32))?;
        // Only the entitled player can choose another destination. A failed
        // credit rolls back without consuming the claim.
        payout(vault, destination, u64_at(&state, 201 + seat * 8))?;
        state[play::CURSOR] &= !(1 << seat);
        return save(vault, &mut state);
    }
    if tag == 7 {
        check(
            args.len() == 8
                && state[8] == COMPLETE
                && state[play::CURSOR] == 0
                && u64_at(args, 0) == u64_at(&state, 9),
        )?;
        let creator = next_account_info(&mut it)?;
        signer(creator)?;
        check(*creator.key == key_at(&state, 17))?;
        // Permanent, rent-exempt tombstone: recreating the same PDA would
        // recreate every cryptographic context and the agents' cache names.
        let retained = Rent::get()?.minimum_balance(CLOSED_MAGIC.len());
        payout(
            vault,
            creator,
            vault.lamports().checked_sub(retained).ok_or_else(fail)?,
        )?;
        vault.resize(CLOSED_MAGIC.len())?;
        vault.try_borrow_mut_data()?.copy_from_slice(CLOSED_MAGIC);
        return Ok(());
    }
    check(args.len() >= 8 && u64_at(args, 0) == u64_at(&state, 9) && state[8] != COMPLETE)?;
    let now = Clock::get()?.unix_timestamp;
    let buy_in = u64_at(&state, 81);
    match tag {
        2 => {
            check(
                args.len() == 40
                    && state[8] == WAITING
                    && now < i64_at(&state, 97)
                    && args[8..40] == state[105..137],
            )?;
            let opponent = next_account_info(&mut it)?;
            let system = next_account_info(&mut it)?;
            signer(opponent)?;
            check(*opponent.key == key_at(&state, 49))?;
            deposit(opponent, vault, system, buy_in)?;
            state[8] = KEY_A;
            let deadline = now.checked_add(i64_at(&state, 89)).ok_or_else(fail)?;
            state[97..105].copy_from_slice(&deadline.to_le_bytes());
        }
        3 => {
            check((state[8] == KEY_A || state[8] == KEY_B) && now < i64_at(&state, 97))?;
            let actor = next_account_info(&mut it)?;
            signer(actor)?;
            let seat = (state[8] - KEY_A) as usize;
            check(*actor.key == key_at(&state, 17 + seat * 32))?;
            let context = key_context(
                program,
                vault.key,
                seat,
                &state[105..137],
                play::hand(&state),
            );
            let key = proof::verify(&args[8..], Some(&context))?;
            let offset = 8 + 2 + context.len();
            check(
                args[offset + 32..offset + 64] == proof::BASE
                    && args[offset + 64..offset + 96] == key,
            )?;
            if seat == 1 {
                let first = solana_curve25519::ristretto::PodRistrettoPoint(
                    state[137..169].try_into().unwrap(),
                );
                let second = solana_curve25519::ristretto::PodRistrettoPoint(key);
                let joint = solana_curve25519::ristretto::add_ristretto(&first, &second)
                    .ok_or_else(fail)?;
                check(joint.0 != [0; 32])?;
            }
            state[137 + seat * 32..169 + seat * 32].copy_from_slice(&key);
            state[8] += 1;
            let deadline = now.checked_add(i64_at(&state, 89)).ok_or_else(fail)?;
            state[97..105].copy_from_slice(&deadline.to_le_bytes());
        }
        13 => {
            check(
                args.len() == 8
                    && [SHUFFLE_A, SHUFFLE_B].contains(&state[8])
                    && now < i64_at(&state, 97),
            )?;
            let actor = next_account_info(&mut it)?;
            signer(actor)?;
            let proof_account = next_account_info(&mut it)?;
            check(proof_account.key != vault.key)?;
            let seat = (state[8] - SHUFFLE_A) as usize;
            check(*actor.key == key_at(&state, 17 + seat * 32))?;
            let context = shuffle_context(
                program,
                vault.key,
                seat,
                &state[105..137],
                play::hand(&state),
            );
            let a = solana_curve25519::ristretto::PodRistrettoPoint(
                state[137..169].try_into().unwrap(),
            );
            let b = solana_curve25519::ristretto::PodRistrettoPoint(
                state[169..201].try_into().unwrap(),
            );
            let joint = solana_curve25519::ristretto::add_ristretto(&a, &b).ok_or_else(fail)?;
            let output = shuffle::verified_output(
                program,
                proof_account,
                actor.key,
                &context,
                &joint.0,
                &state[DECK_OFFSET..play::DECK_END],
            )?;
            state[DECK_OFFSET..play::DECK_END].copy_from_slice(&output);
            state[8] += 1;
            let deadline = now.checked_add(i64_at(&state, 89)).ok_or_else(fail)?;
            state[97..105].copy_from_slice(&deadline.to_le_bytes());
        }
        18 => {
            check(
                args.len() == 40
                    && [SHUFFLE_A, SHUFFLE_B].contains(&state[8])
                    && now < i64_at(&state, 97),
            )?;
            let actor = next_account_info(&mut it)?;
            let peer = next_account_info(&mut it)?;
            let buffer = next_account_info(&mut it)?;
            let output =
                compact::output(program, buffer, actor, peer, vault.key, &state, &args[8..])?;
            state[DECK_OFFSET..play::DECK_END].copy_from_slice(&output);
            state[8] += 1;
            let deadline = now.checked_add(i64_at(&state, 89)).ok_or_else(fail)?;
            state[97..105].copy_from_slice(&deadline.to_le_bytes());
            solana_program::msg!(
                "Jointly accepted shuffle; full proof verified by participants off-chain"
            );
        }
        14 | 15 => {
            check(now < i64_at(&state, 97))?;
            let actor = next_account_info(&mut it)?;
            signer(actor)?;
            let seat = play::actor(&state)?;
            check(*actor.key == key_at(&state, 17 + seat * 32))?;
            let a = next_account_info(&mut it)?;
            let b = next_account_info(&mut it)?;
            check(*a.key == key_at(&state, 17) && *b.key == key_at(&state, 49))?;
            if tag == 14 {
                play::share(program, vault.key, &mut state, seat, args)?;
            } else {
                check(args.len() == 17 && state[8] == play::BETTING)?;
                let mut g = play::read(&state)?;
                g.act(seat as u8, args[8], u64_at(args, 9))?;
                check(
                    g.stacks.iter().sum::<u64>() + g.contributed.iter().sum::<u64>() == buy_in * 2,
                )?;
                play::sync(&mut state, &g)?;
            }
            if state[8] == COMPLETE && !play::next_hand(&mut state)? {
                let g = play::read(&state)?;
                play::settle(&mut state, vault, a, b, g.stacks)?;
            } else {
                let deadline = now.checked_add(i64_at(&state, 89)).ok_or_else(fail)?;
                state[97..105].copy_from_slice(&deadline.to_le_bytes());
            }
        }
        4 => {
            check(
                args.len() == 24
                    && [
                        KEY_A,
                        KEY_B,
                        SHUFFLE_A,
                        SHUFFLE_B,
                        play::HOLE_B,
                        play::HOLE_A,
                        play::BETTING,
                        play::BOARD_A,
                        play::BOARD_B,
                        play::SHOW_A,
                        play::SHOW_B,
                    ]
                    .contains(&state[8]),
            )?;
            let a = next_account_info(&mut it)?;
            let b = next_account_info(&mut it)?;
            signer(a)?;
            signer(b)?;
            check(*a.key == key_at(&state, 17) && *b.key == key_at(&state, 49))?;
            let p0 = u64_at(args, 8);
            let p1 = u64_at(args, 16);
            check(p0.checked_add(p1) == buy_in.checked_mul(2))?;
            play::settle(&mut state, vault, a, b, [p0, p1])?;
        }
        5 => {
            check(
                args.len() == 8
                    && (state[8] == WAITING || play::actor(&state).is_ok())
                    && now >= i64_at(&state, 97),
            )?;
            let a = next_account_info(&mut it)?;
            let b = next_account_info(&mut it)?;
            check(*a.key == key_at(&state, 17) && *b.key == key_at(&state, 49))?;
            let payouts = if state[8] == WAITING {
                [buy_in, 0]
            } else if play::actor(&state)? == 0 {
                [0, buy_in * 2]
            } else {
                [buy_in * 2, 0]
            };
            play::settle(&mut state, vault, a, b, payouts)?;
        }
        6 => {
            check(args.len() == 8 && state[8] == WAITING)?;
            let creator = next_account_info(&mut it)?;
            signer(creator)?;
            check(*creator.key == key_at(&state, 17))?;
            // Invitation refund has no other participant to block. If the
            // destination was emptied, preserve a claim instead of failing.
            state[play::CURSOR] = 0;
            play::deliver_or_defer(&mut state, vault, creator, 0, buy_in)?;
            state[201..209].copy_from_slice(&buy_in.to_le_bytes());
            state[8] = COMPLETE;
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    }
    save(vault, &mut state)
}
