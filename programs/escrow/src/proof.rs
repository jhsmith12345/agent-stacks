use crypto_bigint::{NonZero, U256};
const ORDER: U256 =
    U256::from_be_hex("1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed");
use solana_curve25519::{
    ristretto::{add_ristretto, multiply_ristretto, validate_ristretto, PodRistrettoPoint},
    scalar::PodScalar,
};
use solana_program::{hash::hashv, program_error::ProgramError};

pub const DOMAIN: &[u8] = b"agent-stacks/dleq/ristretto255/v1";
pub const BASE: [u8; 32] = [
    0xe2, 0xf2, 0xae, 0x0a, 0x6a, 0xbc, 0x4e, 0x71, 0xa8, 0x84, 0xa9, 0x61, 0xc5, 0x00, 0x51, 0x5f,
    0x58, 0xe3, 0x0b, 0x6a, 0xa5, 0x82, 0xdd, 0x8d, 0xb6, 0xa6, 0x59, 0x45, 0xe0, 0x8d, 0x2d, 0x76,
];
fn invalid() -> ProgramError {
    ProgramError::InvalidInstructionData
}

// Wire: context length u16 LE, context UTF-8, PK, base2, share, t1, t2, response.
// Canonical scalar and Ristretto encodings are checked before calling group syscalls.
pub fn verify(data: &[u8], expected_context: Option<&str>) -> Result<[u8; 32], ProgramError> {
    if data.len() < 194 {
        return Err(invalid());
    }
    let n = u16::from_le_bytes(data[..2].try_into().map_err(|_| invalid())?) as usize;
    if n == 0 || n > 1024 || data.len() != 194 + n {
        return Err(invalid());
    }
    let context = core::str::from_utf8(&data[2..2 + n]).map_err(|_| invalid())?;
    if expected_context.is_some_and(|expected| expected != context) {
        return Err(invalid());
    }
    let mut fields = [[0u8; 32]; 6];
    for (i, field) in fields.iter_mut().enumerate() {
        field.copy_from_slice(&data[2 + n + i * 32..2 + n + (i + 1) * 32]);
    }
    if fields[..5]
        .iter()
        .any(|p| *p == [0; 32] || !validate_ristretto(&PodRistrettoPoint(*p)))
    {
        return Err(invalid());
    }
    if U256::from_le_slice(&fields[5]) >= ORDER {
        return Err(invalid());
    }
    let h = hashv(&[
        DOMAIN,
        &data[..2],
        context.as_bytes(),
        &fields[0],
        &fields[1],
        &fields[2],
        &fields[3],
        &fields[4],
    ]);
    let c = PodScalar(
        U256::from_le_slice(&h.to_bytes())
            .rem(&NonZero::new(ORDER).unwrap())
            .to_le_bytes()
            .into(),
    );
    let s = PodScalar(fields[5]);
    for (base, public, commitment) in [
        (BASE, fields[0], fields[3]),
        (fields[1], fields[2], fields[4]),
    ] {
        let left = multiply_ristretto(&s, &PodRistrettoPoint(base)).ok_or_else(invalid)?;
        let product = multiply_ristretto(&c, &PodRistrettoPoint(public)).ok_or_else(invalid)?;
        let right = add_ristretto(&PodRistrettoPoint(commitment), &product).ok_or_else(invalid)?;
        if left != right {
            return Err(invalid());
        }
    }
    Ok(fields[0])
}
