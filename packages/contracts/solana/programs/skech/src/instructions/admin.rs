//! Setting the game up and running it. Only the program's upgrade authority may initialize (so nobody can take a
//! fresh deployment before its owner does); after that the admin, a multisig on mainnet, sets everything.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::SkechError;
use crate::events::{AdminProposed, AdminSet, ConfigSet, IouRateSet, MarketSet, OracleSet, PausedSet, RewardsConfigSet, TreasurySet};
use crate::ladder;
use crate::program::Skech;
use crate::state::*;
// Named, not only globbed: the prelude has a `Rewards` too (the sysvar).
use crate::state::Rewards;

/// sha256("skech/v1" || program id || cluster): what every signed piece starts with.
pub fn domain_for(program_id: &Pubkey, cluster: &str) -> [u8; 32] {
    hashv(&[b"skech/v1", program_id.as_ref(), cluster.as_bytes()]).to_bytes()
}

/// The game's terms and SKT's, together: the holders' part of each fee is part of that fee, never more of it.
pub fn check_config(c: &Config, r: &RewardsConfig) -> Result<()> {
    require!(c.fee_bps <= MAX_FEE_BPS && c.profit_fee_bps <= MAX_PROFIT_FEE_BPS && c.sweep_bps <= MAX_SWEEP_BPS, SkechError::BadConfig);
    require!(c.min_per_dot > 0 && c.min_per_dot <= c.max_per_dot && c.max_per_dot <= u32::MAX as u64, SkechError::BadConfig);
    require!(c.max_piece_stake > 0, SkechError::BadConfig);
    require!((MIN_PLACE_GRACE_MS..=MAX_PLACE_GRACE_MS).contains(&c.place_grace_ms) && c.late_ms <= MAX_LATE_MS, SkechError::BadConfig);
    require!(c.max_price_age_ms > 0 && c.max_session_secs > 0, SkechError::BadConfig);
    require!(r.holder_fee_bps <= c.fee_bps && r.holder_profit_fee_bps <= c.profit_fee_bps, SkechError::BadConfig);
    require!(r.mint_scale > 0 && r.mint_scale <= MAX_MINT_SCALE, SkechError::BadConfig);
    require!((MIN_HALF_LIFE_SECS..=MAX_HALF_LIFE_SECS).contains(&r.half_life_secs), SkechError::BadConfig);
    require!((MIN_WALLET_CAP_BPS..=BPS as u16).contains(&r.wallet_cap_bps), SkechError::BadConfig);
    // The pool always keeps at least what one piece could pay at these terms over what live bets could.
    require!(r.surplus_reserve >= max_piece_payout(c), SkechError::BadConfig);
    require!(r.surplus_holder_bps as u64 <= BPS, SkechError::BadConfig);
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Game::INIT_SPACE, seeds = [GAME_SEED], bump)]
    pub game: Account<'info, Game>,
    #[account(init, payer = authority, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED], bump)]
    pub pool: Account<'info, Pool>,
    /// SPL Token only: a Token-2022 mint's extensions (a transfer fee, a permanent delegate) could leave the vault
    /// holding less than the balances, the pool and the fees it backs.
    #[account(owner = anchor_spl::token::ID @ SkechError::NotSplToken, mint::token_program = token_program)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    /// The game's associated token account. It may already exist: anyone can create another wallet's, and that
    /// must not stop the game being set up.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = game,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(token::mint = usdc_mint, token::token_program = token_program)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ SkechError::NotUpgradeAuthority)]
    pub program: Program<'info, Skech>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ SkechError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>, cluster: String, oracle: Pubkey, iou_rate: u64) -> Result<()> {
    require!(!cluster.is_empty() && cluster.len() <= 32, SkechError::BadConfig);
    require!(oracle != Pubkey::default() && iou_rate <= MAX_IOU_RATE, SkechError::BadConfig);
    let game = &mut ctx.accounts.game;
    game.admin = ctx.accounts.authority.key();
    game.pending_admin = Pubkey::default();
    game.oracle = oracle;
    game.usdc_mint = ctx.accounts.usdc_mint.key();
    game.token_program = ctx.accounts.token_program.key();
    game.vault = ctx.accounts.vault.key();
    game.treasury = ctx.accounts.treasury.key();
    game.domain = domain_for(ctx.program_id, &cluster);
    game.paused = false;
    game.config = Config::DEFAULT;
    game.bump = ctx.bumps.game;
    let pool = &mut ctx.accounts.pool;
    pool.iou_index_at = INDEX_ONE;
    pool.iou_rate = iou_rate;
    pool.iou_time_at = Clock::get()?.unix_timestamp;
    pool.bump = ctx.bumps.pool;
    emit!(ConfigSet { config: game.config });
    emit!(OracleSet { oracle });
    emit!(IouRateSet { rate: iou_rate });
    Ok(())
}

#[derive(Accounts)]
pub struct Admin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    /// Read for SKT's split of the fees, which the new terms must leave room for. Its owner and discriminator make
    /// it the one `Rewards` (see `Place`).
    pub rewards: Account<'info, Rewards>,
}

pub fn set_config(ctx: Context<SetConfig>, config: Config) -> Result<()> {
    check_config(&config, &ctx.accounts.rewards.config)?;
    ctx.accounts.game.config = config;
    emit!(ConfigSet { config });
    Ok(())
}

#[derive(Accounts)]
pub struct InitRewards<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    #[account(init, payer = admin, space = 8 + Rewards::INIT_SPACE, seeds = [REWARDS_SEED], bump)]
    pub rewards: Account<'info, Rewards>,
    pub system_program: Program<'info, System>,
}

