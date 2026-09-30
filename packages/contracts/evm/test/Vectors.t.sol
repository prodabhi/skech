// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {SkechGame} from "../src/SkechGame.sol";
import {SkechIOU} from "../src/SkechIOU.sol";
import {SkechRevenue} from "../src/SkechRevenue.sol";
import {ISkechIOU} from "../src/interfaces/ISkechIOU.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// The hashes `packages/core/src/chain.test.ts` pins: the game at a fixed address on chain 31337, a fixed piece,
/// quote, bar and session. If these move, the app would sign something the contract does not check.
contract VectorsTest is Base {
    address constant AT = 0x5Ec400000000000000000000000000000000C0De;

    function test_printVectors() public {
        vm.chainId(31337);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            abi.encode(
                address(new SkechGame()),
                abi.encodeCall(SkechGame.initialize, (admin, oracle, IERC20(address(usdc)), ISkechIOU(address(iou)), address(revenue)))
            ),
            AT
        );
        SkechGame at = SkechGame(AT);
        SkechGame.Section[] memory s = new SkechGame.Section[](2);
        s[0] = section(1, 8_359_140_000_000, 8_359_200_000_000, 50_000);
        s[1] = section(2, 8_359_240_000_000, 8_359_300_000_000, 50_000);
        SkechGame.Piece memory p = SkechGame.Piece({
            player: 0x0376AAc07Ad725E01357B1725B5ceC61aE10473c,
            drawing: 7,
            index: 3,
            market: 0,
            difficulty: 51,
            openAt: 1_790_000_000_000,
            perDot: 100_000,
            unit: 20_000_000,
            priceSeen: 8_359_144_000_000,
            priceTime: 1_789_999_999_500,
            sections: s,
            strokeHash: keccak256(hex"0000000100000002")
        });
        console.log("pieceHash");
        console.logBytes32(at.hashPiece(p));
        console.log("pieceDigest");
        console.logBytes32(at.pieceDigest(p));
        console.log("betId");
        console.logBytes32(at.betIdOf(p.player, p.drawing, p.index));
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = at.hashPiece(p);
        uint64[] memory received = new uint64[](1);
        received[0] = 1_789_999_999_600;
        uint32[] memory chances = new uint32[](2);
        chances[0] = 500_000_000;
        chances[1] = 100_000_000;
        SkechGame.Quote memory q = SkechGame.Quote({
            market: 0,
            openAt: 1_790_000_000_000,
            unit: 20_000_000,
            price: 8_359_144_000_000,
            momentum: -1_500_000,
            receivedAt: received,
            chances: chances
        });
        console.log("quoteDigest");
        console.logBytes32(at.quoteDigest(q, hashes));
        SkechGame.Bar memory b = SkechGame.Bar({
            market: 0,
            second: 1_790_000_001_000,
            prevClose: 8_359_144_000_000,
            high: 8_359_200_000_000,
            low: 8_359_100_000_000,
            close: 8_359_150_000_000
        });
        console.log("barDigest");
        console.logBytes32(at.barDigest(b));
        console.log("priceDigest");
        console.logBytes32(at.priceDigest("BTC-USD", 8_359_144_000_000, 1_790_629_278_967));
        console.log("sessionDigest");
        console.logBytes32(at.sessionDigest(p.player, 0, 0x87110f79f69670eE8dEd56E2231882D06b2873F2, 0, 0, 1_790_086_400, 100_000_000, 1_790_000_060));
        console.log("withdrawDigest");
        console.logBytes32(at.withdrawDigest(p.player, 10_000_000, 0x1111111111111111111111111111111111111111, 1_790_000_060));
    }
}
