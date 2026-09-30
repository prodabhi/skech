//! What the game keeps on chain. Every account a placement writes is the player's own (their `Player` and the
//! new `Bet`) plus the `Pool`, so placements by different players only meet on the pool. `Game` and `Market`
//! are read-only to players; the `Bars` ring is written once a second by the oracle.

use anchor_lang::prelude::*;

pub const GAME_SEED: &[u8] = b"game";
pub const POOL_SEED: &[u8] = b"pool";
pub const MARKET_SEED: &[u8] = b"market";
pub const BARS_SEED: &[u8] = b"bars";
pub const PLAYER_SEED: &[u8] = b"player";
pub const BET_SEED: &[u8] = b"bet";
pub const REWARDS_SEED: &[u8] = b"rewards";
pub const HOLDER_SEED: &[u8] = b"holder";

/// Seconds ahead a band may be.
pub const HORIZON: u8 = 30;
/// Sections in one piece, at most: a piece with 32 fills a transaction (1232 bytes) with a lookup table.
pub const MAX_SECTIONS: usize = 32;
/// How tall a band may be, in grid units: the widest pen the apps offer, at the smallest chart they draw (a 120 px plot
/// showing 6.75 market steps of 50 units each: 6750 / 120 = 56.25 units), with a little room over. A band past it is not
/// ink a pen drew: one over the whole map at second 1 is all but certain, and churning certain ink would move the pool's
/// money to SKT holders through the stake fee (`packages/core/src/chain.ts` `MAX_SECTION_WIDTH`, the same number).
pub const MAX_SECTION_WIDTH: u16 = 64;
/// Seconds of price the ring keeps: the horizon, the grace and plenty of room for a relayer that falls behind.
pub const BAR_RING: usize = 240;
/// How long after a second is over its bar may still be posted, seconds: inside the ring by the horizon and the most
/// grace the config allows, so a late bar never lands in a slot a newer second holds. Once it is past, a band in
/// that second can never be decided, and `expire` gives its stake back.
pub const BAR_LATE: i64 = 200;
const _: () = assert!(BAR_LATE as usize + HORIZON as usize + (MAX_PLACE_GRACE_MS / 1000) as usize <= BAR_RING);
/// A grid unit is at most this small a part of the price: it pads every band, so it cannot be let grow.
pub const PRICE_UNITS: u128 = 2000;
/// How fast an IOU may be set to grow, at most, x1e18 a second: 1% a day.
pub const MAX_IOU_RATE: u64 = 115_740_740_740;
/// An IOU share's index at the start, x1e18: one share was worth one millionth of a USDC.
pub const INDEX_ONE: u128 = 1_000_000_000_000_000_000;
pub const BPS: u64 = 10_000;

/// The most a fee may be set to, bps: of a stake, of a hit's profit, of an IOU's growth to its redeemer.
pub const MAX_FEE_BPS: u16 = 2000;
pub const MAX_PROFIT_FEE_BPS: u16 = 5000;
pub const MAX_SWEEP_BPS: u16 = 5000;
/// What the placing grace may be set to, ms, and how late the oracle may have had a piece at most.
pub const MIN_PLACE_GRACE_MS: u32 = 1000;
pub const MAX_PLACE_GRACE_MS: u32 = 10_000;
pub const MAX_LATE_MS: u32 = 1000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub struct Config {
    /// Of every stake, as it is placed, to the house.
    pub fee_bps: u16,
    /// Of every hit's profit, to the house.
    pub profit_fee_bps: u16,
    /// Of an IOU's growth, to whoever redeems it for someone else.
    pub sweep_bps: u16,
    /// How late after its opening second the oracle may have received a piece, ms.
    pub late_ms: u32,
    /// How far from its opening second a placement may land, and how early a second may be posted, ms.
    pub place_grace_ms: u32,
    /// How old the price a player saw may be when the oracle received the piece, ms.
    pub max_price_age_ms: u32,
    /// What a dot may cost, USDC e6.
    pub min_per_dot: u64,
    pub max_per_dot: u64,
    /// The most one piece may stake, USDC e6.
    pub max_piece_stake: u64,
    /// The least a partial IOU redemption may be worth, USDC e6.
    pub min_redeem: u64,
    /// How far ahead a session may be set to expire, seconds.
    pub max_session_secs: i64,
}

