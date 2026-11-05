//! Large proof-account verifier. It certifies the shuffle relation only. A game
//! must independently bind input deck, joint key, context, and the verified output.
use crate::proof::BASE;
use crypto_bigint::U256;
use solana_curve25519::{
    ristretto::{add_ristretto, multiply_ristretto, validate_ristretto, PodRistrettoPoint},
    scalar::PodScalar,
};
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, hash::hashv, program_error::ProgramError,
    pubkey::Pubkey, rent::Rent, sysvar::Sysvar,
};
const DOMAIN: &[u8] = b"agent-stacks/elgamal-cut-and-choose/v2";
const MAGIC: &[u8; 8] = b"ASTKSHF1";
pub const HEADER: usize = 84;
const N: usize = 52;
const ROUNDS: usize = 128;
const DECK: usize = N * 64;
const OPENING: usize = N * 33;
const ORDER: U256 =
    U256::from_be_hex("1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed");
fn invalid() -> ProgramError {
    ProgramError::InvalidInstructionData
}
fn check(ok: bool) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn read32(data: &[u8], at: usize) -> [u8; 32] {
    data[at..at + 32].try_into().unwrap()
}
fn read_u32(data: &[u8], at: usize) -> usize {
    u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize
}
fn round(data: &[u8]) -> usize {
    u16::from_le_bytes(data[49..51].try_into().unwrap()) as usize
}

pub fn process(
    program: &Pubkey,
    account: &AccountInfo,
    authority: &AccountInfo,
    tag: u8,
    args: &[u8],
) -> ProgramResult {
    check(
        account.owner == program
            && account.is_writable
            && authority.is_signer
            && account.key != authority.key,
    )?;
    check(account.data_len() >= HEADER)?;
    if tag == 8 {
        // Also authenticate the newly allocated account. Otherwise an observer
        // can claim its refundable rent between allocation and initialization.
        check(args.len() == 4 && account.is_signer)?;
        let size = read_u32(args, 0);
        // 36 bytes of framing + 52-card input/output + 128 commitments/openings + context.
        check((652325..=653348).contains(&size) && account.data_len() == HEADER + size)?;
        check(account.lamports() >= Rent::get()?.minimum_balance(account.data_len()))?;
        let mut data = account.try_borrow_mut_data()?;
        check(data[..HEADER].iter().all(|b| *b == 0))?;
        data[..8].copy_from_slice(MAGIC);
        data[8..40].copy_from_slice(authority.key.as_ref());
        data[40..44].copy_from_slice(args);
        return Ok(());
    }
    {
        let data = account.try_borrow_data()?;
        check(&data[..8] == MAGIC && data[8..40] == authority.key.to_bytes())?;
    }
    if tag == 12 {
        check(args.is_empty() && authority.is_writable)?;
        let amount = account.lamports();
        let total = authority
            .lamports()
            .checked_add(amount)
            .ok_or_else(invalid)?;
        **account.try_borrow_mut_lamports()? = 0;
        **authority.try_borrow_mut_lamports()? = total;
        account.resize(0)?;
        account.assign(&Pubkey::default());
        return Ok(());
    }
    let mut data = account.try_borrow_mut_data()?;
    if tag == 9 {
        check(args.len() > 4 && args.len() <= 1004 && data[48] == 0)?;
        let offset = read_u32(args, 0);
        let len = args.len() - 4;
        check(
            offset == read_u32(&data, 44)
                && offset
                    .checked_add(len)
                    .is_some_and(|end| end <= read_u32(&data, 40)),
        )?;
        data[HEADER + offset..HEADER + offset + len].copy_from_slice(&args[4..]);
        data[44..48].copy_from_slice(&((offset + len) as u32).to_le_bytes());
        return Ok(());
    }
    check(read_u32(&data, 44) == read_u32(&data, 40))?;
    let payload = &data[HEADER..];
    check(u16::from_le_bytes(payload[..2].try_into().unwrap()) as usize == N)?;
    let context_len = u16::from_le_bytes(payload[2..4].try_into().unwrap()) as usize;
    check((1..=1024).contains(&context_len))?;
    core::str::from_utf8(&payload[4..4 + context_len]).map_err(|_| invalid())?;
    let key_at = 4 + context_len;
    let input_at = key_at + 32;
    let output_at = input_at + DECK;
    let commitments_at = output_at + DECK;
    let openings_at = commitments_at + ROUNDS * DECK;
    check(payload.len() == openings_at + ROUNDS * OPENING)?;
    let key = PodRistrettoPoint(read32(payload, key_at));
    check(key.0 != [0; 32] && validate_ristretto(&key))?;
    if tag == 10 {
        check(args.is_empty() && data[48] == 0)?;
        let hash = hashv(&[DOMAIN, &payload[..openings_at]]);
        data[51..83].copy_from_slice(&hash.to_bytes());
        data[48] = 1;
        return Ok(());
    }
    check(tag == 11 && args.len() == 3 && data[48] == 1 && data[83] == 0)?;
    let start = u16::from_le_bytes(args[..2].try_into().unwrap()) as usize;
    let count = args[2] as usize;
    check(start == round(&data) && (1..=4).contains(&count) && start + count <= ROUNDS)?;
    for r in start..start + count {
        let target = if ((data[51 + r / 8] >> (r % 8)) & 1) == 0 {
            input_at
        } else {
            output_at
        };
        let commitment = commitments_at + r * DECK;
        let opening = openings_at + r * OPENING;
        let mut seen = 0u64;
        for i in 0..N {
            let j = payload[opening + i] as usize;
            check(j < N && seen & (1u64 << j) == 0)?;
            seen |= 1u64 << j;
            let scalar_bytes = read32(payload, opening + N + i * 32);
            check(U256::from_le_slice(&scalar_bytes) < ORDER)?;
            let scalar = PodScalar(scalar_bytes);
            for (part, base) in [(0, PodRistrettoPoint(BASE)), (32, key)] {
                let original = PodRistrettoPoint(read32(payload, target + j * 64 + part));
                let mask = multiply_ristretto(&scalar, &base).ok_or_else(invalid)?;
                let expected = add_ristretto(&original, &mask).ok_or_else(invalid)?;
                check(expected.0 == read32(payload, commitment + i * 64 + part))?;
            }
        }
    }
    data[49..51].copy_from_slice(&((start + count) as u16).to_le_bytes());
    if start + count == ROUNDS {
        data[83] = 1;
    }
    Ok(())
}

