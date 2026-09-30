// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SkechLadder} from "../src/SkechLadder.sol";

/// `SkechLadder.rungFor` against the ladder in packages/core, row for row: the same table the Solana program is checked
/// against (`solana/tests/src/ladder.rs`), printed by `solana/tests/vectors/ladder.ts`. Core, Monad and Solana are
/// pinned to one set of numbers.
contract LadderVectorsTest is Test {
    function test_theLadderIsTheSameIntegersAsTheAppAndSolana() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../solana/tests/vectors/ladder.json"));
        uint256[] memory chances = vm.parseJsonUintArray(json, ".chance");
        uint256[] memory difficulties = vm.parseJsonUintArray(json, ".difficulty");
        bool[] memory withIt = vm.parseJsonBoolArray(json, ".withIt");
        int256[] memory momenta = vm.parseJsonIntArray(json, ".momentum");
        uint256[] memory rungs = vm.parseJsonUintArray(json, ".rung");
        uint256 n = chances.length;
        assertGt(n, 10_000, "rows");
        assertEq(difficulties.length, n);
        assertEq(withIt.length, n);
        assertEq(momenta.length, n);
        assertEq(rungs.length, n);
        for (uint256 i = 0; i < n; i++) {
            uint16 got = SkechLadder.rungFor(uint32(chances[i]), uint8(difficulties[i]), withIt[i], int64(momenta[i]));
            if (got != rungs[i]) {
                assertEq(
                    got,
                    rungs[i],
                    string.concat(
                        "row ", vm.toString(i), ": chance ", vm.toString(chances[i]), ", difficulty ", vm.toString(difficulties[i]),
                        ", momentum ", vm.toString(momenta[i])
                    )
                );
            }
        }
    }
}