impl Config {
    /// What `initialize` sets: Monad's terms, `SkechGame.initialize`'s, field for field (a test holds them to it).
    pub const DEFAULT: Config = Config {
        fee_bps: 400,
        profit_fee_bps: 1000,
        sweep_bps: 1000,
        late_ms: 200,
        place_grace_ms: 3000,
        max_price_age_ms: 15_000,
        min_per_dot: 10_000,             // 1 cent
        max_per_dot: 100_000_000,        // $100
        max_piece_stake: 10_000_000_000, // $10,000
        min_redeem: 10_000,
        // Solana's own: Monad's sessions are bounded by the signature that registers them.
        max_session_secs: 30 * 86_400,
    };
}

/// The game: who runs it, what it trades in, and its terms. Its PDA owns the vault.
#[account]
#[derive(InitSpace)]
pub struct Game {
    pub admin: Pubkey,
    /// Set by `propose_admin`, takes over on `accept_admin`: an admin is never handed to a key that cannot sign.
    pub pending_admin: Pubkey,
    /// Signs every placement (its quote) and every bar.
    pub oracle: Pubkey,
    pub usdc_mint: Pubkey,
    /// The token program the mint is under: SPL Token (`initialize` takes no other).
    pub token_program: Pubkey,
    /// Every player's USDC, the pool and the fees: the game PDA's associated token account.
    pub vault: Pubkey,
    /// Where collected fees go: a token account of the treasury (a multisig on mainnet).
    pub treasury: Pubkey,
    /// What every piece a session key signs starts with: sha256("skech/v1" || program id || cluster), so a
    /// signature for devnet never places on mainnet, or on another deployment.
    pub domain: [u8; 32],
    pub paused: bool,
    pub config: Config,
    pub bump: u8,
}

/// The money that is not anyone's balance: what backs live stakes and pays hits, and the house's fees.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// USDC backing live stakes and paying hits, e6.
    pub pool: u64,
    /// Fees taken and not yet collected, e6.
    pub fees: u64,
    /// An IOU share's value at `iou_time_at`, x1e18, rising by `iou_rate` every second.
    pub iou_index_at: u128,
    pub iou_rate: u64,
    pub iou_time_at: i64,
    /// Every share outstanding, the house's included.
    pub iou_shares: u128,
    /// What the house was owed in fees the pool could not pay at once. No longer added to: the house's cut is taken
    /// only from what the pool has left. Kept, for what an earlier version issued, and for the account's layout.
    pub house_shares: u128,
    pub house_basis: u64,
    pub bump: u8,
}

impl Pool {
    pub fn index(&self, now: i64) -> u128 {
        let dt = (now - self.iou_time_at).max(0) as u128;
        self.iou_index_at + self.iou_rate as u128 * dt
    }
    /// What `shares` are worth now, e6, rounded down.
    pub fn value_of(&self, shares: u128, now: i64) -> u64 {
        (shares * self.index(now) / INDEX_ONE) as u64
    }
    /// How many shares `value` is worth now, rounded up: an IOU is never worth less than what was owed.
    pub fn shares_for(&self, value: u64, now: i64) -> u128 {
        let index = self.index(now);
        (value as u128 * INDEX_ONE).div_ceil(index)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub id: u8,
    /// Open to new pieces. Closed, its bars are still posted and its bets still settled.
    pub active: bool,
    /// 50 to 100: how hard the game is here. Pieces placed from now on pay by it.
    pub difficulty: u8,
    /// What the engine calls it: "BTC-USD".
    #[max_len(16)]
    pub name: String,
    pub bump: u8,
}

/// One second of the price, 8 decimals: from the second before's close to this one's high, low and close.
#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct Bar {
    /// The second it is, ms since the epoch on the exchange's clock; 0 is an empty slot.
    pub second: i64,
    pub prev_close: u64,
    pub high: u64,
    pub low: u64,
    pub close: u64,
}

/// The last `BAR_RING` seconds of a market's price, one slot per second. A slot is reused when its second comes
/// round again, and never by an older one: a second, once posted, is that bar for as long as anything can read it.
#[account(zero_copy)]
pub struct Bars {
    pub market: u8,
    pub _pad: [u8; 7],
    /// The latest second posted, ms.
    pub last: i64,
    pub ring: [Bar; BAR_RING],
}

