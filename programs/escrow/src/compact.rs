//! Optional jointly authorized deck acceptance. This does NOT verify a shuffle
//! relation. Both players must independently verify the full proof before signing
//! the exact output hash. Unilateral tag 13 verification remains available.
use crate::{check, fail, key_at, play, DECK_OFFSET};
use solana_curve25519::ristretto::{validate_ristretto, PodRistrettoPoint};
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, hash::hashv, pubkey::Pubkey,
};
pub const HEADER: usize = 81;
pub const SPACE: usize = HEADER + 3328;
const MAGIC: &[u8; 8] = b"ASTKDK01";
fn load(program: &Pubkey, buffer: &AccountInfo, authority: &AccountInfo) -> ProgramResult {
    check(
        buffer.owner == program
            && buffer.data_len() == SPACE
            && authority.is_signer
            && buffer.key != authority.key,
    )?;
    let data = buffer.try_borrow_data()?;
    check(&data[..8] == MAGIC && data[8..40] == authority.key.to_bytes())
}
pub fn initialize(
    program: &Pubkey,
    buffer: &AccountInfo,
    actor: &AccountInfo,
    account: &Pubkey,
    state: &[u8],
) -> ProgramResult {
    check(
        buffer.owner == program
            && buffer.is_writable
            && buffer.is_signer
            && buffer.data_len() == SPACE
            && actor.is_signer
            && buffer.key != actor.key,
    )?;
    let seat = play::actor(state)?;
    check([3, 4].contains(&state[8]) && *actor.key == key_at(state, 17 + seat * 32))?;
    let mut data = buffer.try_borrow_mut_data()?;
    check(data.iter().all(|x| *x == 0))?;
    data[..8].copy_from_slice(MAGIC);
    data[8..40].copy_from_slice(actor.key.as_ref());
    data[40..72].copy_from_slice(account.as_ref());
    data[72..76].copy_from_slice(&play::hand(state).to_le_bytes());
    data[76] = seat as u8;
    Ok(())
}
pub fn process(
    program: &Pubkey,
    buffer: &AccountInfo,
    actor: &AccountInfo,
    tag: u8,
    args: &[u8],
) -> ProgramResult {
    load(program, buffer, actor)?;
    check(buffer.is_writable)?;
    if tag == 19 {
        check(args.is_empty() && actor.is_writable)?;
        let total = actor
            .lamports()
            .checked_add(buffer.lamports())
            .ok_or_else(fail)?;
        **buffer.try_borrow_mut_lamports()? = 0;
        **actor.try_borrow_mut_lamports()? = total;
        buffer.resize(0)?;
        buffer.assign(&Pubkey::default());
        return Ok(());
    }
    check(tag == 17 && args.len() > 4 && args.len() <= 1004)?;
    let offset = u32::from_le_bytes(args[..4].try_into().unwrap()) as usize;
    let len = args.len() - 4;
    let mut data = buffer.try_borrow_mut_data()?;
    let written = u32::from_le_bytes(data[77..81].try_into().unwrap()) as usize;
    check(offset == written && offset.checked_add(len).is_some_and(|end| end <= 3328))?;
    data[HEADER + offset..HEADER + offset + len].copy_from_slice(&args[4..]);
    data[77..81].copy_from_slice(&((offset + len) as u32).to_le_bytes());
    Ok(())
}
pub fn output(
    program: &Pubkey,
    buffer: &AccountInfo,
    actor: &AccountInfo,
    peer: &AccountInfo,
    account: &Pubkey,
    state: &[u8],
    hash: &[u8],
) -> Result<Vec<u8>, solana_program::program_error::ProgramError> {
    load(program, buffer, actor)?;
    let seat = play::actor(state)?;
    check(
        [3, 4].contains(&state[8])
            && *actor.key == key_at(state, 17 + seat * 32)
            && peer.is_signer
            && *peer.key == key_at(state, 17 + (1 - seat) * 32),
    )?;
    let data = buffer.try_borrow_data()?;
    check(
        data[40..72] == account.to_bytes()
            && data[72..76] == play::hand(state).to_le_bytes()
            && data[76] == seat as u8
            && data[77..81] == 3328u32.to_le_bytes(),
    )?;
    let deck = &data[HEADER..];
    check(hashv(&[deck]).to_bytes().as_slice() == hash)?;
    for point in deck.chunks_exact(32) {
        check(validate_ristretto(&PodRistrettoPoint(
            point.try_into().unwrap(),
        )))?;
    }
    check(deck.len() == play::DECK_END - DECK_OFFSET)?;
    Ok(deck.to_vec())
}
