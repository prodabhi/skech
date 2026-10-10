//! SKT: what losing earns back. Every band that misses mints SKT at its settlement, on its basis; SKT never moves and is
//! always staked, decays with a half-life, and every SKT earns an equal part of the holders' share of the fees.
//!
//! - **The fees.** Of the stake fee, `holder_fee_bps` (3 of 4 points) is the holders'; of the profit fee,
//!   `holder_profit_fee_bps` (8 of 10). The house keeps the rest and every rounding. While anything is owed as IOU
//!   the holders' share goes to the pool, to pay it off; while (next to) no SKT exists, to the treasury. The mint is
//!   never changed by what is owed. What the pool holds over the reserve and what live bets could pay goes 75% to
//!   holders and 25% to the treasury (`share_surplus`), never while anything is owed.
//! - **Decay, as shares.** A mint of `skt` at time t adds `skt · 2^(t/h)` shares (h the half-life), and a holder's SKT
//!   at time t is `shares · 2^(−t/h)`. Every balance decays alike, so what decay changes is how a mint weighs against
//!   older ones: the holders' share is split by shares, which is by decayed balance, and an early loss earns less and
//!   less unless its player keeps playing. The weight is counted from the era's start, so it stays between 1 and 2^16;
//!   at each era's end (ERA_HALVINGS half-lives) every share is divided by 2^16, the total at once and each holder's
//!   when it is next touched, and the accumulator starts again, its last value kept for those still to catch up.
//! - **The accumulator.** Each share raises `acc` by `share · ACC_SCALE / total_shares`, rounded down. A holder's earnings
//!   are `shares · (acc − acc_at) / ACC_SCALE`, rounded down, counted into `unclaimed` before their shares change and
//!   before a claim; the shares of a holder behind by eras are divided down era by era as the total was, rounded down.
//!   So the holders' shares never add up to more than the total, and no holder is ever paid more than their part.
//! - **The basis.** A band of stake `s`, chance `p` (the oracle's, as quoted) and rung `m` that misses counts
//!   `s · [(1 − p·m) + f·p·(m − 1)] / (1 − p)`, with `f` the profit fee; a hit counts nothing. In expectation that is
//!   `s · [(1 − p·m) + f·p·(m − 1)]`, the band's expected loss with the profit fee a hit pays, whatever `p`: a 1% long
//!   shot and ink at the price earn the same SKT per dollar they can expect to lose. The stake fee is not added: it is
//!   taken from the stake a hit pays on, so it is in `s(1 − p·m)` already, and adding it would mint on ink that
//!   loses nothing (the audit's farm table: it makes near-certain ink mint more than a dollar's basis per real dollar).
//! - **The curve.** A dollar of basis mints `100 · (S / (S + G))²` SKT, where G is the tracked gain (every basis
//!   minted on so far, `Rewards::gain`) and S is `mint_scale`. A settlement's basis B mints the integral of that rate
//!   from G to G + B, `100 · S² · B / ((S + G)(S + G + B))`, and moves G on by B: one basis of B and two of B/2 mint the
//!   same, to the unit.
//! - **The cap.** No mint takes a wallet past `wallet_cap_bps` of all shares, or past that part of the floor while there
//!   is little, whichever is more; what would pass it is not minted (G still moves on). The floor is `cap_floor` SKT as
//!   if minted when SKT started and held by nobody: it decays as every SKT does, so it matters early and fades. Every
//!   share is counted against the larger of all shares and the floor's, so no wallet is paid more than its cap's part of
//!   anything shared; the floor's part goes to the treasury. One check per mint and per share,
//!   and it only ever mints and pays less. A player with many wallets is not stopped by it.

use anchor_lang::prelude::*;

use crate::error::SkechError;
use crate::events::{HolderAccrued, Minted};
use crate::ladder::CHANCE_ONE;
use crate::state::*;
// Named, not only globbed: the prelude has a `Rewards` too (the sysvar).
use crate::state::Rewards;

/// The holders' part of a fee taken at `fee_bps` on `amount`: `holder_bps` of it, rounded down, never more than the
/// fee (which is rounded up): the house keeps the rounding.
pub fn holder_part(amount: u64, holder_bps: u16, fee_bps: u16) -> u64 {
    let bps = holder_bps.min(fee_bps) as u64;
    // In u64 when it fits, which is always but for stakes past $1.8 trillion: u128 division costs compute.
    match amount.checked_mul(bps) {
        Some(x) => x / BPS,
        None => (amount as u128 * bps as u128 / BPS as u128) as u64,
    }
}

/// What a band that missed counts toward SKT, USDC e6: `stake · [(1 − p·m) + f·p·(m − 1)] / (1 − p)`, rounded down, with
/// `p` the chance in billionths, `m` the rung (x100) and `f` the profit fee (`profit_fee_bps`): the band's expected loss
/// with the profit fee a hit pays, over its chance of missing. Never less than 0 (a band returning more than its stake,
/// which the program no longer offers) nor more than the stake.
pub fn miss_basis(stake: u64, chance_e9: u32, rung_e2: u16, profit_fee_bps: u16) -> u64 {
    let (p, one, r) = (chance_e9 as u128, CHANCE_ONE as u128, rung_e2 as u128);
    if p >= one {
        return 0;
    }
    // In units of 1e-15: 1 = 1e4 · 100 · 1e9; p·m = 1e4 · P · R; f·p·(m − 1) = F · P · (R − 100); 1 − p = 1e6 (1e9 − P).
    // Each under 2^58, and the stake under 2^64: the product fits a u128.
    let bps = BPS as u128;
    let edge = (bps * 100 * one + profit_fee_bps as u128 * p * r.saturating_sub(100)).saturating_sub(bps * p * r);
    let under = bps * 100 * (one - p);
    (stake as u128 * edge / under).min(stake as u128) as u64
}

