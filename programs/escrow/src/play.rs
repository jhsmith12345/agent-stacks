use crate::{cards, check, fail, game, key_at, payout, proof, u64_at, DECK_OFFSET};
use solana_curve25519::ristretto::{subtract_ristretto, PodRistrettoPoint};
use solana_program::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, rent::Rent,
    sysvar::Sysvar,
};
pub const DECK_END: usize = 3578;
pub const BLIND_OFFSET: usize = DECK_END;
pub const GAME_OFFSET: usize = BLIND_OFFSET + 8;
pub const SHARES_OFFSET: usize = GAME_OFFSET + game::LEN;
pub const CURSOR: usize = SHARES_OFFSET + 9 * 64;
// During COMPLETE only, CURSOR is a two-bit deferred-payout mask. No card
// obligations remain; the full awarded amounts remain in offsets 201..217.
pub const HAND: usize = CURSOR + 1;
pub const MAX_HANDS: usize = HAND + 4;
pub const SPACE: usize = MAX_HANDS + 4;
pub fn hand(state: &[u8]) -> u32 {
    u32::from_le_bytes(state[HAND..MAX_HANDS].try_into().unwrap())
}
pub fn max_hands(state: &[u8]) -> u32 {
    u32::from_le_bytes(state[MAX_HANDS..SPACE].try_into().unwrap())
}
/// Advance completed poker without touching custody; zero stacks or hand limit settle.
pub fn next_hand(state: &mut [u8]) -> Result<bool, ProgramError> {
    let g = read(state)?;
    check(g.stage == game::COMPLETE)?;
    if hand(state) >= max_hands(state) || g.stacks.contains(&0) {
        return Ok(false);
    }
    let next = hand(state).checked_add(1).ok_or_else(fail)?;
    state[HAND..MAX_HANDS].copy_from_slice(&next.to_le_bytes());
    state[137..201].fill(0);
    state[DECK_OFFSET..DECK_END].copy_from_slice(&cards::INITIAL_DECK);
    state[SHARES_OFFSET..=CURSOR].fill(0);
    write(
        state,
        &game::Game::new(
            g.stacks,
            u64_at(state, BLIND_OFFSET),
            ((next - 1) % 2) as u8,
        )?,
    );
    state[8] = 1;
    solana_program::msg!("Starting hand {}", next);
    Ok(true)
}
pub const HOLE_B: u8 = 5;
pub const HOLE_A: u8 = 7;
pub const BETTING: u8 = 8;
pub const BOARD_A: u8 = 9;
pub const BOARD_B: u8 = 10;
pub const SHOW_A: u8 = 11;
pub const SHOW_B: u8 = 12;
pub const POSITIONS: [usize; 9] = [0, 1, 2, 3, 5, 6, 7, 9, 11];
pub fn read(state: &[u8]) -> Result<game::Game, ProgramError> {
    game::Game::decode(&state[GAME_OFFSET..SHARES_OFFSET])
}
pub fn write(state: &mut [u8], g: &game::Game) {
    state[GAME_OFFSET..SHARES_OFFSET].copy_from_slice(&g.encode());
}
pub fn actor(state: &[u8]) -> Result<usize, ProgramError> {
    match state[8] {
        1 | 3 | HOLE_A | BOARD_A | SHOW_A => Ok(0),
        2 | 4 | HOLE_B | BOARD_B | SHOW_B => Ok(1),
        BETTING => {
            let s = read(state)?.actor;
            check(s < 2)?;
            Ok(s as usize)
        }
        _ => Err(fail()),
    }
}
pub fn share_context(
    program: &Pubkey,
    account: &Pubkey,
    hand: u32,
    phase: u8,
    seat: usize,
    position: usize,
    terms: &[u8],
) -> String {
    let hex: String = terms.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "agent-stacks/escrow/share/v2/{program}/{account}/{hand}/{phase}/{seat}/{position}/{hex}"
    )
}
fn positions(phase: u8, g: &game::Game) -> Result<Vec<usize>, ProgramError> {
    match phase {
        HOLE_B | SHOW_A => Ok(vec![0, 2]),
        HOLE_A | SHOW_B => Ok(vec![1, 3]),
        BOARD_A | BOARD_B => match g.street {
            1 => Ok(vec![4, 5, 6]),
            2 => Ok(vec![7]),
            3 => Ok(vec![8]),
            _ => Err(fail()),
        },
        _ => Err(fail()),
    }
}
fn decode(state: &[u8], logical: usize) -> Result<u8, ProgramError> {
    let b = PodRistrettoPoint(
        state[DECK_OFFSET + POSITIONS[logical] * 64 + 32
            ..DECK_OFFSET + POSITIONS[logical] * 64 + 64]
            .try_into()
            .unwrap(),
    );
    let a = PodRistrettoPoint(
        state[SHARES_OFFSET + logical * 64..SHARES_OFFSET + logical * 64 + 32]
            .try_into()
            .unwrap(),
    );
    let c = PodRistrettoPoint(
        state[SHARES_OFFSET + logical * 64 + 32..SHARES_OFFSET + logical * 64 + 64]
            .try_into()
            .unwrap(),
    );
    check(a.0 != [0; 32] && c.0 != [0; 32])?;
    let plain =
        subtract_ristretto(&subtract_ristretto(&b, &a).ok_or_else(fail)?, &c).ok_or_else(fail)?;
    (0..52)
        .find(|i| cards::INITIAL_DECK[i * 64 + 32..i * 64 + 64] == plain.0)
        .map(|i| i as u8)
        .ok_or_else(fail)
}
pub fn sync(state: &mut [u8], g: &game::Game) -> Result<(), ProgramError> {
    state[CURSOR] = 0;
    state[8] = match g.stage {
        game::BETTING => BETTING,
        game::BOARD => BOARD_A,
        game::SHOWDOWN => SHOW_A,
        game::COMPLETE => 6,
        _ => return Err(fail()),
    };
    write(state, g);
    Ok(())
}
pub fn share(
    program: &Pubkey,
    account: &Pubkey,
    state: &mut [u8],
    seat: usize,
    args: &[u8],
    first_shower: usize,
) -> Result<(), ProgramError> {
    check(args.len() > 9)?;
    let mut g = read(state)?;
    let phase = state[8];
    let expected = positions(phase, &g)?;
    let cursor = state[CURSOR] as usize;
    check(cursor < expected.len() && args[8] as usize == expected[cursor])?;
    let logical = expected[cursor];
    let position = POSITIONS[logical];
    let context = share_context(
        program,
        account,
        hand(state),
        phase,
        seat,
        logical,
        &state[105..137],
    );
    let pk = proof::verify(&args[9..], Some(&context))?;
    check(pk == state[137 + seat * 32..169 + seat * 32])?;
    let start = 9 + 2 + context.len();
    check(
        args[start + 32..start + 64]
            == state[DECK_OFFSET + position * 64..DECK_OFFSET + position * 64 + 32],
    )?;
    let target = SHARES_OFFSET + logical * 64 + seat * 32;
    check(state[target..target + 32] == [0; 32])?;
    state[target..target + 32].copy_from_slice(&args[start + 64..start + 96]);
    if phase == BOARD_B {
        g.board[logical - 4] = decode(state, logical)?;
    }
    if phase == SHOW_A || phase == SHOW_B {
        let own = if logical < 2 { 0 } else { 1 };
        g.holes[seat][own] = decode(state, logical)?;
    }
    state[CURSOR] += 1;
    if cursor + 1 == expected.len() {
        state[CURSOR] = 0;
        match phase {
            HOLE_B => state[8] = HOLE_A,
            HOLE_A => {
                sync(state, &g)?;
            }
            BOARD_A => state[8] = BOARD_B,
            BOARD_B => {
                g.resume_board()?;
                sync(state, &g)?;
            }
            SHOW_A | SHOW_B => {
                let first = if first_shower == 0 { SHOW_A } else { SHOW_B };
                if phase == first {
                    state[8] = if first == SHOW_A { SHOW_B } else { SHOW_A };
                } else {
                    g.showdown()?;
                    sync(state, &g)?;
                }
            }
            _ => return Err(fail()),
        }
    }
    write(state, &g);
    Ok(())
}
pub fn settle(
    state: &mut [u8],
    vault: &AccountInfo,
    a: &AccountInfo,
    b: &AccountInfo,
    payouts: [u64; 2],
) -> Result<(), ProgramError> {
    check(*a.key == key_at(state, 17) && *b.key == key_at(state, 49))?;
    check(
        payouts[0].checked_add(payouts[1])
            == u64_at(state, 81).checked_mul(if state[8] == 0 { 1 } else { 2 }),
    )?;
    state[CURSOR] = 0;
    deliver_or_defer(state, vault, a, 0, payouts[0])?;
    deliver_or_defer(state, vault, b, 1, payouts[1])?;
    for (i, p) in payouts.iter().enumerate() {
        state[201 + i * 8..209 + i * 8].copy_from_slice(&p.to_le_bytes());
    }
    state[8] = 6;
    state[97..105].copy_from_slice(&0i64.to_le_bytes());
    Ok(())
}

pub fn deliver_or_defer(
    state: &mut [u8],
    vault: &AccountInfo,
    recipient: &AccountInfo,
    seat: usize,
    amount: u64,
) -> Result<(), ProgramError> {
    crate::writable(recipient)?;
    if amount == 0 {
        return Ok(());
    }
    let rent = Rent::get()?;
    if recipient
        .lamports()
        .checked_add(amount)
        .is_some_and(|balance| rent.is_exempt(balance, recipient.data_len()))
    {
        payout(vault, recipient, amount)?;
    } else {
        state[CURSOR] |= 1 << seat;
        solana_program::msg!("Payout for seat {} retained for withdrawal", seat);
    }
    Ok(())
}
