//! skech on Solana: draw ink ahead of the Bitcoin price, and the ink the price runs through pays.
//!
//! The house holds no money. Players deposit USDC; every stake goes into one pool; every hit is paid from it. The
//! house takes a fee on every stake and on every profit, and nothing else. When the pool cannot pay a hit, the
//! winner is owed IOU shares that grow every second and are paid off, by anyone, as the pool refills.
//!
//! The same game as `packages/contracts/evm`, built for how Solana works: one piece per transaction so players
//! place in parallel, an Ed25519 session key checked by the precompile against the piece in the instruction, the
//! oracle's quote and bars attested by it signing the transaction, the price in a ring of the last few minutes,
//! and every bet an account that is closed, rent back, once it is decided.
//!
//! Prices carry 8 decimals, USDC 6, time is in milliseconds on the exchange's clock, chances are in billionths.

use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod ladder;
pub mod piece;
pub mod skt;
pub mod state;

use instructions::*;
use piece::{PieceMessage, QuoteArgs};
use state::{Config, RewardsConfig};

declare_id!("2k9WY5YR357AGVVoBW6ouFHijEypTj8953fzSdD7HfRV");

#[program]
pub mod skech {
    use super::*;

    /* ---- setup and admin ---- */

    /// Set the game up: only the program's upgrade authority, who becomes its admin. `cluster` names where it runs
    /// ("devnet", "mainnet-beta", "localnet") and goes into every signed piece.
    pub fn initialize(ctx: Context<Initialize>, cluster: String, oracle: Pubkey, iou_rate: u64) -> Result<()> {
        admin::initialize(ctx, cluster, oracle, iou_rate)
    }
    pub fn init_market(ctx: Context<InitMarket>, id: u8, name: String, difficulty: u8) -> Result<()> {
        admin::init_market(ctx, id, name, difficulty)
    }
    pub fn set_market(ctx: Context<SetMarket>, active: bool, difficulty: u8) -> Result<()> {
        admin::set_market(ctx, active, difficulty)
    }
    pub fn set_config(ctx: Context<SetConfig>, config: Config) -> Result<()> {
        admin::set_config(ctx, config)
    }
    /// Start SKT (`Rewards`), setting the game's terms with it. Once only, by the admin.
    pub fn init_rewards(ctx: Context<InitRewards>, config: Config, rewards_config: RewardsConfig) -> Result<()> {
        admin::init_rewards(ctx, config, rewards_config)
    }
    pub fn set_rewards_config(ctx: Context<SetRewardsConfig>, rewards_config: RewardsConfig) -> Result<()> {
        admin::set_rewards_config(ctx, rewards_config)
    }
    pub fn set_oracle(ctx: Context<Admin>, oracle: Pubkey) -> Result<()> {
        admin::set_oracle(ctx, oracle)
    }
    pub fn set_paused(ctx: Context<Admin>, paused: bool) -> Result<()> {
        admin::set_paused(ctx, paused)
    }
    pub fn propose_admin(ctx: Context<Admin>, admin: Pubkey) -> Result<()> {
        admin::propose_admin(ctx, admin)
    }
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        admin::accept_admin(ctx)
    }
    pub fn set_treasury(ctx: Context<SetTreasury>) -> Result<()> {
        admin::set_treasury(ctx)
    }
    pub fn set_iou_rate(ctx: Context<SetIouRate>, rate: u64) -> Result<()> {
        admin::set_iou_rate(ctx, rate)
    }

    /* ---- money in and out, and sessions ---- */

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        money::deposit(ctx, amount)
    }
    pub fn sweep(ctx: Context<Sweep>) -> Result<()> {
        money::sweep(ctx)
    }
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        money::withdraw(ctx, amount)
    }
    pub fn set_session(ctx: Context<SetSession>, key: Pubkey, valid_until: i64, allowance: u64) -> Result<()> {
        money::set_session(ctx, key, valid_until, allowance)
    }
    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        money::revoke_session(ctx)
    }

    /* ---- playing ---- */

    /// Place one piece. `piece` must be the first argument: its bytes are what the session key signed.
    pub fn place(ctx: Context<Place>, piece: PieceMessage, quote: QuoteArgs) -> Result<()> {
        place::place(ctx, piece, quote)
    }
    pub fn post_bar(ctx: Context<PostBar>, market: u8, bar: BarInput) -> Result<()> {
        settle::post_bar(ctx, market, bar)
    }
    pub fn post_bar_and_settle<'info>(ctx: Context<'_, '_, 'info, 'info, PostBarAndSettle<'info>>, market: u8, bar: BarInput) -> Result<()> {
        settle::post_bar_and_settle(ctx, market, bar)
    }
    pub fn settle<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>, market: u8) -> Result<()> {
        settle::settle(ctx, market)
    }
    pub fn expire<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>, market: u8) -> Result<()> {
        settle::expire(ctx, market)
    }

    /* ---- what is owed, and fees ---- */

    pub fn redeem(ctx: Context<Redeem>, shares: u128) -> Result<()> {
        iou::redeem(ctx, shares)
    }
    pub fn redeem_house(ctx: Context<RedeemHouse>) -> Result<()> {
        iou::redeem_house(ctx)
    }
    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        iou::collect_fees(ctx)
    }

    /* ---- SKT ---- */

    /// What the player's SKT has earned, into their balance.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        claim::claim(ctx)
    }
    /// What the pool holds over its reserve and what live bets could pay, to SKT holders. Anyone may.
    pub fn share_surplus(ctx: Context<ShareSurplus>) -> Result<()> {
        surplus::share_surplus(ctx)
    }
}
