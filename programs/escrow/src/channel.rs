//! Off-chain play with an on-chain court. Agents play through signed states; this
//! program holds deposits, pays out and settles disputes. See docs/channel-design.md.
//! Channel accounts have their own magic, seed and size, so the older instructions
//! cannot touch them, and these instructions cannot touch older matches.
#![allow(deprecated)] // The sysvar helpers below are only deprecated re-exports in this SDK.
use crate::{
    check, deposit, fail, game, i64_at, key_at, payout, play, save, signer, u64_at, writable,
    CLOSED_MAGIC, DECK_OFFSET, SYSTEM,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::{
        instructions::{load_current_index_checked, load_instruction_at_checked},
        Sysvar,
    },
};
pub const MAGIC: &[u8; 8] = b"ASTKCHN1";
pub const SESSIONS: usize = play::SPACE;
pub const SEQ: usize = SESSIONS + 64;
pub const WINDOW: usize = SEQ + 8;
pub const SPACE: usize = WINDOW + 8;
pub const WAITING: u8 = 0;
pub const COMPLETE: u8 = 6;
pub const OPEN: u8 = 20;
pub const EXIT: u8 = 21;
pub const BLOB: usize = 1311;
pub const KIND_STACKS: u8 = 1;
pub const KIND_CLOSE: u8 = 2;
pub const KIND_HAND: u8 = 3;
pub const BUFFER_HEADER: usize = 76;
pub const BUFFER_SPACE: usize = BUFFER_HEADER + BLOB;
const BUFFER_MAGIC: &[u8; 8] = b"ASTKCHB1";
const DOMAIN: &[u8] = b"agent-stacks/channel/v1";
// Ed25519SigVerify111111111111111111111111111
const ED25519: Pubkey = Pubkey::new_from_array([
    0x03, 0x7d, 0x46, 0xd6, 0x7c, 0x93, 0xfb, 0xbe, 0x12, 0xf9, 0x42, 0x8f, 0x83, 0x8d, 0x40, 0xff,
    0x05, 0x70, 0x74, 0x49, 0x27, 0xf4, 0x8a, 0x64, 0xfc, 0xca, 0x70, 0x44, 0x80, 0x00, 0x00, 0x00,
]);
fn session(state: &[u8], seat: usize) -> [u8; 32] {
    state[SESSIONS + seat * 32..SESSIONS + seat * 32 + 32]
        .try_into()
        .unwrap()
}
fn set_i64(state: &mut [u8], at: usize, value: i64) {
    state[at..at + 8].copy_from_slice(&value.to_le_bytes());
}
fn load(program: &Pubkey, account: &AccountInfo) -> Result<Vec<u8>, ProgramError> {
    check(account.owner == program && account.data_len() == SPACE)?;
    let data = account.try_borrow_data()?.to_vec();
    check(&data[..8] == MAGIC)?;
    let nonce: [u8; 32] = data[217..249].try_into().unwrap();
    let creator = key_at(&data, 17);
    let (expected, bump) =
        Pubkey::find_program_address(&[b"channel", creator.as_ref(), &nonce], program);
    check(expected == *account.key && bump == data[249])?;
    Ok(data)
}
/// The 32 bytes both session keys sign. It binds a state to this match, its terms and one step.
pub fn message(
    program: &Pubkey,
    vault: &Pubkey,
    terms: &[u8],
    kind: u8,
    seq: u64,
    payload_hash: &[u8],
) -> [u8; 32] {
    hashv(&[
        DOMAIN,
        program.as_ref(),
        vault.as_ref(),
        terms,
        &[kind],
        &seq.to_le_bytes(),
        payload_hash,
    ])
    .to_bytes()
}
/// Computed here from what the account really stores, never taken from the creator. A joiner sends the
/// same hash computed from the terms it accepted, so a creator can't store a different session key or
/// stake behind its back. The genesis hash isn't checkable on chain, but a wrong one fails the same way.
#[allow(clippy::too_many_arguments)]
pub fn terms_hash(
    program: &Pubkey,
    creator: &[u8],
    opponent: &[u8],
    genesis: &[u8],
    buy_in: u64,
    seconds: u32,
    big_blind: u64,
    max_hands: u32,
    sessions: &[u8],
) -> [u8; 32] {
    hashv(&[
        b"agent-stacks/channel/terms/v1",
        program.as_ref(),
        creator,
        opponent,
        genesis,
        &buy_in.to_le_bytes(),
        &seconds.to_le_bytes(),
        &big_blind.to_le_bytes(),
        &max_hands.to_le_bytes(),
        sessions,
    ])
    .to_bytes()
}
/// The hand state exactly as agents hash it. Only the cards that can ever be revealed are in it.
pub fn blob(state: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(BLOB);
    out.push(if state[8] == EXIT { COMPLETE } else { state[8] });
    out.push(state[play::CURSOR]);
    out.extend_from_slice(&state[play::HAND..play::MAX_HANDS]);
    out.extend_from_slice(&state[137..201]);
    for position in play::POSITIONS {
        out.extend_from_slice(
            &state[DECK_OFFSET + position * 64..DECK_OFFSET + position * 64 + 64],
        );
    }
    out.extend_from_slice(&state[play::GAME_OFFSET..play::SHARES_OFFSET]);
    out.extend_from_slice(&state[play::SHARES_OFFSET..play::CURSOR]);
    out
}
/// The runtime verifies an Ed25519 instruction itself, or the whole transaction fails. This confirms
/// that the instruction covers exactly these keys and messages, with every offset inside it, so bytes
/// in some other instruction can't stand in for them.
pub fn covers(
    program_id: &Pubkey,
    has_accounts: bool,
    d: &[u8],
    expected: &[([u8; 32], [u8; 32])],
) -> bool {
    if *program_id != ED25519 || has_accounts {
        return false;
    }
    if d.len() < 2 + expected.len() * 14 || d[0] as usize != expected.len() {
        return false;
    }
    expected.iter().enumerate().all(|(i, (key, signed))| {
        let entry = 2 + i * 14;
        let field =
            |n: usize| u16::from_le_bytes(d[entry + n..entry + n + 2].try_into().unwrap()) as usize;
        field(2) == 0xffff
            && field(6) == 0xffff
            && field(12) == 0xffff
            && field(10) == 32
            && d.get(field(4)..field(4) + 32) == Some(key.as_slice())
            && d.get(field(8)..field(8) + 32) == Some(signed.as_slice())
    })
}
fn require_signed(sysvar: &AccountInfo, expected: &[([u8; 32], [u8; 32])]) -> ProgramResult {
    let current = load_current_index_checked(sysvar)? as usize;
    check(current > 0)?;
    let instruction = load_instruction_at_checked(current - 1, sysvar)?;
    check(covers(
        &instruction.program_id,
        !instruction.accounts.is_empty(),
        &instruction.data,
        expected,
    ))
}
fn settled_game(stacks: [u64; 2], big_blind: u64) -> game::Game {
    game::Game {
        stacks,
        bets: [0; 2],
        contributed: [0; 2],
        current_bet: 0,
        min_raise: big_blind,
        big_blind,
        actor: game::NONE,
        pending: 0,
        acted: 0,
        street: 0,
        stage: game::COMPLETE,
        button: 0,
        winner: game::NONE,
        reason: game::NONE,
        board: [game::NONE; 5],
        holes: [[game::NONE; 2]; 2],
    }
}
fn conserved(state: &[u8], stacks: [u64; 2]) -> ProgramResult {
    check(stacks[0].checked_add(stacks[1]) == u64_at(state, 81).checked_mul(2))
}
fn player_seat(state: &[u8], key: &Pubkey) -> Option<usize> {
    (0..2).find(|&seat| {
        *key == key_at(state, 17 + seat * 32) || key.to_bytes() == session(state, seat)
    })
}
// A post is allowed until the challenge window closes, and only with a newer state. After the window
// no state can be posted again, which is what stops a player replaying a withheld state after a card
// has been revealed on chain.
fn check_can_post(state: &[u8], now: i64, seq: u64) -> ProgramResult {
    check(![WAITING, COMPLETE].contains(&state[8]) && seq > u64_at(state, SEQ))?;
    check(state[8] == OPEN || now < i64_at(state, WINDOW))
}
fn open_window(state: &mut [u8], now: i64, exit: bool) -> ProgramResult {
    let seconds = i64_at(state, 89);
    let window = now.checked_add(seconds).ok_or_else(fail)?;
    set_i64(state, WINDOW, window);
    let deadline = if exit {
        window
    } else {
        window.checked_add(seconds).ok_or_else(fail)?
    };
    set_i64(state, 97, deadline);
    Ok(())
}
fn create<'a, 'b>(
    program: &Pubkey,
    it: &mut core::slice::Iter<'a, AccountInfo<'b>>,
    args: &[u8],
) -> ProgramResult {
    check(args.len() == 152)?;
    let creator = next_account_info(it)?;
    let opponent = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let system = next_account_info(it)?;
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
    check(
        args[88..120] != args[120..152] && args[88..120] != [0; 32] && args[120..152] != [0; 32],
    )?;
    let (expected, bump) =
        Pubkey::find_program_address(&[b"channel", creator.key.as_ref(), nonce], program);
    check(*vault.key == expected && vault.owner == &SYSTEM && vault.data_is_empty())?;
    check(vault.lamports() == 0)?;
    let rent = Rent::get()?.minimum_balance(SPACE);
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
        &[&[b"channel", creator.key.as_ref(), nonce, &[bump]]],
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
    set_i64(&mut state, 97, deadline);
    state[105..137].copy_from_slice(&terms_hash(
        program,
        creator.key.as_ref(),
        opponent.key.as_ref(),
        &args[44..76],
        buy_in,
        seconds,
        big_blind,
        max_hands,
        &args[88..152],
    ));
    state[217..249].copy_from_slice(nonce);
    state[249] = bump;
    state[play::HAND..play::MAX_HANDS].copy_from_slice(&1u32.to_le_bytes());
    state[play::MAX_HANDS..play::SPACE].copy_from_slice(&max_hands.to_le_bytes());
    state[play::BLIND_OFFSET..play::GAME_OFFSET].copy_from_slice(&big_blind.to_le_bytes());
    state[SESSIONS..SESSIONS + 64].copy_from_slice(&args[88..152]);
    play::write(&mut state, &settled_game([buy_in; 2], big_blind));
    save(vault, &mut state)
}
fn buffer<'a, 'b>(
    program: &Pubkey,
    it: &mut core::slice::Iter<'a, AccountInfo<'b>>,
    tag: u8,
    args: &[u8],
) -> ProgramResult {
    let buffer = next_account_info(it)?;
    let authority = next_account_info(it)?;
    check(buffer.owner == program && buffer.data_len() == BUFFER_SPACE && buffer.is_writable)?;
    check(authority.is_signer && buffer.key != authority.key)?;
    if tag == 35 {
        let vault = next_account_info(it)?;
        check(args.is_empty() && buffer.is_signer)?;
        load(program, vault)?;
        let mut data = buffer.try_borrow_mut_data()?;
        check(data.iter().all(|x| *x == 0))?;
        data[..8].copy_from_slice(BUFFER_MAGIC);
        data[8..40].copy_from_slice(authority.key.as_ref());
        data[40..72].copy_from_slice(vault.key.as_ref());
        return Ok(());
    }
    {
        let data = buffer.try_borrow_data()?;
        check(&data[..8] == BUFFER_MAGIC && data[8..40] == authority.key.to_bytes())?;
    }
    if tag == 37 {
        check(args.is_empty() && authority.is_writable)?;
        let total = authority
            .lamports()
            .checked_add(buffer.lamports())
            .ok_or_else(fail)?;
        **buffer.try_borrow_mut_lamports()? = 0;
        **authority.try_borrow_mut_lamports()? = total;
        buffer.resize(0)?;
        buffer.assign(&Pubkey::default());
        return Ok(());
    }
    check(args.len() > 4 && args.len() <= 1004)?;
    let offset = u32::from_le_bytes(args[..4].try_into().unwrap()) as usize;
    let len = args.len() - 4;
    let mut data = buffer.try_borrow_mut_data()?;
    let written = u32::from_le_bytes(data[72..76].try_into().unwrap()) as usize;
    check(offset == written && offset.checked_add(len).is_some_and(|end| end <= BLOB))?;
    data[BUFFER_HEADER + offset..BUFFER_HEADER + offset + len].copy_from_slice(&args[4..]);
    data[72..76].copy_from_slice(&((offset + len) as u32).to_le_bytes());
    Ok(())
}
fn load_hand(state: &mut [u8], payload: &[u8]) -> Result<bool, ProgramError> {
    check(payload.len() == BLOB)?;
    let phase = payload[0];
    check([5, 6, 7, 8, 9, 10, 11, 12].contains(&phase) && payload[1] < 3)?;
    let hand = u32::from_le_bytes(payload[2..6].try_into().unwrap());
    check(hand >= 1 && hand <= play::max_hands(state))?;
    state[play::CURSOR] = payload[1];
    state[play::HAND..play::MAX_HANDS].copy_from_slice(&payload[2..6]);
    state[137..201].copy_from_slice(&payload[6..70]);
    for (i, position) in play::POSITIONS.iter().enumerate() {
        state[DECK_OFFSET + position * 64..DECK_OFFSET + position * 64 + 64]
            .copy_from_slice(&payload[70 + i * 64..134 + i * 64]);
    }
    state[play::GAME_OFFSET..play::SHARES_OFFSET].copy_from_slice(&payload[646..735]);
    state[play::SHARES_OFFSET..play::CURSOR].copy_from_slice(&payload[735..BLOB]);
    let g = play::read(state)?;
    check(g.big_blind == u64_at(state, play::BLIND_OFFSET))?;
    let total = g.stacks[0]
        .checked_add(g.stacks[1])
        .and_then(|n| n.checked_add(g.contributed[0]))
        .and_then(|n| n.checked_add(g.contributed[1]));
    check(total == u64_at(state, 81).checked_mul(2))?;
    let stage_matches = match phase {
        6 => g.stage == game::COMPLETE,
        5 | 7 | 8 => g.stage == game::BETTING,
        9 | 10 => g.stage == game::BOARD,
        _ => g.stage == game::SHOWDOWN,
    };
    check(stage_matches)?;
    state[8] = if phase == 6 { EXIT } else { phase };
    Ok(phase == 6)
}
pub fn process(program: &Pubkey, accounts: &[AccountInfo], tag: u8, args: &[u8]) -> ProgramResult {
    let mut it = accounts.iter();
    if tag == 30 {
        return create(program, &mut it, args);
    }
    if (35..=37).contains(&tag) {
        return buffer(program, &mut it, tag, args);
    }
    let vault = next_account_info(&mut it)?;
    let mut state = load(program, vault)?;
    writable(vault)?;
    let now = Clock::get()?.unix_timestamp;
    let buy_in = u64_at(&state, 81);
    let terms: [u8; 32] = state[105..137].try_into().unwrap();
    match tag {
        31 => {
            check(args.len() == 32 && args == terms && state[8] == WAITING)?;
            check(now < i64_at(&state, 97))?;
            let opponent = next_account_info(&mut it)?;
            let system = next_account_info(&mut it)?;
            signer(opponent)?;
            check(*opponent.key == key_at(&state, 49))?;
            deposit(opponent, vault, system, buy_in)?;
            state[8] = OPEN;
            set_i64(&mut state, 97, 0);
        }
        32 => {
            check(args.is_empty() && state[8] == WAITING)?;
            let creator = next_account_info(&mut it)?;
            signer(creator)?;
            check(*creator.key == key_at(&state, 17))?;
            state[play::CURSOR] = 0;
            play::deliver_or_defer(&mut state, vault, creator, 0, buy_in)?;
            state[201..209].copy_from_slice(&buy_in.to_le_bytes());
            state[8] = COMPLETE;
        }
        33 => {
            // A jointly signed close ends the match at once, even during a dispute.
            check(args.len() == 24 && ![WAITING, COMPLETE].contains(&state[8]))?;
            let seq = u64_at(args, 0);
            check(seq > u64_at(&state, SEQ))?;
            let stacks = [u64_at(args, 8), u64_at(args, 16)];
            conserved(&state, stacks)?;
            let a = next_account_info(&mut it)?;
            let b = next_account_info(&mut it)?;
            let sysvar = next_account_info(&mut it)?;
            let signed = message(
                program,
                vault.key,
                &terms,
                KIND_CLOSE,
                seq,
                &hashv(&[&args[8..24]]).to_bytes(),
            );
            require_signed(
                sysvar,
                &[(session(&state, 0), signed), (session(&state, 1), signed)],
            )?;
            state[SEQ..SEQ + 8].copy_from_slice(&seq.to_le_bytes());
            play::settle(&mut state, vault, a, b, stacks)?;
        }
        34 => {
            check(args.len() == 28)?;
            let seq = u64_at(args, 0);
            let poster = next_account_info(&mut it)?;
            signer(poster)?;
            check(player_seat(&state, poster.key).is_some())?;
            let stacks = [u64_at(args, 12), u64_at(args, 20)];
            conserved(&state, stacks)?;
            let hand = u32::from_le_bytes(args[8..12].try_into().unwrap());
            if seq == 0 {
                // Nothing has been signed yet, so the only state is the original deposits.
                check(
                    state[8] == OPEN
                        && u64_at(&state, SEQ) == 0
                        && hand == 1
                        && stacks == [buy_in; 2],
                )?;
            } else {
                check_can_post(&state, now, seq)?;
                check(hand >= 1 && hand <= play::max_hands(&state) + 1)?;
                let sysvar = next_account_info(&mut it)?;
                let signed = message(
                    program,
                    vault.key,
                    &terms,
                    KIND_STACKS,
                    seq,
                    &hashv(&[&args[8..28]]).to_bytes(),
                );
                require_signed(
                    sysvar,
                    &[(session(&state, 0), signed), (session(&state, 1), signed)],
                )?;
            }
            let big_blind = u64_at(&state, play::BLIND_OFFSET);
            play::write(&mut state, &settled_game(stacks, big_blind));
            state[SEQ..SEQ + 8].copy_from_slice(&seq.to_le_bytes());
            state[8] = EXIT;
            open_window(&mut state, now, true)?;
        }
        38 => {
            check(args.len() == 8)?;
            let seq = u64_at(args, 0);
            check_can_post(&state, now, seq)?;
            let poster = next_account_info(&mut it)?;
            let holder = next_account_info(&mut it)?;
            let sysvar = next_account_info(&mut it)?;
            signer(poster)?;
            check(player_seat(&state, poster.key).is_some())?;
            check(
                holder.owner == program
                    && holder.key != vault.key
                    && holder.data_len() == BUFFER_SPACE,
            )?;
            let data = holder.try_borrow_data()?;
            check(
                &data[..8] == BUFFER_MAGIC
                    && data[8..40] == poster.key.to_bytes()
                    && data[40..72] == vault.key.to_bytes()
                    && data[72..76] == (BLOB as u32).to_le_bytes(),
            )?;
            let payload = &data[BUFFER_HEADER..];
            let signed = message(
                program,
                vault.key,
                &terms,
                KIND_HAND,
                seq,
                &hashv(&[payload]).to_bytes(),
            );
            require_signed(
                sysvar,
                &[(session(&state, 0), signed), (session(&state, 1), signed)],
            )?;
            let exit = load_hand(&mut state, payload)?;
            state[SEQ..SEQ + 8].copy_from_slice(&seq.to_le_bytes());
            open_window(&mut state, now, exit)?;
        }
        39 | 40 => {
            check(args.len() >= 8 && u64_at(args, 0) == u64_at(&state, SEQ))?;
            check(now >= i64_at(&state, WINDOW) && now < i64_at(&state, 97))?;
            let seat = play::actor(&state)?;
            let actor = next_account_info(&mut it)?;
            let sysvar = next_account_info(&mut it)?;
            signer(actor)?;
            check(player_seat(&state, actor.key) == Some(seat))?;
            if tag == 40 {
                play::share(program, vault.key, &mut state, seat, args)?;
            } else {
                check(args.len() == 17 && state[8] == play::BETTING)?;
                let mut g = play::read(&state)?;
                g.act(seat as u8, args[8], u64_at(args, 9))?;
                let total = g.stacks[0] + g.stacks[1] + g.contributed[0] + g.contributed[1];
                check(total == buy_in * 2)?;
                play::sync(&mut state, &g)?;
            }
            // The mover signs the state this produced, so its on-chain move binds it exactly as an
            // off-chain one would. An opponent can verify that without trusting whoever relayed it.
            let seq = u64_at(&state, SEQ).checked_add(1).ok_or_else(fail)?;
            let signed = message(
                program,
                vault.key,
                &terms,
                KIND_HAND,
                seq,
                &hashv(&[&blob(&state)]).to_bytes(),
            );
            require_signed(sysvar, &[(session(&state, seat), signed)])?;
            state[SEQ..SEQ + 8].copy_from_slice(&seq.to_le_bytes());
            if state[8] == COMPLETE {
                state[8] = EXIT;
                set_i64(&mut state, WINDOW, now);
                set_i64(&mut state, 97, now);
            } else {
                let deadline = now.checked_add(i64_at(&state, 89)).ok_or_else(fail)?;
                set_i64(&mut state, 97, deadline);
            }
        }
        41 => {
            check(args.is_empty())?;
            // Settling checks these are the two players' wallets.
            let a = next_account_info(&mut it)?;
            let b = next_account_info(&mut it)?;
            let payouts = match state[8] {
                WAITING => {
                    check(now >= i64_at(&state, 97))?;
                    [buy_in, 0]
                }
                EXIT => {
                    check(now >= i64_at(&state, WINDOW))?;
                    play::read(&state)?.stacks
                }
                _ => {
                    check(now >= i64_at(&state, 97))?;
                    // A missed deadline in a hand counts as a fold, and the match settles.
                    let seat = play::actor(&state)?;
                    let mut g = play::read(&state)?;
                    g.forfeit(seat as u8);
                    g.stacks
                }
            };
            play::settle(&mut state, vault, a, b, payouts)?;
        }
        42 => {
            // Two signatures from one player at one step can't happen honestly. They forfeit the escrow.
            check(args.len() == 75 && ![WAITING, COMPLETE].contains(&state[8]))?;
            let accused = args[0] as usize;
            check(accused < 2 && (1..=3).contains(&args[9]) && (1..=3).contains(&args[42]))?;
            let seq = u64_at(args, 1);
            let first = message(program, vault.key, &terms, args[9], seq, &args[10..42]);
            let second = message(program, vault.key, &terms, args[42], seq, &args[43..75]);
            check(first != second)?;
            let a = next_account_info(&mut it)?;
            let b = next_account_info(&mut it)?;
            let sysvar = next_account_info(&mut it)?;
            let key = session(&state, accused);
            require_signed(sysvar, &[(key, first), (key, second)])?;
            let mut payouts = [0, 0];
            payouts[1 - accused] = buy_in.checked_mul(2).ok_or_else(fail)?;
            play::settle(&mut state, vault, a, b, payouts)?;
        }
        43 => {
            check(args.len() == 1 && state[8] == COMPLETE)?;
            let seat = args[0] as usize;
            check(seat < 2 && state[play::CURSOR] & (1 << seat) != 0)?;
            let player = next_account_info(&mut it)?;
            let destination = next_account_info(&mut it)?;
            signer(player)?;
            check(*player.key == key_at(&state, 17 + seat * 32))?;
            payout(vault, destination, u64_at(&state, 201 + seat * 8))?;
            state[play::CURSOR] &= !(1 << seat);
        }
        44 => {
            check(args.is_empty() && state[8] == COMPLETE && state[play::CURSOR] == 0)?;
            let creator = next_account_info(&mut it)?;
            signer(creator)?;
            check(*creator.key == key_at(&state, 17))?;
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
        _ => return Err(ProgramError::InvalidInstructionData),
    }
    save(vault, &mut state)
}