/// Where the holders' share of a fee goes now.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    /// To the holders, by the accumulator.
    Holders,
    /// To the pool: something is owed as IOU, and is paid first.
    Pool,
    /// To the treasury: there are (next to) no shares to share it.
    Treasury,
}

pub fn route(pool: &Pool, rewards: &Rewards) -> Route {
    if pool.iou_shares > 0 {
        Route::Pool
    } else if rewards.total_shares < MIN_TOTAL_SHARES {
        Route::Treasury
    } else {
        Route::Holders
    }
}

/// One era, as log2 of a weight, times 2^32.
const ERA_LOG2: u128 = (ERA_HALVINGS as u128) << 32;

impl Rewards {
    /// The holders' share of a stake's fee: money that is in nobody's balance or pool yet. What the floor keeps from
    /// holders (`accrue`) is the treasury's.
    pub fn share_stake_fee(&mut self, pool: &mut Pool, amount: u64, now: i64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        self.catch_up(now);
        match route(pool, self) {
            Route::Pool => pool.pool = pool.pool.checked_add(amount).ok_or(SkechError::Overflow)?,
            Route::Treasury => pool.fees = pool.fees.checked_add(amount).ok_or(SkechError::Overflow)?,
            Route::Holders => {
                let left = self.accrue(amount, now)?;
                pool.fees = pool.fees.checked_add(left).ok_or(SkechError::Overflow)?;
            }
        }
        Ok(())
    }

    /// The holders' share of a profit's fee. It is in the pool, which pays the hit gross; it leaves the pool only as
    /// far as the pool has it left after the player and the treasury, as the treasury's cut does, and never as a debt.
    /// Owed IOUs, it simply stays there.
    pub fn share_profit_fee(&mut self, pool: &mut Pool, amount: u64, now: i64) -> Result<()> {
        let taken = amount.min(pool.pool);
        if taken == 0 {
            return Ok(());
        }
        self.catch_up(now);
        match route(pool, self) {
            Route::Pool => {}
            Route::Treasury => {
                pool.pool -= taken;
                pool.fees = pool.fees.checked_add(taken).ok_or(SkechError::Overflow)?;
            }
            Route::Holders => {
                pool.pool -= taken;
                let left = self.accrue(taken, now)?;
                pool.fees = pool.fees.checked_add(left).ok_or(SkechError::Overflow)?;
            }
        }
        Ok(())
    }

    /// The floor's shares, in this era's units: `cap_floor` SKT as if minted when SKT started (weight 1, era 0) and held
    /// by nobody, so it decays as every SKT does.
    pub fn floor_shares(&self) -> u128 {
        shr(self.config.cap_floor as u128, ERA_HALVINGS as u128 * self.era as u128)
    }

    /// The shares a part is counted against: all of them, or, while there are fewer, the floor's. A wallet's mints never
    /// take it past `wallet_cap_bps` of the larger (`mint`), and every share is shared over the larger, so no wallet is
    /// ever paid more than that part of anything shared: not of its own fees recycled, nor of the pool's surplus. With
    /// no cap, all the shares.
    pub fn counted_shares(&self) -> u128 {
        if self.config.wallet_cap_bps as u64 >= BPS {
            return self.total_shares;
        }
        self.total_shares.max(self.floor_shares())
    }

    /// Share `amount` among every share there is, counted against `counted_shares`: what is not shared (the floor's
    /// part, while there are fewer shares than it) is returned, for the caller to give the treasury or keep. `acc` is
    /// rounded down: what the rounding leaves stays in `holder_funds`, never anyone's. Only with at least
    /// MIN_TOTAL_SHARES shares (`route`): with fewer, after catching up, nothing is shared.
    pub fn accrue(&mut self, amount: u64, now: i64) -> Result<u64> {
        // Into today's era first, so today's weight is under 2^ERA_HALVINGS. Too few shares left to share it: none of it.
        self.catch_up(now);
        if self.total_shares < MIN_TOTAL_SHARES {
            return Ok(amount);
        }
        let (t, d) = (self.total_shares, self.counted_shares());
        // amount · 1e24 can pass 2^128: through 256 bits.
        let add = mul_div(amount as u128, ACC_SCALE, d).ok_or(SkechError::Overflow)?;
        // Every holder's part, rounded down and counted on the accumulator's running total, adds up to at most the sum
        // of t · amount / d over every share: each is set aside rounded up, so the parts never pass what is set aside.
        let shared = mul_div_ceil(amount as u128, t, d).ok_or(SkechError::Overflow)? as u64;
        self.acc = self.acc.checked_add(add).ok_or(SkechError::Overflow)?;
        self.holder_funds = self.holder_funds.checked_add(shared).ok_or(SkechError::Overflow)?;
        self.accrued_total = self.accrued_total.checked_add(shared).ok_or(SkechError::Overflow)?;
        emit!(HolderAccrued { amount: shared, acc: self.acc, total_shares: t, era: self.era });
        Ok(amount - shared)
    }

    /// A share's weight now, as its log2 times 2^32, from the anchor on.
    pub fn log2_weight(&self, now: i64) -> u128 {
        let dt = (now - self.anchor_time).max(0) as u128;
        self.anchor_log2 as u128 + (dt << 32) / self.config.half_life_secs.max(1) as u128
    }

