//! ladder-v1: what a section of ink pays, from its measured chance and the market's difficulty.
//!
//! The same integers as `SkechLadder.sol` and `rungE2` in `packages/core/src/chain.ts`, so what the app
//! shows, what Monad pays and what Solana pays cannot drift. `tests/src/ladder.rs` checks this against
//! vectors printed by the TypeScript.
//!
//!   d      = the difficulty, 50 to 100: one set lower is priced as 50
//!   best   = 1.20 - 0.40 * d/100          what ink exactly on a rung returns, per dollar (e3 here), at most 1.00
//!   floor  = 1.10, easing to 1.00 from d = 70 to 100   the least a rung pays (e2 here)
//!   margin = 0.11 * min(2, |momentum|)    taken off the side the price just moved toward
//!   fair   = (best - margin) / chance
//!   rung   = the highest rung <= fair, the floor if fair is between it and the first rung, and under the floor
//!            fair itself, rounded down to the hundredth and never under 1.00
//!   a section never pays more than 256 dots: a big one stakes only what that pays for
//!
//! So chance x rung is never more than 1: no band returns more than it stakes, on average, before fees.

/// The rungs, x100: 1.1x, 1.5x, 2x, 3x, 4x, 6x, 8x, 12x, 16x, 24x, 32x, 48x, 64x, 96x, 128x.
pub const RUNGS: [u16; 15] = [110, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200, 4800, 6400, 9600, 12800];
/// The most one section pays, in dots.
pub const MAX_DOTS: u64 = 256;
/// The momentum margin, x1000, per unit of momentum, over at most two units.
pub const MARGIN_E3: u64 = 110;
pub const CHANCE_ONE: u32 = 1_000_000_000;
/// The least difficulty a market may be set to: below it, ink exactly on a rung returns more than a dollar.
pub const MIN_DIFFICULTY: u8 = 50;
/// The least any hit pays, x100: its stake back.
pub const ONE_E2: u16 = 100;

/// What ink exactly on a rung returns per dollar at difficulty `d`, x1000: 1200 - 4d. A difficulty under the least (a
/// market set before there was one) is priced as the least, so this is never more than 1000.
pub fn best_e3(d: u8) -> u64 {
    1200 - 4 * d.max(MIN_DIFFICULTY) as u64
}

/// The least a rung pays at difficulty `d`, x100: 110 up to 70, easing to 100 at 100 (rounded, as the app rounds).
/// Ink likelier than that pays its fair multiple.
pub fn floor_e2(d: u8) -> u16 {
    if d <= 70 {
        return 110;
    }
    110 - (((d as u64 - 70) * 10 + 15) / 30) as u16
}

/// The rung, x100, a section of chance `chance_e9` (in billionths) earns at difficulty `d`; 0 when it is not offered.
/// `with_it`: the section is on the side the price just moved toward, where the margin comes off.
/// `momentum_e6`: the last three seconds' move in units of volatility, x1e6, signed.
pub fn rung_for(chance_e9: u32, d: u8, with_it: bool, momentum_e6: i64) -> u16 {
    if chance_e9 == 0 || chance_e9 > CHANCE_ONE || d > 100 {
        return 0;
    }
    let margin_e9: u128 = if with_it { MARGIN_E3 as u128 * momentum_e6.unsigned_abs().min(2_000_000) as u128 } else { 0 };
    // best_e3 is at least 800 and the margin at most 0.22, so this is positive: fair x1000, rounded down.
    let fair_e3 = ((best_e3(d) as u128 * 1_000_000 - margin_e9) * CHANCE_ONE as u128) / (chance_e9 as u128 * 1_000_000);
    let mut best = floor_e2(d);
    // Too likely for the floor: its fair multiple, rounded down to the hundredth, and never under its stake back.
    if fair_e3 < best as u128 * 10 {
        return ((fair_e3 / 10) as u16).max(ONE_E2);
    }
    for r in RUNGS {
        if r as u128 * 10 > fair_e3 {
            break;
        }
        if r > best {
            best = r;
        }
    }
    best
}

/// The most a section paying `rung_e2` may stake at `per_dot`, so it never pays past MAX_DOTS dots.
pub fn max_stake(per_dot: u64, rung_e2: u16) -> u64 {
    ((per_dot as u128 * MAX_DOTS as u128 * 100) / rung_e2 as u128) as u64
}

/// What a hit on `stake` at `rung_e2` pays, before fees.
pub fn gross(stake: u64, rung_e2: u16) -> u64 {
    ((stake as u128 * rung_e2 as u128) / 100) as u64
}

