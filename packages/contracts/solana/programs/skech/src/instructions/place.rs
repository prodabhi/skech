//! Placing a piece. One piece per transaction: Solana runs transactions that write different accounts in parallel,
//! and what a placement writes is the player's own account, their new bet and the pool.
//!
//! Who vouches for what:
//! - the player's session key signed the piece (the Ed25519 instruction before this one, checked in `piece.rs`);
//! - the oracle signed the transaction, and with it the quote: when it received the piece, the market's price and
//!   momentum on the opening second and each band's chance. It also checked, off chain, that the price the player
//!   saw is the engine's;
//! - the rung each band pays is computed here, from the chance, this market's difficulty and the momentum, so the
//!   oracle cannot pay a band more than its chance earns.
//!
//! A piece that cannot go in fails with the reason; nothing is written and nothing is charged but the fee.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};

use crate::error::SkechError;
use crate::events::Placed;
use crate::ladder;
use crate::piece::{verify_session_sig, PieceMessage, QuoteArgs};
use crate::skt;
use crate::state::*;
// Named, not only globbed: the prelude has a `Rewards` too (the sysvar).
use crate::state::Rewards;

#[derive(Accounts)]
#[instruction(piece: PieceMessage)]
pub struct Place<'info> {
    /// Pays the transaction and the bet's rent, and gets the rent back when the bet is closed.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Attests the quote by signing. Usually the payer too.
    pub oracle: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = oracle @ SkechError::NotOracle)]
    pub game: Box<Account<'info, Game>>,
    #[account(seeds = [MARKET_SEED, &[piece.market]], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [BARS_SEED, &[piece.market]], bump)]
    pub bars: AccountLoader<'info, Bars>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// For the holders' share of the stake fee. Written by every placement, as the pool is: no new contention.
    /// Not re-derived from its seeds (1,500 CU): only `init_rewards` makes a `Rewards`, once, at its seeds, so the
    /// one account with its owner and discriminator is the one.
    #[account(mut)]
    pub rewards: Box<Account<'info, Rewards>>,
    #[account(mut, seeds = [PLAYER_SEED, piece.player.as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, Player>>,
    /// The new bet, at seeds [BET_SEED, player, drawing, index]: created here only if the piece goes in.
    /// CHECK: its address is checked against the seeds, and it must not exist yet.
    #[account(mut)]
    pub bet: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, for the session key's signature.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn place(ctx: Context<Place>, piece: PieceMessage, quote: QuoteArgs) -> Result<()> {
    let a = &ctx.accounts;
    let game = &a.game;
    let c = &game.config;
    let market = &a.market;
    require!(!game.paused, SkechError::Paused);
    require!(market.active, SkechError::MarketInactive);

    // The quote, and the window: not long after the second the piece opens on, and not before it either.
    require!(piece.open_at > 0 && piece.open_at % 1000 == 0 && piece.unit > 0 && quote.price > 0, SkechError::BadQuote);
    // A grid unit is a sliver of the price: it also pads every band, so it cannot be let grow.
    require!(piece.unit as u128 * PRICE_UNITS <= quote.price as u128, SkechError::BadQuote);
    let now_ms = Clock::get()?.unix_timestamp.checked_mul(1000).ok_or(SkechError::Overflow)?;
    let grace = c.place_grace_ms as i64;
    require!(now_ms <= piece.open_at + grace && piece.open_at <= now_ms + grace, SkechError::Window);

    // The piece itself.
    require!(piece.domain == game.domain && piece.market == market.id, SkechError::Mismatch);
    let player_key = piece.player;
    // Only at its canonical bump: a piece has one bet address, or it could be placed again at every other bump.
    let (drawing, index) = (piece.drawing.to_le_bytes(), piece.index.to_le_bytes());
    let (bet_key, bet_bump) = Pubkey::find_program_address(&[BET_SEED, player_key.as_ref(), &drawing, &index], ctx.program_id);
    require_keys_eq!(bet_key, a.bet.key(), SkechError::Mismatch);
    let seeds: &[&[u8]] = &[BET_SEED, player_key.as_ref(), &drawing, &index, &[bet_bump]];
    require!(a.bet.owner != ctx.program_id, SkechError::Replay);
    require!(piece.difficulty == market.difficulty, SkechError::Difficulty);
    // The oracle must have had the piece before its opening second, give or take the network.
    require!(quote.received_at <= piece.open_at + c.late_ms as i64, SkechError::Late);
    require!(piece.price_time <= quote.received_at && quote.received_at - piece.price_time <= c.max_price_age_ms as i64, SkechError::StalePrice);
    require!((c.min_per_dot..=c.max_per_dot).contains(&(piece.per_dot as u64)), SkechError::PerDot);
    let n = piece.sections.len();
    require!(n > 0 && n <= MAX_SECTIONS && quote.chances.len() == n, SkechError::Sections);
    let mut total: u64 = 0;
    for s in &piece.sections {
        // A band no taller than the widest pen draws (MAX_SECTION_WIDTH): a pen-wide band is never all but certain.
        require!(s.second >= 1 && s.second <= HORIZON && s.width > 0 && s.width <= MAX_SECTION_WIDTH && s.stake > 0, SkechError::Sections);
        total += s.stake as u64;
    }
    require!(total <= c.max_piece_stake, SkechError::Sections);

    // Signed by the player's session, still valid.
    let session = a.player.session;
    require!(session.valid_until > now_ms / 1000, SkechError::Session);
    verify_session_sig(&a.instructions, &session.key, piece.encoded_len())?;

    // Each band: offered unless its second is already over on chain, its chance earns no rung, or it would return more
    // than its stake less the fee (chance × rung over 1 − fee): the player risks nothing on such ink while the holders'
    // share of its fee comes out of the pool.
    let bars = a.bars.load()?;
    let mut sections: Vec<BetSection> = Vec::with_capacity(n);
    // Each kept band's chance, as quoted: kept after the bet, for SKT's basis when the band misses.
    let mut kept_chances: Vec<u32> = Vec::with_capacity(n);
    let mut kept: u64 = 0;
    // The most the kept bands could pay, every one hitting: the pool keeps it until they are decided.
    let mut could_pay: u64 = 0;
    for (s, &chance) in piece.sections.iter().zip(&quote.chances) {
        // A band beyond any price a u64 holds is not a band.
        let lo = (s.lo as u64).checked_mul(piece.unit).ok_or(SkechError::Sections)?;
        let hi = (s.lo as u64 + s.width as u64).checked_mul(piece.unit).ok_or(SkechError::Sections)?;
        if bars.at(piece.open_at + s.second as i64 * 1000).is_some() {
            continue;
        }
        let with_it = ladder::with_momentum(lo, hi, quote.price, quote.momentum);
        let rung = ladder::rung_for(chance, piece.difficulty, with_it, quote.momentum);
        if rung == 0 || !ladder::within_fee(chance, rung, c.fee_bps) {
            continue;
        }
        // One section never pays past 256 dots: a big one stakes only what that pays for.
        let stake = (s.stake as u64).min(ladder::max_stake(piece.per_dot as u64, rung));
        sections.push(BetSection { second: s.second, lo, hi, stake, rung });
        kept_chances.push(chance);
        kept += stake;
        could_pay = could_pay.saturating_add(ladder::gross(stake, rung));
    }
    drop(bars);
    require!(kept > 0, SkechError::NotOffered);
    require!(session.allowance >= kept, SkechError::Allowance);
    require!(a.player.balance >= kept, SkechError::Balance);

    // Everything checks out: only now is anything written.
    // Rounded up, as on Monad: a stake split small never slips under the fee.
    let fee = (kept * c.fee_bps as u64).div_ceil(BPS);
    // The holders' part of it, rounded down; the treasury's the rest.
    let to_holders = skt::holder_part(kept, a.rewards.config.holder_fee_bps, c.fee_bps);
    let (unit, per_dot, open_at, difficulty) = (piece.unit, piece.per_dot as u64, piece.open_at, piece.difficulty);
    let player = &mut ctx.accounts.player;
    player.balance -= kept;
    player.session.allowance -= kept;
    let pool = &mut ctx.accounts.pool;
    pool.pool = pool.pool.checked_add(kept - fee).ok_or(SkechError::Overflow)?;
    pool.fees = pool.fees.checked_add(fee - to_holders).ok_or(SkechError::Overflow)?;
    let rewards = &mut ctx.accounts.rewards;
    rewards.share_stake_fee(pool, to_holders, now_ms / 1000)?;
    rewards.liability = rewards.liability.saturating_add(could_pay);

    let count = sections.len();
    let bet = Bet {
        player: player_key,
        drawing: piece.drawing,
        index: piece.index,
        market: piece.market,
        difficulty,
        live_mask: ((1u64 << count) - 1) as u32,
        hit_mask: 0,
        open_at,
        per_dot,
        unit,
        stake: kept,
        rent_payer: ctx.accounts.payer.key(),
        sections,
    };
    create_pda(&ctx.accounts.payer, &ctx.accounts.bet, &ctx.accounts.system_program, Bet::space_with_chances(count), ctx.program_id, seeds)?;
    let info = ctx.accounts.bet.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    bet.try_serialize(&mut &mut data[..])?;
    for (i, c) in kept_chances.iter().enumerate() {
        let at = Bet::space(count) + 4 * i;
        data[at..at + 4].copy_from_slice(&c.to_le_bytes());
    }

    emit!(Placed {
        bet: bet_key,
        player: player_key,
        drawing: piece.drawing,
        index: piece.index,
        market: piece.market,
        open_at,
        per_dot,
        unit,
        staked: kept,
        fee,
        refunded: total - kept,
        price_seen: piece.price_seen,
        price_time: piece.price_time,
        stroke_hash: piece.stroke_hash,
        sections: bet.sections,
    });
    Ok(())
}