    /// Move into the era `now` is in, if a share's weight has reached 2^ERA_HALVINGS: every share is divided by that
    /// for each era passed (the total here, each holder's when next touched), the closing accumulator kept and a new
    /// one started at 0, and the weight counted from the new era's start.
    pub fn catch_up(&mut self, now: i64) {
        let l = self.log2_weight(now);
        if l < ERA_LOG2 {
            return;
        }
        let k = l / ERA_LOG2;
        let (old, new) = (self.era as u128, self.era as u128 + k);
        // The eras skipped whole accrued nothing; the one closing ends at `acc`. Only the last ERAS_KEPT matter.
        for e in new.saturating_sub(ERAS_KEPT as u128).max(old + 1)..new {
            self.era_ends[(e % ERAS_KEPT as u128) as usize] = 0;
        }
        if k <= ERAS_KEPT as u128 {
            self.era_ends[(old % ERAS_KEPT as u128) as usize] = self.acc;
        }
        self.era = new.min(u32::MAX as u128) as u32;
        self.acc = 0;
        self.total_shares = shr(self.total_shares, ERA_HALVINGS as u128 * k);
        self.anchor_log2 = (l - k * ERA_LOG2) as u64;
        self.anchor_time = now;
    }

    /// What `era`'s accumulator ended at, if it is one of the last ERAS_KEPT before this one.
    fn end_of(&self, era: u32) -> Option<u128> {
        (era < self.era && self.era - era <= ERAS_KEPT as u32).then(|| self.era_ends[era as usize % ERAS_KEPT])
    }

    /// A share's weight now, times 2^32: `2^(log2_weight / 2^32)`. Caught up first, it is under 2^(32 + ERA_HALVINGS).
    pub fn weight_q32(&self, now: i64) -> u128 {
        exp2_q32(self.log2_weight(now))
    }

    /// What `shares` of era `era` are worth in SKT (e6) at `now`: the shares over today's weight.
    pub fn balance_of(&self, shares: u128, era: u32, now: i64) -> u64 {
        let l = self.log2_weight(now);
        let (k, rest) = (l / ERA_LOG2, l % ERA_LOG2);
        let eras = (self.era.saturating_sub(era)) as u128 + k;
        let s = shr(shares, ERA_HALVINGS as u128 * eras);
        (s * (1u128 << 32) / exp2_q32(rest)).min(u64::MAX as u128) as u64
    }

    /// Change the half-life from now on: the weight is kept where it is now, and grows at the new pace after.
    pub fn set_half_life(&mut self, half_life_secs: u32, now: i64) {
        self.catch_up(now);
        self.anchor_log2 = self.log2_weight(now) as u64;
        self.anchor_time = now;
        self.config.half_life_secs = half_life_secs;
    }

    /// Mint `holder` SKT on a settlement's `basis`, USDC e6, from the tracked gain on, and move the tracked gain on by it:
    /// the curve's exact integral, whatever is owed, as shares at today's weight, and no more than the wallet's cap.
    /// What was minted, SKT e6.
    pub fn mint(&mut self, holder: &mut Holder, basis: u64, now: i64) -> Result<u64> {
        if basis == 0 {
            return Ok(0);
        }
        self.catch_up(now);
        let curve = mint_amount(self.config.mint_scale, self.gain, basis).min(u64::MAX as u128);
        self.gain = self.gain.saturating_add(basis);
        // What the shares earned so far is counted, and they are brought into this era, before they change.
        holder.settle_rewards(self)?;
        let w = self.weight_q32(now);
        let full = curve * w >> 32;
        // The cap: h + x ≤ c · max(T + x, F), so x ≤ max(c·F − h, (c·T − h) / (1 − c)), in shares now.
        let cap = self.config.wallet_cap_bps as u128;
        let shares = if cap < BPS as u128 {
            let (t, h, f) = (self.total_shares, holder.shares, self.floor_shares());
            // So the holder's shares stay within c of `counted_shares` from here on: the total only grows, and at an era's
            // end it, the floor and the holder's shares are all divided alike.
            let under_floor = (cap * f / BPS as u128).saturating_sub(h);
            let of_total = (cap * t).saturating_sub(BPS as u128 * h) / (BPS as u128 - cap);
            full.min(under_floor.max(of_total))
        } else {
            full
        };
        let skt = if shares == full { curve } else { (shares << 32) / w };
        let skt = skt.min((u64::MAX - self.supply) as u128) as u64;
        holder.shares += shares;
        holder.basis = holder.basis.saturating_add(basis);
        holder.minted = holder.minted.saturating_add(skt);
        self.total_shares += shares;
        self.supply += skt;
        if curve > 0 {
            let rate = (skt as u128 * 1_000_000 / basis as u128) as u64;
            emit!(Minted { player: holder.player, skt, shares, capped: (curve as u64).saturating_sub(skt), rate, basis });
        }
        Ok(skt)
    }
}

impl Holder {
    /// Count what these shares have earned since `acc_at` into `unclaimed`, rounded down, and bring them into the era
    /// `r` is in: divided by 2^ERA_HALVINGS for each era passed, as the total was. An era's earnings that are no longer
    /// kept (ERAS_KEPT back) are not counted: they stay in `holder_funds`.
    pub fn settle_rewards(&mut self, r: &Rewards) -> Result<()> {
        let mut earned: u128 = 0;
        if self.era == r.era {
            earned = mul_div(self.shares, r.acc.saturating_sub(self.acc_at), ACC_SCALE).ok_or(SkechError::Overflow)?;
        } else if self.shares > 0 {
            if let Some(end) = r.end_of(self.era) {
                earned += mul_div(self.shares, end.saturating_sub(self.acc_at), ACC_SCALE).ok_or(SkechError::Overflow)?;
            }
            let mut era = self.era;
            while era + 1 < r.era {
                era += 1;
                let s = shr(self.shares, ERA_HALVINGS as u128 * (era - self.era) as u128);
                if s == 0 {
                    break;
                }
                if let Some(end) = r.end_of(era) {
                    earned += mul_div(s, end, ACC_SCALE).ok_or(SkechError::Overflow)?;
                }
            }
            let s = shr(self.shares, ERA_HALVINGS as u128 * (r.era - self.era) as u128);
            earned += mul_div(s, r.acc, ACC_SCALE).ok_or(SkechError::Overflow)?;
            self.shares = s;
        }
        if earned > 0 {
            self.unclaimed = self.unclaimed.checked_add(u64::try_from(earned).map_err(|_| SkechError::Overflow)?).ok_or(SkechError::Overflow)?;
        }
        self.era = r.era;
        self.acc_at = r.acc;
        Ok(())
    }
}

