// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SkechLadder
/// @notice ladder-v1, on chain: what a section of ink pays, from its measured chance and the market's difficulty.
/// @dev The same arithmetic as `ladderSection` in `packages/core/src/ink-area.ts`, in integers, so what the app
/// shows and what the chain pays cannot drift: `packages/core/src/chain.ts` mirrors this exactly.
///
///   d           = the difficulty, 50 to 100: one set lower is priced as 50
///   ladderBest  = 1.20 - 0.40 * d/100      what ink exactly on a rung returns, per dollar (e3 here), at most 1.00
///   ladderFloor = 1.10, easing to 1.00 from d = 70 to 100   the least a rung pays (e2 here)
///   margin      = 0.11 * min(2, |momentum|)  taken off the side the price just moved toward
///   fair        = (ladderBest - margin) / chance
///   rung        = the highest rung <= fair, the floor if fair is between it and the first rung, and under the
///                 floor fair itself, rounded down to the hundredth and never under 1.00
///   a section never pays more than 256 dots: a big one stakes only what that pays for
///
/// So chance x rung is never more than 1: no band returns more than it stakes, on average, before fees.
library SkechLadder {
    /// @notice The rungs, x100: 1.1x, 1.5x, 2x, 3x, 4x, 6x, 8x, 12x, 16x, 24x, 32x, 48x, 64x, 96x, 128x.
    uint16 internal constant RUNGS = 15;
    /// @notice The most one section pays, in dots.
    uint16 internal constant MAX_DOTS = 256;
    /// @notice The momentum margin, x1000, per unit of momentum, over at most two units.
    uint16 internal constant MARGIN_E3 = 110;
    uint32 internal constant CHANCE_ONE = 1_000_000_000;
    /// @notice The least difficulty a market may be set to: below it, ink exactly on a rung returns more than a dollar.
    uint8 internal constant MIN_DIFFICULTY = 50;
    /// @notice The least any hit pays, x100: its stake back.
    uint16 internal constant ONE_E2 = 100;

    /// @notice Rung `i` of the ladder, x100.
    function rung(uint256 i) internal pure returns (uint16) {
        // 1.1, 1.5, then doubling with one rung between each pair.
        if (i == 0) return 110;
        if (i == 1) return 150;
        // 2, 3, 4, 6, 8, 12 ... : even i pays 2^(i/2), odd i pays 3 * 2^((i-3)/2).
        return i % 2 == 0 ? uint16(200 << (i / 2 - 1)) : uint16(300 << ((i - 3) / 2));
    }

    /// @notice What ink exactly on a rung returns per dollar at difficulty `d`, x1000: 1200 - 4d. A difficulty under the
    /// least (a market set before there was one) is priced as the least, so this is never more than 1000.
    function bestE3(uint8 d) internal pure returns (uint16) {
        if (d < MIN_DIFFICULTY) d = MIN_DIFFICULTY;
        return 1200 - 4 * uint16(d);
    }

    /// @notice The least a rung pays at difficulty `d`, x100: 110 up to 70, easing to 100 at 100 (rounded, as the app rounds).
    /// Ink likelier than that pays its fair multiple.
    function floorE2(uint8 d) internal pure returns (uint16) {
        if (d <= 70) return 110;
        return 110 - uint16(((uint256(d) - 70) * 10 + 15) / 30);
    }

    /// @notice The rung, x100, a section of chance `chanceE9` (in billionths) earns at difficulty `d`; 0 when it is not offered.
    /// @param withIt Whether the section is on the side the price just moved toward: the margin comes off there.
    /// @param momentumE6 The last three seconds' move in units of volatility, x1e6, signed.
    function rungFor(uint32 chanceE9, uint8 d, bool withIt, int64 momentumE6) internal pure returns (uint16) {
        if (chanceE9 == 0 || chanceE9 > CHANCE_ONE || d > 100) return 0;
        // The margin, x1e9: 0.11 per unit of momentum (x1e6), over at most two units.
        uint256 marginE9 = 0;
        if (withIt) {
            uint256 m = momentumE6 < 0 ? uint256(-int256(momentumE6)) : uint256(int256(momentumE6));
            if (m > 2_000_000) m = 2_000_000;
            marginE9 = uint256(MARGIN_E3) * m;
        }
        // bestE3 is at least 800 and the margin at most 0.22, so this is positive: fair x1000, rounded down.
        uint256 fairE3 = ((uint256(bestE3(d)) * 1_000_000 - marginE9) * CHANCE_ONE) / (uint256(chanceE9) * 1_000_000);
        uint16 best = floorE2(d);
        // Too likely for the floor: its fair multiple, rounded down to the hundredth, and never under its stake back.
        if (fairE3 < uint256(best) * 10) return fairE3 < uint256(ONE_E2) * 10 ? ONE_E2 : uint16(fairE3 / 10);
        for (uint256 i = 0; i < RUNGS; i++) {
            uint16 r = rung(i);
            if (uint256(r) * 10 > fairE3) break;
            if (r > best) best = r;
        }
        return best;
    }

    /// @notice The most a section paying `rungE2` may stake at `perDot`, so it never pays past MAX_DOTS dots.
    function maxStake(uint64 perDot, uint16 rungE2) internal pure returns (uint64) {
        return uint64((uint256(perDot) * MAX_DOTS * 100) / rungE2);
    }

    /// @notice What a hit on `stake` at `rungE2` pays, before fees.
    function gross(uint64 stake, uint16 rungE2) internal pure returns (uint64) {
        return uint64((uint256(stake) * rungE2) / 100);
    }
}