/// Start SKT, and set the game's terms with it in one go: a game whose fees are below SKT's split (devnet's 1% and 5%)
/// is moved to terms that hold it, never left between. Once only; until it is sent nothing is placed, though bets live
/// across the upgrade settle and expire without it (`load_rewards`), minting nothing.
pub fn init_rewards(ctx: Context<InitRewards>, config: Config, rewards: RewardsConfig) -> Result<()> {
    check_config(&config, &rewards)?;
    ctx.accounts.game.config = config;
    let r = &mut ctx.accounts.rewards;
    r.config = rewards;
    r.bump = ctx.bumps.rewards;
    // The decay's clock and the surplus's start: from now.
    let now = Clock::get()?.unix_timestamp;
    r.anchor_time = now;
    r.started_at = now;
    emit!(ConfigSet { config });
    emit!(RewardsConfigSet { config: rewards });
    Ok(())
}

#[derive(Accounts)]
pub struct SetRewardsConfig<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    /// The one `Rewards`, by its owner and discriminator (see `Place`).
    #[account(mut)]
    pub rewards: Account<'info, Rewards>,
}

/// SKT's split of the fees and its other terms, from now on. What was accrued and minted stays. The mint curve's scale
/// is fixed once anything has minted: the tracked gain and every SKT minted are on the old scale's curve, and a new
/// scale would mint the next dollar as if the curve had been the new one all along (a larger scale, more than the
/// curve's whole worth in all; a smaller one, a cliff). It may be set until then.
pub fn set_rewards_config(ctx: Context<SetRewardsConfig>, rewards: RewardsConfig) -> Result<()> {
    check_config(&ctx.accounts.game.config, &rewards)?;
    let r = &mut ctx.accounts.rewards;
    require!(rewards.mint_scale == r.config.mint_scale || (r.gain == 0 && r.supply == 0), SkechError::MintScaleFixed);
    // A new half-life applies from now: every weight is kept where it is, and grows at the new pace after.
    if rewards.half_life_secs != r.config.half_life_secs {
        r.set_half_life(rewards.half_life_secs, Clock::get()?.unix_timestamp);
    }
    r.config = rewards;
    emit!(RewardsConfigSet { config: rewards });
    Ok(())
}

pub fn set_oracle(ctx: Context<Admin>, oracle: Pubkey) -> Result<()> {
    require_keys_neq!(oracle, Pubkey::default(), SkechError::BadConfig);
    ctx.accounts.game.oracle = oracle;
    emit!(OracleSet { oracle });
    Ok(())
}

pub fn set_paused(ctx: Context<Admin>, paused: bool) -> Result<()> {
    ctx.accounts.game.paused = paused;
    emit!(PausedSet { paused });
    Ok(())
}

pub fn propose_admin(ctx: Context<Admin>, admin: Pubkey) -> Result<()> {
    ctx.accounts.game.pending_admin = admin;
    emit!(AdminProposed { admin });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, constraint = game.pending_admin == new_admin.key() @ SkechError::NotPendingAdmin)]
    pub game: Account<'info, Game>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let game = &mut ctx.accounts.game;
    game.admin = game.pending_admin;
    game.pending_admin = Pubkey::default();
    emit!(AdminSet { admin: game.admin });
    Ok(())
}

#[derive(Accounts)]
pub struct SetTreasury<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    #[account(token::mint = game.usdc_mint)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
}

pub fn set_treasury(ctx: Context<SetTreasury>) -> Result<()> {
    ctx.accounts.game.treasury = ctx.accounts.treasury.key();
    emit!(TreasurySet { treasury: ctx.accounts.treasury.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct SetIouRate<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
}

/// How fast what is owed grows, from now on, x1e18 per second, at most `MAX_IOU_RATE`. What has accrued so far is kept.
pub fn set_iou_rate(ctx: Context<SetIouRate>, rate: u64) -> Result<()> {
    require!(rate <= MAX_IOU_RATE, SkechError::BadConfig);
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    pool.iou_index_at = pool.index(now);
    pool.iou_time_at = now;
    pool.iou_rate = rate;
    emit!(IouRateSet { rate });
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: u8)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [MARKET_SEED, &[id]], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = admin, space = Bars::SPACE, seeds = [BARS_SEED, &[id]], bump)]
    pub bars: AccountLoader<'info, Bars>,
    pub system_program: Program<'info, System>,
}

pub fn init_market(ctx: Context<InitMarket>, id: u8, name: String, difficulty: u8) -> Result<()> {
    require!((ladder::MIN_DIFFICULTY..=100).contains(&difficulty), SkechError::BadDifficulty);
    require!(!name.is_empty() && name.len() <= 16, SkechError::BadConfig);
    let market = &mut ctx.accounts.market;
    market.id = id;
    market.active = true;
    market.difficulty = difficulty;
    market.name = name.clone();
    market.bump = ctx.bumps.market;
    ctx.accounts.bars.load_init()?.market = id;
    emit!(MarketSet { market: id, name, active: true, difficulty });
    Ok(())
}

#[derive(Accounts)]
pub struct SetMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [MARKET_SEED, &[market.id]], bump = market.bump)]
    pub market: Account<'info, Market>,
}

/// Open or close a market, and set how hard it is, 50 to 100: below 50, ink exactly on a rung would return more than a
/// dollar. Pieces already open keep the difficulty they were placed at.
pub fn set_market(ctx: Context<SetMarket>, active: bool, difficulty: u8) -> Result<()> {
    require!((ladder::MIN_DIFFICULTY..=100).contains(&difficulty), SkechError::BadDifficulty);
    let market = &mut ctx.accounts.market;
    market.active = active;
    market.difficulty = difficulty;
    emit!(MarketSet { market: market.id, name: market.name.clone(), active, difficulty });
    Ok(())
}
