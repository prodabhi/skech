// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {SkechGame} from "../src/SkechGame.sol";
import {SkechIOU} from "../src/SkechIOU.sol";

/// @dev The game's and the IOU's storage structs laid out from slot 0, so `forge inspect` can print where every field
/// sits inside them: they live at ERC-7201 slots, which the compiler's own layout does not show. `layout.ts` prints
/// this and holds it to `snapshots/StorageLayout.json`.
contract StorageLayoutProbe {
    SkechGame.GameStorage internal game;
    SkechIOU.IOUStorage internal iou;
}

/// The proxies on chain keep their storage across upgrades only if every field stays where it was. Where the
/// namespaces are, and that fields land where the snapshot says, read straight off a live proxy.
contract StorageLayoutTest is Base {
    // keccak256(abi.encode(uint256(keccak256("skech.game")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant GAME = 0xf8cdf277c1dee82b808ef4977285f6a5b9934cf12bad104f17f251bc2b63ec00;
    bytes32 internal constant IOU = 0x2452509cc4fa7a706c2195d8a01d74e61f4dcca1bc29541a0a9408a170350c00;

    function test_theNamespacesAreERC7201() public pure {
        assertEq(GAME, keccak256(abi.encode(uint256(keccak256("skech.game")) - 1)) & ~bytes32(uint256(0xff)));
        assertEq(IOU, keccak256(abi.encode(uint256(keccak256("skech.iou")) - 1)) & ~bytes32(uint256(0xff)));
    }

    function test_fieldsAreWhereTheSnapshotSays() public {
        ready();
        uint256 g = uint256(GAME);
        // usdc, iou, revenue, oracle: slots 0 to 3.
        assertEq(address(uint160(uint256(vm.load(address(game), bytes32(g))))), address(usdc));
        assertEq(address(uint160(uint256(vm.load(address(game), bytes32(g + 1))))), address(iou));
        assertEq(address(uint160(uint256(vm.load(address(game), bytes32(g + 2))))), address(revenue));
        assertEq(address(uint160(uint256(vm.load(address(game), bytes32(g + 3))))), oracle);
        // A player's balance: the mapping at slot 9, keyed by address.
        assertEq(uint256(vm.load(address(game), keccak256(abi.encode(player, g + 9)))), game.balanceOf(player));
        assertGt(game.balanceOf(player), 0);
        // The IOU's index at slot 0 of its namespace.
        assertEq(uint256(vm.load(address(iou), IOU)), 1e18);
    }
}
