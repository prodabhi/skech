//! What the game owes, paid off as the pool refills, and the house's fees moved out.
//!
//! On Monad an IOU is an ERC-20. Here it lives on the holder's own `Player` account: the same shares, growing by
//! the same rate, redeemable by anyone once the pool can pay, but not transferable. A transferable token would need
//! Token-2022 transfer hooks to carry each holder's basis, for a feature nothing uses.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::error::SkechError;
use crate::events::{FeesCollected, Redeemed};
use crate::state::*;

#[derive(Accounts)]
pub struct Redeem<'info> {
    /// Whoever sends it. If it is not the holder, they earn a cut of the growth, as on Monad.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [PLAYER_SEED, holder.authority.as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, Player>>,
    /// The caller's own account, opened at their cost if need be, where their cut goes. Left out, they take no cut
    /// and the holder has it all. Never the holder's: a holder redeeming their own takes no cut.
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + Player::INIT_SPACE,
        seeds = [PLAYER_SEED, caller.key().as_ref()],
        bump,
        constraint = caller.key() != holder.authority @ SkechError::OwnRedeem,
    )]
    pub caller_player: Option<Box<Account<'info, Player>>>,
    pub system_program: Program<'info, System>,
}

/// Take `shares` (at most `shares` of what `held` is) back for what they are worth now, as far as the pool goes.
fn redeemable(pool: &Pool, held: u128, want: u128, basis: u64, min_redeem: u64, now: i64) -> Result<(u128, u64, u64)> {
    let mut shares = want.min(held);
    require!(shares > 0, SkechError::NothingToRedeem);
    let mut value = pool.value_of(shares, now);
    if value > pool.pool {
        // What the pool can pay now; the rest stays owed, and keeps growing.
        shares = shares * pool.pool as u128 / value as u128;
        value = pool.value_of(shares, now);
    }
    require!(shares > 0 && value > 0, SkechError::NothingToRedeem);
    require!(shares == held || value >= min_redeem, SkechError::NothingToRedeem);
    // The basis leaves with the shares, in proportion; all of it with the last share.
    let basis_out = if shares == held { basis } else { (basis as u128 * shares / held) as u64 };
    Ok((shares, value, basis_out))
}

/// Pay off a holder's IOU into their balance, as much of `shares` as the pool can cover. Anyone may.
pub fn redeem(ctx: Context<Redeem>, shares: u128) -> Result<()> {
    require!(!ctx.accounts.game.paused, SkechError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let game = &ctx.accounts.game;
    let pool = &mut ctx.accounts.pool;
    let holder = &mut ctx.accounts.holder;
    let (shares, value, basis) = redeemable(pool, holder.iou_shares, shares, holder.iou_basis, game.config.min_redeem, now)?;
    holder.iou_shares -= shares;
    holder.iou_basis -= basis;
    pool.iou_shares -= shares;
    pool.pool -= value;
    let growth = value.saturating_sub(basis);
    let caller = ctx.accounts.caller.key();
    let cut = match ctx.accounts.caller_player.as_deref_mut() {
        Some(by) => {
            if by.authority == Pubkey::default() {
                (by.authority, by.rent_payer, by.bump) = (caller, caller, ctx.bumps.caller_player.unwrap());
            }
            let cut = growth * game.config.sweep_bps as u64 / BPS;
            by.balance += cut;
            cut
        }
        None => 0,
    };
    holder.balance += value - cut;
    emit!(Redeemed { holder: holder.authority, by: ctx.accounts.caller.key(), shares, value, cut });
    Ok(())
}

#[derive(Accounts)]
pub struct RedeemHouse<'info> {
    #[account(seeds = [GAME_SEED], bump = game.bump)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

/// Pay off what the house is owed in fees, into its fees, as far as the pool goes. The house is paid behind every
/// player: this is best sent after their redemptions. Anyone may.
pub fn redeem_house(ctx: Context<RedeemHouse>) -> Result<()> {
    require!(!ctx.accounts.game.paused, SkechError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let min = ctx.accounts.game.config.min_redeem;
    let pool = &mut ctx.accounts.pool;
    let (shares, value, basis) = redeemable(pool, pool.house_shares, pool.house_shares, pool.house_basis, min, now)?;
    pool.house_shares -= shares;
    pool.house_basis -= basis;
    pool.iou_shares -= shares;
    pool.pool -= value;
    pool.fees += value;
    emit!(Redeemed { holder: Pubkey::default(), by: Pubkey::default(), shares, value, cut: 0 });
    Ok(())
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = vault, has_one = treasury, has_one = usdc_mint, has_one = token_program)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Move the fees taken so far to the treasury. Anyone may.
pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
    let amount = ctx.accounts.pool.fees;
    if amount == 0 {
        return Ok(());
    }
    ctx.accounts.pool.fees = 0;
    let a = &ctx.accounts;
    let seeds: &[&[u8]] = &[GAME_SEED, &[a.game.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            TransferChecked { from: a.vault.to_account_info(), mint: a.usdc_mint.to_account_info(), to: a.treasury.to_account_info(), authority: a.game.to_account_info() },
            &[seeds],
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    emit!(FeesCollected { amount });
    Ok(())
}
