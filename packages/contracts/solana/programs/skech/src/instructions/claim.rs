//! What a player's SKT has earned, claimed into their balance, as a hit's winnings are: from there it is theirs to play
//! with or take out. Signed by the wallet; the relayer pays the fee.

use anchor_lang::prelude::*;

use crate::error::SkechError;
use crate::events::Claimed;
use crate::state::*;
// Named, not only globbed: the prelude has a `Rewards` too (the sysvar).
use crate::state::Rewards;

#[derive(Accounts)]
pub struct Claim<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump)]
    pub game: Box<Account<'info, Game>>,
    /// Not re-derived from its seeds (1,500 CU): only `init_rewards` makes a `Rewards`, once, at its seeds, so the
    /// one account with its owner and discriminator is the one.
    #[account(mut)]
    pub rewards: Box<Account<'info, Rewards>>,
    #[account(mut, seeds = [PLAYER_SEED, authority.key().as_ref()], bump = player.bump, has_one = authority)]
    pub player: Box<Account<'info, Player>>,
    /// Not re-derived from its seeds either: a `Holder` is only ever made at its player's own address, so the one
    /// that names this wallet is theirs.
    #[account(mut, constraint = holder.player == authority.key() @ SkechError::BadSettleAccounts)]
    pub holder: Box<Account<'info, Holder>>,
}

/// Everything earned so far into the balance. Paused or not, as a withdrawal is: what was earned is the holder's, and
/// a pause stops play, not the money already won. Nothing earned fails, so a claim is never paid for to move nothing.
pub fn claim(ctx: Context<Claim>) -> Result<()> {
    let rewards = &mut ctx.accounts.rewards;
    let holder = &mut ctx.accounts.holder;
    holder.settle_rewards(rewards)?;
    let amount = holder.unclaimed;
    require!(amount > 0, SkechError::NothingToClaim);
    // Never more than is set aside: every holder's earnings are rounded down from it.
    rewards.holder_funds = rewards.holder_funds.checked_sub(amount).ok_or(SkechError::Overflow)?;
    rewards.claimed_total = rewards.claimed_total.checked_add(amount).ok_or(SkechError::Overflow)?;
    holder.unclaimed = 0;
    holder.claimed = holder.claimed.checked_add(amount).ok_or(SkechError::Overflow)?;
    let player = &mut ctx.accounts.player;
    player.balance = player.balance.checked_add(amount).ok_or(SkechError::Overflow)?;
    emit!(Claimed { player: player.authority, amount });
    Ok(())
}
