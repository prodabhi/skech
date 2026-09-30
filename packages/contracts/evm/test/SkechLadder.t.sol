// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SkechLadder} from "../src/SkechLadder.sol";

contract SkechLadderTest is Test {
    function rung(uint32 chanceE9, uint8 d) internal pure returns (uint16) {
        return SkechLadder.rungFor(chanceE9, d, false, 0);
    }

    function test_theLadder() public pure {
        uint16[15] memory want = [110, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200, 4800, 6400, 9600, 12800];
        for (uint256 i = 0; i < 15; i++) {
            assertEq(SkechLadder.rung(i), want[i]);
        }
    }

    /// `difficulty()` in packages/core/src/dots.ts: ladderBest 1.20 - 0.40 d/100, ladderFloor 1.1 easing to 1.0 from 70.
    function test_difficultySetsBestAndFloor() public pure {
        assertEq(SkechLadder.bestE3(50), 1000);
        // A difficulty under the least, stored before there was one, is priced as the least.
        assertEq(SkechLadder.bestE3(0), 1000);
        assertEq(SkechLadder.bestE3(49), 1000);
        assertEq(SkechLadder.bestE3(51), 996);
        assertEq(SkechLadder.bestE3(55), 980);
        assertEq(SkechLadder.bestE3(66), 936);
        assertEq(SkechLadder.bestE3(100), 800);
        assertEq(SkechLadder.floorE2(0), 110);
        assertEq(SkechLadder.floorE2(70), 110);
        assertEq(SkechLadder.floorE2(71), 110);
        assertEq(SkechLadder.floorE2(72), 109);
        assertEq(SkechLadder.floorE2(75), 108);
        assertEq(SkechLadder.floorE2(80), 107);
        assertEq(SkechLadder.floorE2(85), 105);
        assertEq(SkechLadder.floorE2(90), 103);
        assertEq(SkechLadder.floorE2(95), 102);
        assertEq(SkechLadder.floorE2(100), 100);
    }

    /// fair = 0.996 / p at 51, rounded down to a rung; under 1.1, fair itself to the hundredth, never under 1x.
    function test_rungsAt51() public pure {
        assertEq(rung(1_000_000_000, 51), 100); // certain: fair 0.996, its stake back
        assertEq(rung(990_000_000, 51), 100); // fair 1.006: 1x
        assertEq(rung(950_000_000, 51), 104); // fair 1.048: 1.04x
        assertEq(rung(906_000_000, 51), 109); // fair 1.099: 1.09x
        assertEq(rung(900_000_000, 51), 110); // fair 1.106: 1.1x
        assertEq(rung(500_000_000, 51), 150); // fair 1.992: 1.5x
        assertEq(rung(498_000_000, 51), 200); // fair 2.000: 2x
        assertEq(rung(100_000_000, 51), 800); // fair 9.96: 8x
        assertEq(rung(10_000_000, 51), 9600); // fair 99.6: 96x
        assertEq(rung(1_000_000, 51), 12800); // fair 996: capped at 128x
        assertEq(rung(1, 51), 12800);
        assertEq(rung(0, 51), 0); // not offered
        assertEq(SkechLadder.rungFor(1_000_000_001, 51, false, 0), 0); // over 1: not offered
        assertEq(SkechLadder.rungFor(500_000_000, 101, false, 0), 0);
    }

    /// The margin: 0.11 per unit of momentum, two at most, only on the side the price moved toward.
    function test_momentumMarginOnlyWithIt() public pure {
        // (0.996 - 0.11) / 0.5 = 1.772 -> 1.5x still; at 0.52: 1.704 -> 1.5x; at 0.6: 1.477 -> 1.1x; at 0.9: 0.984 -> 1x
        assertEq(SkechLadder.rungFor(500_000_000, 51, true, 1_000_000), 150);
        assertEq(SkechLadder.rungFor(600_000_000, 51, true, 1_000_000), 110);
        assertEq(SkechLadder.rungFor(600_000_000, 51, false, 1_000_000), 150); // 1.66 against it
        assertEq(SkechLadder.rungFor(850_000_000, 51, true, 1_000_000), 104); // 1.042 with it
        assertEq(SkechLadder.rungFor(850_000_000, 51, false, 1_000_000), 110); // 1.171 against it: 1.1x
        assertEq(SkechLadder.rungFor(900_000_000, 51, true, 1_000_000), 100);
        // Clamped at two units: (0.996 - 0.22) / 0.5 = 1.552 -> 1.5x; at 0.52: 1.492 -> 1.1x
        assertEq(SkechLadder.rungFor(500_000_000, 51, true, 3_000_000), 150);
        assertEq(SkechLadder.rungFor(520_000_000, 51, true, -3_000_000), 110);
        assertEq(SkechLadder.rungFor(520_000_000, 51, true, 2_000_000), 110);
    }

    function test_capOnWhatOneSectionPays() public pure {
        // 256 dots at 10 cents is $25.60: at 128x that is 20 cents of stake, at 1.1x $23.27.
        assertEq(SkechLadder.maxStake(100_000, 12800), 200_000);
        assertEq(SkechLadder.maxStake(100_000, 110), 23_272_727);
        assertEq(SkechLadder.gross(200_000, 12800), 25_600_000);
        assertEq(SkechLadder.gross(50_000, 150), 75_000);
    }

    /// A rung is never more than fair, and never under 1x: the floor or a rung of the ladder, or under the floor fair
    /// itself to the hundredth. Harder never pays more; likelier never pays more.
    function testFuzz_rungIsFairAndMonotone(uint32 chance, uint8 d, bool withIt, int64 momentum) public pure {
        chance = uint32(bound(chance, 1, 1_000_000_000));
        d = uint8(bound(d, 0, 100));
        uint16 r = SkechLadder.rungFor(chance, d, withIt, momentum);
        uint16 floorE2 = SkechLadder.floorE2(d);
        uint256 m = withIt ? uint256(momentum < 0 ? -int256(momentum) : int256(momentum)) : 0;
        if (m > 2_000_000) m = 2_000_000;
        uint256 fairE3 = ((uint256(SkechLadder.bestE3(d)) * 1_000_000 - 110 * m) * 1_000_000_000) / (uint256(chance) * 1_000_000);
        assertGe(r, 100);
        if (fairE3 < uint256(floorE2) * 10) {
            assertEq(r, fairE3 < 1000 ? 100 : fairE3 / 10);
        } else {
            bool onLadder = r == floorE2;
            for (uint256 i = 0; i < 15; i++) {
                if (SkechLadder.rung(i) == r) onLadder = true;
            }
            assertTrue(onLadder);
            assertLe(uint256(r) * 10, fairE3);
        }
        if (d < 100) assertGe(r, SkechLadder.rungFor(chance, d + 1, withIt, momentum));
        if (chance < 1_000_000_000) assertGe(r, SkechLadder.rungFor(chance + 1, d, withIt, momentum));
    }

    /// The reviewer's invariant: at any chance and any difficulty, a band's expected return per dollar, chance x rung,
    /// is at most 1.00 before fees. Any difficulty, not just those allowed: one stored before the least is priced as it.
    function testFuzz_noBandReturnsMoreThanItStakes(uint32 chance, uint8 d, bool withIt, int64 momentum) public pure {
        chance = uint32(bound(chance, 1, 1_000_000_000));
        d = uint8(bound(d, 0, 100));
        uint16 r = SkechLadder.rungFor(chance, d, withIt, momentum);
        assertLe(uint256(chance) * r, uint256(SkechLadder.CHANCE_ONE) * 100);
    }
}
