//! Money in and out, and sessions. Every one of these is signed by the player's wallet (or, for `sweep`, rides on
//! an approval the wallet gave) and can be paid for by someone else: the relayer is the fee payer and pays the
//! rent of a player's account, so a player never needs SOL.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::error::SkechError;
use crate::events::{Deposited, SessionRevoked, SessionSet, Withdrawn};
use crate::state::*;

fn open_player(player: &mut Account<Player>, authority: Pubkey, payer: Pubkey, bump: u8) {
    if player.authority == Pubkey::default() {
        player.authority = authority;
        player.rent_payer = payer;
        player.bump = bump;
    }
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = vault, has_one = usdc_mint, has_one = token_program)]
    pub game: Box<Account<'info, Game>>,
    #[account(init_if_needed, payer = payer, space = 8 + Player::INIT_SPACE, seeds = [PLAYER_SEED, authority.key().as_ref()], bump)]
    pub player: Box<Account<'info, Player>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = token_program)]
    pub from: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Put USDC from the wallet's token account into its balance.
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.game.paused, SkechError::Paused);
    require!(amount > 0, SkechError::ZeroAmount);
    let a = &ctx.accounts;
    transfer_checked(
        CpiContext::new(
            a.token_program.to_account_info(),
            TransferChecked { from: a.from.to_account_info(), mint: a.usdc_mint.to_account_info(), to: a.vault.to_account_info(), authority: a.authority.to_account_info() },
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    let (authority, payer, bump) = (a.authority.key(), a.payer.key(), ctx.bumps.player);
    let player = &mut ctx.accounts.player;
    open_player(player, authority, payer, bump);
    player.balance = player.balance.checked_add(amount).ok_or(SkechError::Overflow)?;
    emit!(Deposited { player: authority, amount, swept: false });
    Ok(())
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = vault, has_one = usdc_mint, has_one = token_program)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, Player>>,
    /// The player's own token account, on which they approved the game as delegate. Only their own tokens, into
    /// their own balance: nothing else can be moved this way.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = player.authority,
        token::token_program = token_program,
        constraint = from.delegate == Some(game.key()).into() @ SkechError::BadTokenAccount,
    )]
    pub from: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Move USDC that landed in a player's wallet into their balance, on the approval they gave the game. Anyone may
/// send it: the relayer does, as deposits arrive, so a player sees one address and one balance.
pub fn sweep(ctx: Context<Sweep>) -> Result<()> {
    require!(!ctx.accounts.game.paused, SkechError::Paused);
    let a = &ctx.accounts;
    let amount = a.from.amount.min(a.from.delegated_amount);
    require!(amount > 0, SkechError::ZeroAmount);
    let seeds: &[&[u8]] = &[GAME_SEED, &[a.game.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            TransferChecked { from: a.from.to_account_info(), mint: a.usdc_mint.to_account_info(), to: a.vault.to_account_info(), authority: a.game.to_account_info() },
            &[seeds],
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    let player = &mut ctx.accounts.player;
    player.balance = player.balance.checked_add(amount).ok_or(SkechError::Overflow)?;
    emit!(Deposited { player: player.authority, amount, swept: true });
    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = vault, has_one = usdc_mint, has_one = token_program)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [PLAYER_SEED, authority.key().as_ref()], bump = player.bump, has_one = authority)]
    pub player: Box<Account<'info, Player>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = token_program)]
    pub to: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Take USDC out of the balance to any token account. Always open, paused or not: only the wallet can sign it.
pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, SkechError::ZeroAmount);
    let player = &mut ctx.accounts.player;
    require!(player.balance >= amount, SkechError::Insufficient);
    player.balance -= amount;
    let a = &ctx.accounts;
    let seeds: &[&[u8]] = &[GAME_SEED, &[a.game.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            TransferChecked { from: a.vault.to_account_info(), mint: a.usdc_mint.to_account_info(), to: a.to.to_account_info(), authority: a.game.to_account_info() },
            &[seeds],
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    emit!(Withdrawn { player: a.authority.key(), to: a.to.key(), amount });
    Ok(())
}

#[derive(Accounts)]
pub struct SetSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump)]
    pub game: Box<Account<'info, Game>>,
    #[account(init_if_needed, payer = payer, space = 8 + Player::INIT_SPACE, seeds = [PLAYER_SEED, authority.key().as_ref()], bump)]
    pub player: Box<Account<'info, Player>>,
    pub system_program: Program<'info, System>,
}

/// Let `key` place pieces for this wallet until `valid_until` (unix seconds), staking at most `allowance` in all.
/// Replaces any session.
pub fn set_session(ctx: Context<SetSession>, key: Pubkey, valid_until: i64, allowance: u64) -> Result<()> {
    let game = &ctx.accounts.game;
    require!(!game.paused, SkechError::Paused);
    let now = Clock::get()?.unix_timestamp;
    require!(key != Pubkey::default() && valid_until > now && valid_until <= now + game.config.max_session_secs, SkechError::BadSession);
    let (authority, payer, bump) = (ctx.accounts.authority.key(), ctx.accounts.payer.key(), ctx.bumps.player);
    let player = &mut ctx.accounts.player;
    open_player(player, authority, payer, bump);
    player.session = Session { key, valid_until, allowance };
    emit!(SessionSet { player: authority, key, valid_until, allowance });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, authority.key().as_ref()], bump = player.bump, has_one = authority)]
    pub player: Account<'info, Player>,
}

/// End the session now.
pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
    ctx.accounts.player.session = Session::default();
    emit!(SessionRevoked { player: ctx.accounts.authority.key() });
    Ok(())
}