// Consume a verified mathematical relation only after binding it to the game's
// expected input, joint key, and exact context. Copy output before rent reclamation.
pub fn verified_output(
    program: &Pubkey,
    account: &AccountInfo,
    authority: &Pubkey,
    context: &str,
    joint_key: &[u8; 32],
    expected_input: &[u8],
) -> Result<Vec<u8>, ProgramError> {
    check(account.owner == program && account.data_len() >= HEADER + 652325)?;
    let data = account.try_borrow_data()?;
    check(
        &data[..8] == MAGIC
            && data[8..40] == authority.to_bytes()
            && data[48] == 1
            && data[83] == 1
            && round(&data) == ROUNDS,
    )?;
    check(
        read_u32(&data, 44) == read_u32(&data, 40) && data.len() == HEADER + read_u32(&data, 40),
    )?;
    let payload = &data[HEADER..];
    let n = u16::from_le_bytes(payload[..2].try_into().unwrap()) as usize;
    let ctx_len = u16::from_le_bytes(payload[2..4].try_into().unwrap()) as usize;
    check(n == N && ctx_len == context.len() && (1..=1024).contains(&ctx_len))?;
    check(&payload[4..4 + ctx_len] == context.as_bytes())?;
    let key_at = 4 + ctx_len;
    let input_at = key_at + 32;
    let output_at = input_at + DECK;
    check(
        payload[key_at..input_at] == *joint_key && &payload[input_at..output_at] == expected_input,
    )?;
    Ok(payload[output_at..output_at + DECK].to_vec())
}