impl Bars {
    pub const SPACE: usize = 8 + std::mem::size_of::<Bars>();

    fn slot(second: i64) -> usize {
        (second.div_euclid(1000)).rem_euclid(BAR_RING as i64) as usize
    }
    /// The bar for `second`, if it is posted and still in the ring.
    pub fn at(&self, second: i64) -> Option<&Bar> {
        let b = &self.ring[Self::slot(second)];
        (b.second == second && second != 0).then_some(b)
    }
    /// Whether `second`'s bar can no longer be posted, at `now_ms`.
    pub fn too_late(second: i64, now_ms: i64) -> bool {
        second + 1000 + BAR_LATE * 1000 < now_ms
    }
    /// Put `bar` in its slot, unless the slot holds a newer second.
    pub fn put(&mut self, bar: Bar) -> bool {
        let slot = &mut self.ring[Self::slot(bar.second)];
        if slot.second > bar.second {
            return false;
        }
        *slot = bar;
        if bar.second > self.last {
            self.last = bar.second;
        }
        true
    }
}

/// A player's session key: an Ed25519 key their app keeps, which may place pieces for them, up to an allowance,
/// until it expires. It can never withdraw.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct Session {
    pub key: Pubkey,
    /// Unix seconds, by the chain's clock.
    pub valid_until: i64,
    /// USDC e6 the session may still stake.
    pub allowance: u64,
}

/// A player: their balance in the game, their session and what they are owed. Keyed by their wallet.
#[account]
#[derive(InitSpace)]
pub struct Player {
    pub authority: Pubkey,
    /// USDC e6, theirs to play with or take out.
    pub balance: u64,
    pub session: Session,
    /// IOU shares they hold, and what they were owed when those were issued.
    pub iou_shares: u128,
    pub iou_basis: u64,
    /// Who paid this account's rent; it goes back to them if the account is ever closed.
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// A band of a bet as placed: `lo` to `hi` (8 decimals, on the grid), `second` seconds after it opens, staking
/// `stake` and paying `rung` (x100) if the price reaches it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct BetSection {
    pub second: u8,
    pub lo: u64,
    pub hi: u64,
    pub stake: u64,
    pub rung: u16,
}

/// One bet: a piece of a drawing as placed. It lives until every band in it is decided, then is closed and its rent
/// goes back to whoever paid it.
#[account]
#[derive(InitSpace)]
pub struct Bet {
    /// The player's wallet.
    pub player: Pubkey,
    pub drawing: u64,
    pub index: u32,
    pub market: u8,
    pub difficulty: u8,
    pub live_mask: u32,
    pub hit_mask: u32,
    /// The second it opened on, ms.
    pub open_at: i64,
    pub per_dot: u64,
    pub unit: u64,
    pub stake: u64,
    pub rent_payer: Pubkey,
    /// Sized per bet, by `space`.
    #[max_len(0)]
    pub sections: Vec<BetSection>,
}

impl Bet {
    /// Everything but the sections.
    pub const FIXED: usize = 8 + Bet::INIT_SPACE;
    /// Where `live_mask` is in a bet's bytes, `hit_mask` right after it: the discriminator, the player (32), the
    /// drawing (8), the index (4), the market and the difficulty (1 each).
    pub const LIVE_MASK_AT: usize = 8 + 32 + 8 + 4 + 1 + 1;
    /// The bet as it is serialized: what a bet placed before SKT is, all of it.
    pub fn space(sections: usize) -> usize {
        Self::FIXED + sections * BetSection::INIT_SPACE
    }
    /// The bet and, after it, each section's chance as the oracle quoted it (u32, billionths, little-endian), which
    /// SKT's basis reads: outside the struct, so the struct and every bet placed before it keep their bytes.
    pub fn space_with_chances(sections: usize) -> usize {
        Self::space(sections) + sections * 4
    }
    /// The chances after a bet of `sections` in `data`; none for a bet placed before they were kept.
    pub fn chances(data: &[u8], sections: usize) -> Option<[u32; MAX_SECTIONS]> {
        let at = Self::space(sections);
        let bytes = data.get(at..at + sections * 4)?;
        let mut out = [0u32; MAX_SECTIONS];
        for (i, c) in bytes.chunks_exact(4).enumerate().take(MAX_SECTIONS) {
            out[i] = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        }
        Some(out)
    }
}