/// Whether a band is on the side the price has just moved toward, where the momentum margin comes off.
pub fn with_momentum(lo: u64, hi: u64, price: u64, momentum_e6: i64) -> bool {
    let mid = (lo as u128 + hi as u128) / 2;
    (mid > price as u128 && momentum_e6 > 0) || (mid < price as u128 && momentum_e6 < 0)
}

/// Whether a band leaves the house its stake fee in expectation: its chance times its rung, what it returns per dollar
/// before fees, at most 1 − the fee (`fee_bps`). Ink that returns more is not offered: certain ink at 1x, or ink exactly
/// on a rung at a low difficulty (p·m = 1.2 − 0.4·d/100 there, 1.0 at d = 50, 0.96 at d = 60), would let a player put
/// money through the pool at no risk while the stake fee's holder share is paid out of it.
pub fn within_fee(chance_e9: u32, rung_e2: u16, fee_bps: u16) -> bool {
    chance_e9 as u128 * rung_e2 as u128 * 10_000 <= (10_000 - fee_bps.min(10_000)) as u128 * 100 * CHANCE_ONE as u128
}

/// Whether a second's range reaches a band: from the second before's close to its high and low, one unit wider
/// each way, inclusive, as the band was priced.
pub fn crosses(prev_close: u64, high: u64, low: u64, lo: u64, hi: u64, unit: u64) -> bool {
    let high = high.max(prev_close) as u128;
    let low = low.min(prev_close) as u128;
    high + unit as u128 >= lo as u128 && low <= hi as u128 + unit as u128
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rungs_are_the_ladder() {
        // 1.1, 1.5, then doubling with one rung between each pair, as SkechLadder.rung computes them.
        for (i, r) in RUNGS.iter().enumerate() {
            let want = match i {
                0 => 110,
                1 => 150,
                _ if i % 2 == 0 => 200u16 << (i / 2 - 1),
                _ => 300u16 << ((i - 3) / 2),
            };
            assert_eq!(*r, want);
        }
    }

    #[test]
    fn edges() {
        assert_eq!(rung_for(0, 51, false, 0), 0);
        assert_eq!(rung_for(CHANCE_ONE + 1, 51, false, 0), 0);
        assert_eq!(rung_for(500_000_000, 101, false, 0), 0);
        // A sure thing pays its stake back, not the floor; nor does a difficulty under the least pay more.
        assert_eq!(rung_for(CHANCE_ONE, 51, false, 0), 100);
        assert_eq!(rung_for(CHANCE_ONE, 0, false, 0), 100);
        assert_eq!(rung_for(950_000_000, 51, false, 0), 104);
        assert_eq!(best_e3(0), 1000);
        assert_eq!(best_e3(49), 1000);
        assert_eq!(floor_e2(100), 100);
        // 50% at d=51: fair 1.992x, rung 1.5x (HOW-IT-WORKS, fees and the pool).
        assert_eq!(rung_for(500_000_000, 51, false, 0), 150);
        assert_eq!(max_stake(100_000, 150), 17_066_666);
        assert_eq!(gross(50_000, 150), 75_000);
    }

    #[test]
    fn a_band_is_offered_only_if_it_leaves_the_stake_fee() {
        // At the 4% fee, p·m may be 0.96 and no more.
        assert!(within_fee(10_000_000, 9600, 400));
        assert!(!within_fee(10_000_001, 9600, 400));
        assert!(within_fee(480_000_000, 200, 400) && !within_fee(480_000_001, 200, 400));
        // Certain ink at 1x, and ink exactly on a rung at d = 50, are not.
        assert!(!within_fee(CHANCE_ONE, 100, 400));
        assert!(!within_fee(500_000_000, rung_for(500_000_000, 50, false, 0), 400));
        // With no fee, the ladder's own bound: p·m ≤ 1.
        assert!(within_fee(CHANCE_ONE, 100, 0) && !within_fee(CHANCE_ONE, 101, 0));
        // At d = 60 and above, every rung the ladder gives leaves 4%, but ink over 96% likely, which pays at least 1x
        // whatever its fair multiple; at 55, ink just under a rung does not.
        for chance in (1..=1000u32).map(|k| k * 1_000_000) {
            for d in 60..=100u8 {
                let r = rung_for(chance, d, false, 0);
                assert!(r == 0 || within_fee(chance, r, 400) == (chance <= 960_000_000), "d {d}, chance {chance}, rung {r}");
            }
        }
        assert!(!within_fee(490_000_000, rung_for(490_000_000, 55, false, 0), 400));
    }
}