/// Create a program account at a PDA, even if someone has already sent lamports to its address to stop it being
/// created: top it up to rent-exempt, allocate, assign.
pub fn create_pda<'info>(payer: &Signer<'info>, target: &UncheckedAccount<'info>, system: &Program<'info, System>, space: usize, owner: &Pubkey, seeds: &[&[u8]]) -> Result<()> {
    create_pda_at(payer, &target.to_account_info(), system, space, owner, seeds)
}

/// `create_pda`, for an account passed among the remaining accounts.
pub fn create_pda_at<'info>(payer: &Signer<'info>, target: &AccountInfo<'info>, system: &Program<'info, System>, space: usize, owner: &Pubkey, seeds: &[&[u8]]) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(space);
    let (p, t, s) = (payer.to_account_info(), target.clone(), system.to_account_info());
    let have = t.lamports();
    if have == 0 {
        invoke_signed(&system_instruction::create_account(p.key, t.key, rent, space as u64, owner), &[p, t, s], &[seeds])?;
        return Ok(());
    }
    if have < rent {
        anchor_lang::solana_program::program::invoke(&system_instruction::transfer(p.key, t.key, rent - have), &[p.clone(), t.clone(), s.clone()])?;
    }
    invoke_signed(&system_instruction::allocate(t.key, space as u64), &[t.clone(), s.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(t.key, owner), &[t, s], &[seeds])?;
    Ok(())
}
