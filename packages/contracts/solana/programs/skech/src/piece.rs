//! A piece of a drawing, as its player's session key signs it, and how the program knows the key signed it.
//!
//! The session key signs the piece's bytes exactly as they sit in the `place` instruction: `PieceMessage` is its
//! first argument, so its Borsh encoding is the instruction's data from byte 8 (after the discriminator). The
//! transaction carries an Ed25519 precompile instruction just before `place` that verifies the signature over
//! that range of `place`'s own data, so the piece is in the transaction once, not twice. The program then checks
//! the precompile instruction was pointed at exactly that range and at the player's session key.
//!
//! `place` must be one of the transaction's own instructions, not called from another program: the instructions
//! sysvar knows only the transaction's own, so from inside another program "this instruction's data" is that
//! program's, which could carry a piece the key once signed while passing on a different one.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};

use crate::error::SkechError;

/// The Ed25519 precompile.
pub const ED25519_PROGRAM: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// A band, as signed: `lo` and `hi` are counted in grid units (so they sit on the grid by construction), `stake` in
/// USDC e6. 11 bytes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct SectionArg {
    /// Seconds after the piece opens, 1 to 30.
    pub second: u8,
    /// The band's bottom, in units of `unit` from zero.
    pub lo: u32,
    /// Its height, in units.
    pub width: u16,
    pub stake: u32,
}

/// What a player's session key signs: a piece of a drawing, bet as it is drawn.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub struct PieceMessage {
    /// `Game.domain`: this deployment on this cluster.
    pub domain: [u8; 32],
    /// The player's wallet.
    pub player: Pubkey,
    /// The drawing this piece is part of, and its number within it: together they name the bet.
    pub drawing: u64,
    pub index: u32,
    pub market: u8,
    /// The difficulty the player was shown. If the market's has changed since, the piece is refused.
    pub difficulty: u8,
    /// The second it opens on, ms. Its bands are 1 to 30 seconds after it.
    pub open_at: i64,
    /// What one dot costs, USDC e6.
    pub per_dot: u32,
    /// The price grid the bands sit on, 8 decimals: bands are judged one unit wider each way.
    pub unit: u64,
    /// The price on the player's screen when they drew, and its time, as the engine signed it (checked by the oracle).
    pub price_seen: u64,
    pub price_time: i64,
    /// sha256 of the stroke's points. The stroke itself stays with the relayer: it is too big for a transaction.
    pub stroke_hash: [u8; 32],
    pub sections: Vec<SectionArg>,
}

impl PieceMessage {
    pub const FIXED: usize = 32 + 32 + 8 + 4 + 1 + 1 + 8 + 4 + 8 + 8 + 8 + 32 + 4;
    /// Its Borsh length: what the Ed25519 instruction must cover.
    pub fn encoded_len(&self) -> usize {
        Self::FIXED + self.sections.len() * 11
    }
}

/// What the oracle attests about a piece, by signing the transaction that carries it: the market on its opening
/// second and each band's chance, measured off chain on thousands of real price paths.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub struct QuoteArgs {
    /// The price the second before `open_at` closed at, 8 decimals.
    pub price: u64,
    /// The last three seconds' move in volatilities, x1e6.
    pub momentum: i64,
    /// When the oracle received the piece, ms.
    pub received_at: i64,
    /// Each band's chance, in billionths, in the piece's order.
    pub chances: Vec<u32>,
}

const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;

fn u16_at(d: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(d.get(at..at + 2)?.try_into().ok()?))
}

/// That the instruction before this one is the Ed25519 precompile verifying one signature by `key` over this
/// instruction's data from byte 8 for `len` bytes. The precompile has already failed the transaction if the
/// signature is wrong; what is checked here is that it checked the right thing.
pub fn verify_session_sig(instructions: &AccountInfo, key: &Pubkey, len: usize) -> Result<()> {
    // One of the transaction's own instructions, so the one at the current index is this one, its data the piece.
    require!(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, SkechError::SessionSig);
    let current = load_current_index_checked(instructions)?;
    require!(current > 0, SkechError::SessionSig);
    let ix = load_instruction_at_checked(current as usize - 1, instructions)?;
    require_keys_eq!(ix.program_id, ED25519_PROGRAM, SkechError::SessionSig);
    let d = &ix.data;
    // One signature, its key and signature inline in the precompile's own data, its message in ours.
    require!(d.len() >= OFFSETS_START + OFFSETS_LEN && d[0] == 1, SkechError::SessionSig);
    let o = OFFSETS_START;
    let field = |i: usize| u16_at(d, o + 2 * i).ok_or(SkechError::SessionSig);
    let (sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix) = (field(1)?, field(2)?, field(3)?, field(4)?, field(5)?, field(6)?);
    require!(sig_ix == u16::MAX && pk_ix == u16::MAX, SkechError::SessionSig);
    require!(msg_ix == current && msg_off == 8 && msg_len as usize == len, SkechError::SessionSig);
    let pk = d.get(pk_off as usize..pk_off as usize + 32).ok_or(SkechError::SessionSig)?;
    require!(pk == key.as_ref(), SkechError::SessionSig);
    Ok(())
}