/// SKT e6 a basis of `basis` mints from tracked gain `from` (both USDC e6): the integral of `100 · S² / (S + g)²` from
/// `from` to `from + basis`, `100 · S² · (1/(S + from) − 1/(S + from + basis))`. The first term is rounded down and the
/// second up: never more than the exact integral, and less by under 2 units; minted in pieces, less than in one go by
/// under a unit a piece.
pub fn mint_amount(scale: u64, from: u64, basis: u64) -> u128 {
    if basis == 0 || scale == 0 {
        return 0;
    }
    let s = scale as u128;
    // S ≤ MAX_MINT_SCALE, so 100 · S² < 2^128; S + from + basis < 2^66.
    let k = SKT_PER_USDC * s * s;
    let (lo, hi) = (s + from as u128, s + from as u128 + basis as u128);
    (k / lo).saturating_sub(k.div_ceil(hi))
}

/// The rate at tracked gain `g`, SKT per dollar times 1e6: for the curve's table, and tests.
pub fn rate_e6(scale: u64, g: u64) -> u128 {
    let (s, g) = (scale as u128, g as u128);
    if s == 0 {
        return 0;
    }
    SKT_PER_USDC * 1_000_000 * s / (s + g) * s / (s + g)
}

/// 2^(2^-i) for i = 1 to 32, times 2^62, rounded down (`conformance/reference.ts` has the same table).
pub const EXP2_TABLE: [u64; 32] = [
    6521908912666391106, 5484249825272419511, 5029079263719320435, 4815862801830788490, 4712668792719003883, 4661903986662671289, 4636727017470743990, 4624189567668517720,
    4617933561212708776, 4614808732577250068, 4613247111281068008, 4612466498810092974, 4612076242109103707, 4611881126141011236, 4611783571252412753, 4611734794581956353,
    4611710406440186475, 4611698212417665819, 4611692115418496524, 4611689066921934630, 4611687542674409371, 4611686780550835663, 4611686399489096040, 4611686208958238036,
    4611686113692811986, 4611686066060099699, 4611686042243743740, 4611686030335565806, 4611686024381476851, 4611686021404432376, 4611686019915910140, 4611686019171649022,
];

/// `2^(l / 2^32)` times 2^32, rounded down: the fraction's bits multiply the table's roots of 2 together, in 62 bits.
/// A whole part of 91 or more saturates (only a balance a century stale could ask, and it is shifted to 0 first).
pub fn exp2_q32(l: u128) -> u128 {
    let (whole, frac) = ((l >> 32).min(90) as u32, (l & 0xffff_ffff) as u32);
    let mut x: u128 = 1 << 62;
    for (i, root) in EXP2_TABLE.iter().enumerate() {
        if frac & (1 << (31 - i)) != 0 {
            x = x * *root as u128 >> 62;
        }
    }
    (x >> 30) << whole
}

/// `x / 2^bits`, rounded down, 0 past 127 bits.
pub fn shr(x: u128, bits: u128) -> u128 {
    if bits >= 128 {
        0
    } else {
        x >> bits
    }
}

/// `a · b / d`, rounded down, through 256 bits: None if it does not fit a u128 (or d is 0).
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    if let Some(p) = a.checked_mul(b) {
        return Some(p / d);
    }
    let (hi, lo) = mul_wide(a, b);
    if hi >= d {
        return None;
    }
    // Long division of hi:lo by d, a bit at a time; the remainder stays under d, with a carry for its 129th bit.
    let (mut rem, mut q) = (hi, 0u128);
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1;
        }
    }
    Some(q)
}

/// `a · b / d`, rounded up.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    let q = mul_div(a, b, d)?;
    let exact = mul_wide(q, d) == mul_wide(a, b);
    Some(if exact { q } else { q + 1 })
}