/* ---- SKT: what losing earns back, and the holders' share of the fees (skt.rs has the rules) ---- */

/// SKT a dollar of basis mints while the tracked gain is nothing: 100. SKT and USDC are both in millionths.
pub const SKT_PER_USDC: u128 = 100;
/// The holders' accumulator is USDC e6 per share, times this. Fine enough that a single micro-USDC shared among the
/// most shares there can be (under 2^74) still moves it; and with at least MIN_TOTAL_SHARES shares whenever anything
/// accrues, an era's accumulator never passes every u64 of USDC times this over 1e6, under 2^128.
pub const ACC_SCALE: u128 = 1_000_000_000_000_000_000_000_000;
/// Fewer shares than this (one SKT at an era's start) and nothing is shared: the holders' part goes to the treasury.
pub const MIN_TOTAL_SHARES: u128 = 1_000_000;
/// The most `mint_scale` may be, USDC e6: $1B. The whole curve is worth 100 · S SKT, so every SKT ever minted is under
/// 2^57, and a share (an SKT times its weight, under 2^ERA_HALVINGS) under 2^73.
pub const MAX_MINT_SCALE: u64 = 1_000_000_000_000_000;
/// Half-lives in an era. A share minted at time t weighs 2^((t − era start) / half-life), so 1 to 2^16 within one; at
/// each era's end every share is divided by 2^16 (`Rewards::catch_up`), lazily for each holder, so no number grows
/// without bound however long the game runs.
pub const ERA_HALVINGS: u32 = 16;
/// Eras whose closing accumulator is kept: a holder untouched for longer loses what their shares earned in the era
/// they were last touched in (it stays in `holder_funds`; never anyone else's). At the shortest half-life that is 128
/// half-lives, 10 years; at the default, 64. Two eras on, an untouched holder's shares are 2^-32 of a fresh mint's.
pub const ERAS_KEPT: usize = 8;
/// What the half-life may be set to, seconds: 4 weeks to 10 years.
pub const MIN_HALF_LIFE_SECS: u32 = 28 * 86_400;
pub const MAX_HALF_LIFE_SECS: u32 = 3_650 * 86_400;
/// The least a wallet's cap may be, bps of all shares: 1%. 10,000 is no cap.
pub const MIN_WALLET_CAP_BPS: u16 = 100;

/// SKT's terms, set beside `Config`: `Config` lives in `Game`, whose layout stays as it is on chain.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub struct RewardsConfig {
    /// Of every stake, to SKT holders: part of `Config::fee_bps`, never more.
    pub holder_fee_bps: u16,
    /// Of every hit's profit, to SKT holders: part of `Config::profit_fee_bps`, never more.
    pub holder_profit_fee_bps: u16,
    /// `S` in the mint curve, USDC e6: at tracked gain G a dollar of basis mints 100 · (S / (S + G))² SKT. Fixed once
    /// anything has minted.
    pub mint_scale: u64,
    /// SKT's half-life, seconds: a balance halves every this long, so a player keeps their share only by playing on.
    pub half_life_secs: u32,
    /// No mint takes a wallet past this share of all shares, bps (10,000: no cap)…
    pub wallet_cap_bps: u16,
    /// …or past that share of this much SKT (e6), whichever is more: so the first players mint while there is little.
    pub cap_floor: u64,
    /// USDC e6 the pool keeps, over what every live bet could pay, before any of its surplus is shared with holders.
    pub surplus_reserve: u64,
    /// Of the pool's surplus, to SKT holders, bps; the rest to the treasury.
    pub surplus_holder_bps: u16,
}

impl RewardsConfig {
    /// 3 of the 4 stake points and 8 of the 10 profit points to holders; the curve's scale $1,000,000, so the rate falls
    /// across a tracked gain of $0 to $10M: 100 SKT a dollar at 0, 25 at $1M, 0.83 at $10M. A half-life of 26 weeks; no
    /// wallet past 10% of all SKT, or past 100,000 SKT while there is under a million. The pool keeps $2,457,600 over
    /// what live bets could pay: three times the most one piece can pay at the default terms (`max_piece_payout`); of
    /// what it holds over that, 75% goes to holders and 25% to the treasury.
    pub const DEFAULT: RewardsConfig = RewardsConfig {
        holder_fee_bps: 300,
        holder_profit_fee_bps: 800,
        mint_scale: 1_000_000_000_000,
        half_life_secs: 26 * 7 * 86_400,
        wallet_cap_bps: 1_000,
        cap_floor: 1_000_000_000_000,
        surplus_reserve: 2_457_600_000_000,
        surplus_holder_bps: 7_500,
    };
}

