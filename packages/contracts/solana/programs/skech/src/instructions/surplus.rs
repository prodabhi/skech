//! The pool's surplus, shared with SKT holders and the treasury. The pool pays every hit; the house's edge stays in it,
//! and nothing else ever takes it out. What it holds over a large reserve and over what every live bet could pay, if
//! every band hit, goes `surplus_holder_bps` (75%) to holders by the accumulator, as their share of a fee does, and the
//! rest to the treasury. With every holder paid by the accumulator and the treasury keeping a quarter, a whale that
//! loses on purpose to hold SKT gets back less than it loses whatever others play (`docs/HOW-IT-WORKS.md` § SKT). Anyone may send it (the relayer does, every few
//! minutes); it never runs while anything is owed, so IOUs are always paid first.
//!
//! Why the pool can still pay: `Rewards::liability` is the gross every live bet placed since SKT started could pay (each
//! placement adds its bands', each settlement takes away those it decides), and the reserve, at least what one piece can
//! pay at the game's terms (`check_config`) and by default three times that, sits on top. After a share the pool holds
//! both, so the worst a winner can ask, every live band hitting and then the dearest piece there can be, is there.

use anchor_lang::prelude::*;

use crate::error::SkechError;
use crate::events::SurplusShared;
use crate::state::*;
// Named, not only globbed: the prelude has a `Rewards` too (the sysvar).
use crate::state::Rewards;

#[derive(Accounts)]
pub struct ShareSurplus<'info> {
    #[account(seeds = [GAME_SEED], bump = game.bump)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [REWARDS_SEED], bump = rewards.bump)]
    pub rewards: Box<Account<'info, Rewards>>,
}

/// What the pool may share now: what it holds over the reserve and every live bet's most, if nothing is owed, there is
/// SKT to share it, and every bet placed before SKT started (its liability not counted) has been decided or given back.
pub fn surplus(pool: &Pool, rewards: &Rewards, now: i64) -> u64 {
    let owed = pool.iou_shares > 0 || pool.house_shares > 0;
    let settled_in = now >= rewards.started_at + BAR_RING as i64;
    if owed || !settled_in || rewards.total_shares < MIN_TOTAL_SHARES {
        return 0;
    }
    pool.pool.saturating_sub(rewards.liability.saturating_add(rewards.config.surplus_reserve))
}

pub fn share_surplus(ctx: Context<ShareSurplus>) -> Result<()> {
    require!(!ctx.accounts.game.paused, SkechError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let (pool, rewards) = (&mut ctx.accounts.pool, &mut ctx.accounts.rewards);
    rewards.catch_up(now);
    let amount = surplus(pool, rewards, now);
    require!(amount > 0, SkechError::NoSurplus);
    // The holders' part, rounded down; the treasury's the rest, the rounding with it. Of the holders' part, while there
    // are fewer shares than the cap's floor, only their share is shared (`counted_shares`): the floor's goes to the
    // treasury too.
    let to_holders = (amount as u128 * rewards.config.surplus_holder_bps as u128 / BPS as u128) as u64;
    let shared = to_holders - rewards.accrue(to_holders, now)?;
    let treasury = amount - shared;
    pool.pool -= amount;
    pool.fees = pool.fees.checked_add(treasury).ok_or(SkechError::Overflow)?;
    rewards.swept_total = rewards.swept_total.saturating_add(shared);
    emit!(SurplusShared { amount: shared, treasury, kept: pool.pool });
    Ok(())
}
