//! Test only, never deployed. Calls the program in `accounts[0]` with the rest of the accounts and the data from
//! byte `8 + n` on, where `n` is the little-endian u16 in bytes 0..2: bytes 8..8 + n are free for anything else,
//! such as a piece an Ed25519 instruction verified as sitting in this instruction's data.

use solana_account_info::AccountInfo;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::{ProgramError, ProgramResult};
use solana_pubkey::Pubkey;

solana_program_entrypoint::entrypoint!(run);

fn run(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let n = u16::from_le_bytes(data.get(..2).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap()) as usize;
    let inner = data.get(8 + n..).ok_or(ProgramError::InvalidInstructionData)?;
    let (target, rest) = accounts.split_first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    let metas = rest.iter().map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer, is_writable: a.is_writable }).collect();
    solana_cpi::invoke(&Instruction { program_id: *target.key, accounts: metas, data: inner.to_vec() }, rest)
}