/// The most one piece can pay, gross, at `c`: each of its MAX_SECTIONS bands at most 256 dots at the dearest dot
/// (`ladder::max_stake`), and the whole at most its stake at the top rung.
pub fn max_piece_payout(c: &Config) -> u64 {
    let bands = MAX_SECTIONS as u128 * crate::ladder::MAX_DOTS as u128 * c.max_per_dot as u128;
    let stake = c.max_piece_stake as u128 * *crate::ladder::RUNGS.last().unwrap() as u128 / 100;
    bands.min(stake).min(u64::MAX as u128) as u64
}

/// SKT's global state: the shares, the holders' accumulator and the USDC set aside for them, the tracked gain the mint
/// curve reads, the decay's clock, and what live bets could pay. Every SKT stays staked on the `Holder` it was minted to:
/// there is no token to move.
#[account]
#[derive(InitSpace)]
pub struct Rewards {
    pub config: RewardsConfig,
    /// SKT minted, ever, as each mint was worth when it was minted (millionths): the record, not what is held now.
    pub supply: u64,
    /// Every holder's shares, in this era's units: each SKT minted at time t adds 2^((t − era start) / half-life).
    pub total_shares: u128,
    /// USDC e6 each share has earned this era, times `ACC_SCALE`. Back to 0 at each era's start.
    pub acc: u128,
    /// USDC e6 in the vault that is the holders': accrued and not yet claimed, the accumulator's rounding dust with it.
    pub holder_funds: u64,
    /// Every holder share ever accrued, and every claim paid out: `holder_funds` is the one less the other.
    pub accrued_total: u64,
    pub claimed_total: u64,
    /// The tracked gain, USDC e6: every basis SKT has been minted on since it began, which is what players have lost
    /// to the game in expectation. The mint curve reads it.
    pub gain: u64,
    /// The era: shares and `acc` are in its units.
    pub era: u32,
    /// `acc` at the end of each of the last ERAS_KEPT eras, at era % ERAS_KEPT.
    pub era_ends: [u128; ERAS_KEPT],
    /// A share's weight at `anchor_time`, as its log2 times 2^32: under ERA_HALVINGS · 2^32 once caught up.
    pub anchor_log2: u64,
    pub anchor_time: i64,
    /// The most every live bet placed since SKT started could pay, gross, every band hitting: what the pool keeps,
    /// with the reserve, before any surplus is shared.
    pub liability: u64,
    /// Pool surplus shared with holders, ever.
    pub swept_total: u64,
    /// When SKT started: no surplus is shared until every bet placed before then, whose liability is not counted, is
    /// decided or given back.
    pub started_at: i64,
    pub bump: u8,
    /// Room for what comes later, without a realloc.
    pub _reserved: [u8; 32],
}

/// A player's SKT: their shares (always staked; their SKT now is the shares over today's weight), what it has
/// earned, and the basis it was minted on. Keyed by their wallet; opened by the first settlement that mints for them,
/// so nobody who never loses costs its rent.
#[account]
#[derive(InitSpace, Default, PartialEq, Eq, Debug)]
pub struct Holder {
    pub player: Pubkey,
    /// Shares, in era `era`'s units.
    pub shares: u128,
    pub era: u32,
    /// `Rewards::acc` (of era `era`) when what these shares had earned was last counted into `unclaimed`.
    pub acc_at: u128,
    /// USDC e6 earned and not yet claimed.
    pub unclaimed: u64,
    pub claimed: u64,
    /// Every basis their SKT was minted on, USDC e6: the odds-weighted loss of each band of theirs that missed.
    pub basis: u64,
    /// Every SKT minted to them, as each mint was worth when it was minted.
    pub minted: u64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl Holder {
    pub const SPACE: usize = 8 + Holder::INIT_SPACE;
}