/// The full 256-bit product, as (high, low) halves.
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const M: u128 = u64::MAX as u128;
    let (a1, a0, b1, b0) = (a >> 64, a & M, b >> 64, b & M);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    ((p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64)), (p00 & M) | (mid << 64))
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1_000_000_000_000; // $1,000,000, the default
    const E6: u64 = 1_000_000;

    /// The integral in floating point, in the form that does not cancel: 100 · S² · B / ((S + a)(S + a + B)).
    fn reference(scale: u64, from: u64, basis: u64) -> f64 {
        let (s, a, b) = (scale as f64, from as f64, basis as f64);
        100.0 * (s / (s + a)) * (s / (s + a + b)) * b
    }

    fn rng(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    #[test]
    fn the_mint_matches_the_integral_in_floating_point() {
        let cases: &[(u64, u64)] = &[
            (0, E6),
            (0, 1),
            (1_000_000 * E6, E6),
            (10_000_000 * E6, 10_000_000 * E6),
            (0, 100_000_000 * E6),
            // Around $100M of tracked gain, a hundred times the default scale, where the curve has all but run out.
            (100_000_000 * E6, E6),
            (100_000_000 * E6, 1_000_000 * E6),
            (1_000_000_000 * E6, E6),
            (u64::MAX / 2, E6),
            // One enormous settlement: every u64 of basis at once.
            (0, u64::MAX),
            (u64::MAX / 2, u64::MAX / 2),
        ];
        for &(from, basis) in cases {
            let got = mint_amount(S, from, basis) as f64;
            let want = reference(S, from, basis);
            assert!(got <= want * (1.0 + 1e-12) + 1e-6, "{from} + {basis}: {got} over {want}");
            assert!(want - got < 2.0 + 1e-9 * want, "{from} + {basis}: {got} short of {want}");
        }
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        for _ in 0..20_000 {
            let from = rng(&mut seed) % (10_000_000 * E6);
            let basis = rng(&mut seed) % (50_000 * E6);
            let scale = 1 + rng(&mut seed) % (10_000_000 * E6);
            let got = mint_amount(scale, from, basis) as f64;
            let want = reference(scale, from, basis);
            assert!(got <= want * (1.0 + 1e-12) + 1e-6, "{from} + {basis} at {scale}: {got} over {want}");
            assert!(want - got < 2.0 + 1e-9 * want, "{from} + {basis} at {scale}: {got} short of {want}");
        }
    }

    fn skech_max() -> u64 {
        MAX_MINT_SCALE
    }

    #[test]
    fn a_basis_mints_the_same_in_one_go_or_in_pieces() {
        let mut seed = 42u64;
        for _ in 0..2_000 {
            let start = rng(&mut seed) % (2_000_000 * E6);
            let pieces = 1 + rng(&mut seed) % 20;
            let (mut at, mut sum) = (start, 0u128);
            for _ in 0..pieces {
                let b = rng(&mut seed) % (20_000 * E6);
                sum += mint_amount(S, at, b);
                at += b;
            }
            let whole = mint_amount(S, start, at - start);
            assert!(sum <= whole, "pieces {sum} over one go {whole}");
            assert!(whole - sum <= pieces as u128, "pieces {sum}, one go {whole}: more than a unit a piece apart");
        }
    }

    #[test]
    fn the_rate_is_the_table_in_the_docs() {
        // At G = 0, $100k, $500k, $1M, $3M, $10M: 100, 82.6, 44.4, 25, 6.25, 0.83 SKT a dollar.
        let at = |usd: u64| rate_e6(S, usd * E6) as f64 / 1e6;
        for (g, want) in [(0, 100.0), (100_000, 82.64), (500_000, 44.44), (1_000_000, 25.0), (3_000_000, 6.25), (10_000_000, 0.826)] {
            assert!((at(g) - want).abs() < 0.01, "rate at ${g}: {} not {want}", at(g));
        }
        // The first dollar mints all but a millionth of 100 SKT.
        assert_eq!(mint_amount(S, 0, E6), 99_999_900);
        let at_1m = mint_amount(S, 1_000_000 * E6, E6);
        assert!((24_999_900..=25_000_000).contains(&at_1m), "{at_1m}");
        let at_10m = mint_amount(S, 10_000_000 * E6, E6);
        assert!((826_440..=826_447).contains(&at_10m), "{at_10m}");
        // Far past the scale, at $100M: (1/101)² of the rate.
        let at_100m = mint_amount(S, 100_000_000 * E6, E6);
        assert!((9_800..=9_804).contains(&at_100m), "{at_100m}");
        // However much is lost, even every u64 of it in one settlement, the whole curve is worth 100 · S, to everyone
        // together: 100 million SKT at the default, and never an overflow.
        assert!(mint_amount(S, 0, 1_000_000_000 * E6) < 100 * S as u128);
        let all = mint_amount(S, 0, u64::MAX);
        assert!(all < 100 * S as u128 && all > 99 * S as u128, "{all}");
        // At the largest scale the admin may set, too.
        let big = skech_max();
        assert!(mint_amount(big, 0, u64::MAX) <= 100 * big as u128 && mint_amount(big, u64::MAX, u64::MAX) > 0);
    }

    /// `stake · [(1 − p·m) + f·p·(m − 1)] / (1 − p)` in floating point, at least 0 and at most the stake.
    fn basis_reference(stake: u64, chance: u32, rung: u16, fee_bps: u16) -> f64 {
        let (p, m, f) = (chance as f64 / 1e9, rung as f64 / 100.0, fee_bps as f64 / 1e4);
        if p >= 1.0 {
            return 0.0;
        }
        (stake as f64 * ((1.0 - p * m) + f * p * (m - 1.0)).max(0.0) / (1.0 - p)).min(stake as f64)
    }

    #[test]
    fn a_miss_counts_its_odds_weighted_loss_with_the_profit_fee() {
        // A 1% long shot at 96x, 10% profit fee: 1 − 0.96 + 0.1 · 0.01 · 95 = 13.5¢ a dollar expected; it misses 99
        // times in 100, each counting 13.5/0.99.
        assert_eq!(miss_basis(1_000_000, 10_000_000, 9600, 1000), 136_363);
        // With no profit fee, as before: 4¢, counted 4/0.99.
        assert_eq!(miss_basis(1_000_000, 10_000_000, 9600, 0), 40_404);
        // Ink at 50% paying 1.5x: 25¢ + 0.1 · 0.5 · 0.5 = 27.5¢ a dollar expected, counted twice over on the half that misses.
        assert_eq!(miss_basis(1_000_000, 500_000_000, 150, 1000), 550_000);
        // 90% at 1.1x: 1¢ + 0.1 · 0.9 · 0.1 = 1.9¢ a dollar expected, ten times over on the tenth that misses.
        assert_eq!(miss_basis(1_000_000, 900_000_000, 110, 1000), 190_000);
        // Certain: nothing. Paying its fair multiple: only the profit fee it would pay, 0.1 · 0.5 · 1 / 0.5.
        assert_eq!(miss_basis(1_000_000, 1_000_000_000, 100, 1000), 0);
        assert_eq!(miss_basis(1_000_000, 500_000_000, 200, 1000), 100_000);
        assert_eq!(miss_basis(1_000_000, 500_000_000, 200, 0), 0);
        // Returning more than its stake (no longer offered): nothing. No chance at all: the stake.
        assert_eq!(miss_basis(1_000_000, 600_000_000, 200, 0), 0);
        assert_eq!(miss_basis(1_000_000, 0, 9600, 1000), 1_000_000);
        // The most a section stakes (u32::MAX) at the most a fee may be (50%): no overflow, never over the stake.
        assert!(miss_basis(u32::MAX as u64, 1, 12800, 5000) <= u32::MAX as u64);
        assert!(miss_basis(u64::MAX, 999_999_999, 12800, 5000) <= u64::MAX);
        let mut seed = 5u64;
        for _ in 0..100_000 {
            let stake = rng(&mut seed) % 10_000_000_000;
            let chance = (rng(&mut seed) % 1_000_000_001) as u32;
            let rung = 100 + (rng(&mut seed) % 12_701) as u16;
            let fee = (rng(&mut seed) % 5001) as u16;
            let got = miss_basis(stake, chance, rung, fee);
            let want = basis_reference(stake, chance, rung, fee);
            assert!(got as f64 <= want * (1.0 + 1e-12) + 1e-6 && want - (got as f64) < 1.0 + 1e-9 * want, "{stake} at {chance}, {rung}, fee {fee}: {got}, {want}");
            assert!(got <= stake, "never more than the stake");
        }
    }

    #[test]
    fn in_expectation_a_miss_counts_the_bands_expected_loss_whatever_its_odds() {
        // (1 − p) · basis = s · [(1 − p·m) + f·p·(m − 1)], what the band loses on average with the profit fee a hit
        // pays, to within the rounding of one basis, for every chance and rung the ladder offers at 4%.
        let stake = 1_000_000_000u64;
        for fee in [0u16, 1000, 2500] {
            for d in [50u8, 51, 55, 70, 85, 100] {
                for chance in (1..=1000u32).map(|k| k * 1_000_000).chain([1, 999, 7_812_500, 999_999_999]) {
                    let rung = crate::ladder::rung_for(chance, d, false, 0);
                    if rung == 0 || !crate::ladder::within_fee(chance, rung, 400) {
                        continue;
                    }
                    let expected_basis = (CHANCE_ONE - chance) as u128 * miss_basis(stake, chance, rung, fee) as u128;
                    // In 1e-15 of a stake: 1e15 − 1e4·P·R + F·P·(R − 100).
                    let (p, r) = (chance as u128, rung as u128);
                    let edge = 1_000_000_000_000_000u128 + fee as u128 * p * (r - 100) - 10_000 * p * r;
                    let expected_loss = stake as u128 * edge / 1_000_000;
                    assert!(expected_basis <= expected_loss && expected_loss - expected_basis < CHANCE_ONE as u128, "fee {fee}, d {d}, chance {chance}, rung {rung}: {expected_basis} for {expected_loss}");
                }
            }
        }
    }

    #[test]
    fn holder_parts_never_exceed_the_fee() {
        let mut seed = 7u64;
        for _ in 0..50_000 {
            let amount = rng(&mut seed) % 10_000_000_000;
            let fee_bps = (rng(&mut seed) % 2001) as u16;
            let holder_bps = (rng(&mut seed) % 2001) as u16;
            let fee = (amount * fee_bps as u64).div_ceil(BPS);
            assert!(holder_part(amount, holder_bps, fee_bps) <= fee);
        }
        assert_eq!(holder_part(100_000, 300, 400), 3_000);
        assert_eq!(holder_part(25_000, 800, 1000), 2_000);
        // A stake of 49 at 4%: a fee of 2 (1.96 rounded up), 1 of it the holders' (1.47 down).
        assert_eq!(((49u64 * 400).div_ceil(BPS), holder_part(49, 300, 400)), (2, 1));
    }

    /// A fresh `Rewards` at time 0, with `total_shares` already held by holders made by the caller.
    fn rewards(total_shares: u128) -> Rewards {
        Rewards {
            config: RewardsConfig::DEFAULT,
            supply: 0,
            total_shares,
            acc: 0,
            holder_funds: 0,
            accrued_total: 0,
            claimed_total: 0,
            gain: 0,
            era: 0,
            era_ends: [0; ERAS_KEPT],
            anchor_log2: 0,
            anchor_time: 0,
            liability: 0,
            swept_total: 0,
            started_at: 0,
            bump: 0,
            _reserved: [0; 32],
        }
    }

    #[test]
    fn earnings_never_exceed_what_was_accrued() {
        let mut seed = 99u64;
        for _ in 0..200 {
            let n = 1 + (rng(&mut seed) % 6) as usize;
            let mut holders: Vec<Holder> = (0..n).map(|_| Holder { shares: 1_000_000 + (rng(&mut seed) % 1_000_000_000_000) as u128, ..Default::default() }).collect();
            let mut r = rewards(holders.iter().map(|h| h.shares).sum());
            let mut now = 0i64;
            for _ in 0..50 {
                // A fee, a holder minting (counted first), or time passing (eras with it), at random.
                match rng(&mut seed) % 4 {
                    0 => {
                        let i = (rng(&mut seed) % n as u64) as usize;
                        let basis = 1 + rng(&mut seed) % 10_000_000_000;
                        r.mint(&mut holders[i], basis, now).unwrap();
                    }
                    1 => now += (rng(&mut seed) % (40 * r.config.half_life_secs as u64)) as i64,
                    _ if r.total_shares >= MIN_TOTAL_SHARES => { r.accrue(rng(&mut seed) % 10_000_000_000, now).unwrap(); },
                    _ => {}
                }
            }
            let mut earned = 0u64;
            let mut shares = 0u128;
            for h in &mut holders {
                h.settle_rewards(&r).unwrap();
                earned += h.unclaimed;
                shares += h.shares;
            }
            assert!(earned <= r.accrued_total, "{earned} paid of {} accrued", r.accrued_total);
            assert!(shares <= r.total_shares, "the holders' shares never add up to more than the total");
        }
    }

    /// `2^x` in floating point, against the program's table.
    #[test]
    fn the_weight_is_two_to_the_log_to_within_a_part_in_a_billion() {
        assert_eq!(exp2_q32(0), 1 << 32);
        assert_eq!(exp2_q32(1 << 32), 2 << 32);
        assert_eq!(exp2_q32(15 << 32), 1 << 47);
        let mut seed = 3u64;
        for _ in 0..100_000 {
            let l = (rng(&mut seed) % (16u64 << 32)) as u128;
            let got = exp2_q32(l) as f64;
            let want = 2f64.powf(l as f64 / 4_294_967_296.0) * 4_294_967_296.0;
            assert!(got <= want * (1.0 + 1e-12) && (want - got) / want < 1e-9, "2^{l}: {got} for {want}");
        }
        // Monotone, so a later mint never weighs less than an earlier one.
        let mut last = 0;
        for l in (0..(16u128 << 32)).step_by(9_999_991) {
            let w = exp2_q32(l);
            assert!(w >= last);
            last = w;
        }
    }

    #[test]
    fn mul_div_is_exact_through_256_bits() {
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
        assert_eq!(mul_div(u128::MAX, 2, 4), Some(u128::MAX / 2));
        assert_eq!(mul_div(1 << 100, 1 << 100, 1 << 120), Some(1 << 80));
        assert_eq!(mul_div(u128::MAX, u128::MAX, 1), None);
        assert_eq!(mul_div(5, 7, 0), None);
        let mut seed = 11u64;
        for _ in 0..20_000 {
            let a = ((rng(&mut seed) as u128) << 64 | rng(&mut seed) as u128) >> (rng(&mut seed) % 64);
            let b = ((rng(&mut seed) as u128) << 64 | rng(&mut seed) as u128) >> (rng(&mut seed) % 64);
            let d = (((rng(&mut seed) as u128) << 64 | rng(&mut seed) as u128) >> (rng(&mut seed) % 100)).max(1);
            let (hi, lo) = mul_wide(a, b);
            match mul_div(a, b, d) {
                // q·d ≤ a·b < (q + 1)·d, in 256 bits.
                Some(q) => {
                    let (qh, ql) = mul_wide(q, d);
                    assert!((qh, ql) <= (hi, lo));
                    let (rh, rl) = (hi - qh - if ql > lo { 1 } else { 0 }, lo.wrapping_sub(ql));
                    assert!(rh == 0 && rl < d, "{a} * {b} / {d}");
                }
                None => assert!(hi >= d),
            }
        }
    }

    const H: i64 = 26 * 7 * 86_400;

    #[test]
    fn a_balance_halves_every_half_life_and_a_later_mint_weighs_more() {
        let mut r = rewards(0);
        r.config.wallet_cap_bps = 10_000;
        let (mut a, mut b) = (Holder::default(), Holder::default());
        r.mint(&mut a, 1_000 * 1_000_000, 0).unwrap();
        let skt = r.balance_of(a.shares, a.era, 0);
        assert_eq!(skt as u128, mint_amount(r.config.mint_scale, 0, 1_000_000_000));
        for k in 1..=40 {
            let now = k * H;
            let want = skt as f64 / 2f64.powi(k as i32);
            let got = r.balance_of(a.shares, a.era, now) as f64;
            assert!((got - want).abs() <= 1.0 + want * 1e-9, "after {k} half-lives: {got} for {want}");
        }
        // B loses the same a half-life on: it mints a little less SKT (the curve has moved), but its shares weigh about
        // twice as much as A's for each SKT, so it is paid about twice as much per SKT minted.
        r.mint(&mut b, 1_000 * 1_000_000, H).unwrap();
        a.settle_rewards(&r).unwrap();
        let (sa, sb) = (r.balance_of(a.shares, a.era, H) as f64, r.balance_of(b.shares, b.era, H) as f64);
        assert!(sb / sa > 1.9 && sb / sa < 2.0, "{sa} {sb}");
        r.accrue(1_000_000, H).unwrap();
        a.settle_rewards(&r).unwrap();
        b.settle_rewards(&r).unwrap();
        // Split by shares, which is by balance now: B about two thirds.
        let share_b = b.unclaimed as f64 / (a.unclaimed + b.unclaimed) as f64;
        assert!((share_b - sb / (sa + sb)).abs() < 1e-3, "{share_b}");
    }

    /// Fifty years and more of decay, in one go and by the era: no overflow, every era's earnings paid where they are
    /// kept, never more than was accrued, and the shares and their weights in range throughout.
    #[test]
    fn decades_of_decay_never_overflow_and_never_overpay() {
        for (half_life, jump_years) in [(RewardsConfig::DEFAULT.half_life_secs, 60i64), (MIN_HALF_LIFE_SECS, 55), (MAX_HALF_LIFE_SECS, 200)] {
            let year = 365 * 86_400i64;
            let mut r = rewards(0);
            r.config.half_life_secs = half_life;
            r.config.mint_scale = MAX_MINT_SCALE;
            r.config.wallet_cap_bps = 10_000;
            let (mut whale, mut steady, mut late) = (Holder::default(), Holder::default(), Holder::default());
            // The whale loses three times the scale at once at the start, at the largest scale: three quarters of the
            // curve's whole worth, 75 billion SKT.
            r.mint(&mut whale, 3 * MAX_MINT_SCALE, 0).unwrap();
            assert!(r.total_shares < 1 << 74);
            // A steady player loses a little every month for the whole time; fees accrue every month.
            let mut now = 0;
            while now < jump_years * year {
                now += year / 12;
                r.mint(&mut steady, 1_000_000_000, now).unwrap();
                r.accrue(10_000_000_000, now).unwrap();
                assert!(r.total_shares < 1 << 75 && r.anchor_log2 < (ERA_HALVINGS as u64) << 32);
            }
            // A late player, and the whale untouched the whole time, then everyone settles.
            r.mint(&mut late, 1_000_000_000, now).unwrap();
            r.accrue(10_000_000_000, now).unwrap();
            // Every u64 of basis besides, at once: no overflow.
            let mut probe = Holder::default();
            r.mint(&mut probe, u64::MAX, now).unwrap();
            assert!(r.total_shares < 1 << 75);
            let mut paid = 0;
            for h in [&mut whale, &mut steady, &mut late, &mut probe] {
                h.settle_rewards(&r).unwrap();
                paid += h.unclaimed;
            }
            assert!(paid <= r.accrued_total, "{paid} of {}", r.accrued_total);
            // Within ERAS_KEPT eras of the whale's last touch (the default half-life's 60 years is 7.5 eras), all of it
            // is paid but the rounding; past them (55 years of 4-week half-lives is 44 eras), the whale's first era's
            // earnings stay in the holders' funds, never anyone else's.
            let eras = jump_years * year / (ERA_HALVINGS as i64 * half_life as i64);
            println!("half-life {half_life} s, {jump_years} years ({eras} eras): {paid} of {} paid", r.accrued_total);
            if eras < ERAS_KEPT as i64 {
                assert!(r.accrued_total - paid < r.accrued_total / 10_000 + 1_000, "{paid} of {}", r.accrued_total);
            }
            // After decades, the whale's early loss, three quarters of the curve, weighs less than a player's who kept
            // playing a thousand dollars a month.
            assert!(r.balance_of(whale.shares, whale.era, now) < r.balance_of(steady.shares, steady.era, now));
            // And a jump of a century with nobody about: one catch-up, no overflow.
            r.catch_up(now + 100 * year);
            assert!(r.anchor_log2 < (ERA_HALVINGS as u64) << 32);
            late.settle_rewards(&r).unwrap();
        }
    }

    /// The cap: a mint never takes a wallet past 10% of all shares, or past 10% of the floor while there is little.
    #[test]
    fn no_mint_takes_a_wallet_past_its_cap() {
        let mut r = rewards(0);
        let mut whale = Holder::default();
        // Alone at the start: up to 10% of the floor (100,000 SKT), however much it loses.
        r.mint(&mut whale, 1_000_000 * 1_000_000, 0).unwrap();
        let cap = r.config.cap_floor / 10;
        assert!(r.balance_of(whale.shares, 0, 0) <= cap && r.balance_of(whale.shares, 0, 0) > cap - 10, "{}", r.balance_of(whale.shares, 0, 0));
        // It holds all the SKT there is, but every share is counted against the floor: it is paid a tenth of anything
        // shared, its own fees recycled included, and the rest is not shared (the treasury's, or the pool's).
        let left = r.accrue(1_000_000, 0).unwrap();
        whale.settle_rewards(&r).unwrap();
        assert!(whale.unclaimed <= 100_000 && whale.unclaimed >= 99_990 && left >= 899_999, "{} {left}", whale.unclaimed);
        // Others mint: the whale may grow to 10% of the total and no further.
        let mut others: Vec<Holder> = (0..50).map(|_| Holder::default()).collect();
        let mut seed = 21u64;
        for i in 0..2_000 {
            let now = i as i64 * 3_600;
            let k = (rng(&mut seed) % 50) as usize;
            r.mint(&mut others[k], 1 + rng(&mut seed) % 20_000_000_000, now).unwrap();
            r.mint(&mut whale, 1 + rng(&mut seed) % 200_000_000_000, now).unwrap();
            let floor = r.floor_shares();
            assert!(whale.shares * 10 <= r.total_shares.max(floor) + 10, "step {i}: {} of {}", whale.shares, r.total_shares);
            // So it is never paid more than a tenth of what is shared.
            whale.settle_rewards(&r).unwrap();
            let mark = whale.unclaimed;
            r.accrue(10_000_000, now).unwrap();
            whale.settle_rewards(&r).unwrap();
            assert!(whale.unclaimed - mark <= 1_000_000, "step {i}: paid {} of 10,000,000", whale.unclaimed - mark);
        }
        assert!(whale.shares * 10 > r.total_shares * 9 / 10, "the whale reached its cap");
        // With no cap, the same losses mint the curve.
        let mut r = rewards(0);
        r.config.wallet_cap_bps = 10_000;
        let mut h = Holder::default();
        assert_eq!(r.mint(&mut h, 1_000_000 * 1_000_000, 0).unwrap() as u128, mint_amount(r.config.mint_scale, 0, 1_000_000_000_000));
    }

    /// At the same moment, a basis minted in one settlement or in pieces makes the same shares, to a unit a piece.
    #[test]
    fn shares_are_the_same_in_one_go_or_in_pieces() {
        let mut seed = 77u64;
        for _ in 0..500 {
            let now = (rng(&mut seed) % (40 * H as u64)) as i64;
            let pieces = 1 + rng(&mut seed) % 10;
            let bases: Vec<u64> = (0..pieces).map(|_| 1 + rng(&mut seed) % 50_000_000_000).collect();
            let (mut one, mut split) = (rewards(0), rewards(0));
            one.config.wallet_cap_bps = 10_000;
            split.config.wallet_cap_bps = 10_000;
            let (mut a, mut b) = (Holder::default(), Holder::default());
            one.mint(&mut a, bases.iter().sum(), now).unwrap();
            for &x in &bases {
                split.mint(&mut b, x, now).unwrap();
            }
            assert!(b.shares <= a.shares + pieces as u128 && a.shares <= b.shares + (2 * pieces as u128) * (1 << 16), "{} {}", a.shares, b.shares);
        }
    }
}
