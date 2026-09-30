// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {SkechGame} from "../src/SkechGame.sol";

/// Replays the conformance cases (`packages/contracts/conformance/vectors.json`, as `ConformanceCases.sol`) against
/// SkechGame. The Solana program replays the same file (`solana/tests/src/conformance.rs`): both chains must give
/// the same rungs, stakes, fees, hits, payouts, IOUs and balances, step for step.
abstract contract ConformanceRunner is Base {
    uint64 internal openAt;
    uint64 internal casePrice;
    uint64 internal caseUnit;
    SkechGame.Section[] internal sections;
    uint32[] internal chances;
    SkechGame.Section[] internal want;
    uint16[] internal wantRungs;
    mapping(bytes32 => bytes32) internal betOfId;
    bytes32[] internal toSettle;
    /// The last placement's Refused reason, if it was refused; and its Placed fee.
    uint8 internal refused;
    uint64 internal placedFee;
    bytes32 internal lastBet;
    struct Expected {
        bytes32 bet;
        uint32 hit;
        uint32 miss;
        uint64 paid;
        uint64 owed;
    }
    Expected[] internal expectedSettles;

    string[15] internal REFUSALS =
        ["None", "Mismatch", "Replay", "Difficulty", "Late", "StalePrice", "PerDot", "Sections", "PriceSig", "Stroke", "Session", "SessionSig", "NotOffered", "Allowance", "Balance"];

    function begin(uint8 difficulty, uint16 feeBps, uint16 profitFeeBps, uint64 price, uint64 unit, uint64 depA, uint64 allowA, uint64 depB, uint64 allowB) internal {
        vm.startPrank(admin);
        game.setConfig(
            SkechGame.Config({
                feeBps: feeBps,
                profitFeeBps: profitFeeBps,
                sweepBps: 1000,
                lateMs: 200,
                placeGraceMs: 3000,
                maxPriceAgeMs: 15_000,
                minPerDot: 10_000,
                maxPerDot: 10_000_000,
                maxPieceStake: 1_000_000_000,
                minRedeem: 10_000
            })
        );
        game.setDifficulty(BTC, difficulty);
        vm.stopPrank();
        casePrice = price;
        caseUnit = unit;
        openAt = openAtNow();
        deposit(player, depA);
        registerSession(PLAYER_KEY, SESSION_KEY, allowA);
        if (depB > 0) {
            deposit(other, depB);
            registerSession(OTHER_KEY, OTHER_SESSION_KEY, allowB);
        }
    }

    /// The admin sets the market's difficulty; `ok` false: it is refused, and nothing changes.
    function setDifficulty(uint8 difficulty, bool ok) internal {
        uint8 before = game.difficultyOf(BTC);
        vm.prank(admin);
        if (!ok) vm.expectRevert(SkechGame.BadDifficulty.selector);
        game.setDifficulty(BTC, difficulty);
        assertEq(game.difficultyOf(BTC), ok ? difficulty : before, "difficulty");
    }

    function clearPiece() internal {
        delete sections;
        delete chances;
    }

    function addSection(uint8 second, uint64 lo, uint64 width, uint64 stake, uint32 chance) internal {
        sections.push(SkechGame.Section({second: second, lo: lo * caseUnit, hi: (lo + width) * caseUnit, stake: stake}));
        chances.push(chance);
    }

    function place(string memory id, uint8 who, uint64 perDot, uint8 difficulty, int64 momentum, int64 received, uint64 priceAge) internal {
        address p = who == 0 ? player : other;
        uint64 receivedAt = uint64(int64(openAt) + received);
        SkechGame.Piece memory pc;
        pc.player = p;
        pc.drawing = uint64(uint256(keccak256(bytes(id))));
        pc.index = 0;
        pc.market = BTC;
        pc.difficulty = difficulty;
        pc.openAt = openAt;
        pc.perDot = perDot;
        pc.unit = caseUnit;
        pc.priceSeen = casePrice;
        pc.priceTime = receivedAt - priceAge;
        pc.sections = sections;
        pc.strokeHash = keccak256(stroke());
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0].piece = pc;
        pls[0].sessionSig = sign(who == 0 ? SESSION_KEY : OTHER_SESSION_KEY, game.pieceDigest(pc));
        pls[0].priceSig = priceSig(pc.priceSeen, pc.priceTime);
        pls[0].stroke = stroke();
        SkechGame.Quote memory q;
        q.market = BTC;
        q.openAt = openAt;
        q.unit = caseUnit;
        q.price = casePrice;
        q.momentum = momentum;
        q.receivedAt = new uint64[](1);
        q.receivedAt[0] = receivedAt;
        q.chances = chances;
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = game.hashPiece(pc);
        bytes memory sig = sign(ORACLE_KEY, game.quoteDigest(q, hashes));
        vm.recordLogs();
        game.place(pls, q, sig);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        refused = 0;
        placedFee = 0;
        lastBet = game.betIdOf(p, pc.drawing, 0);
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == SkechGame.Refused.selector) {
                (,, SkechGame.Refusal why) = abi.decode(logs[i].data, (uint64, uint32, SkechGame.Refusal));
                refused = uint8(why);
            } else if (logs[i].topics[0] == SkechGame.Placed.selector) {
                (,,,,, uint64 fee,,,,) = abi.decode(logs[i].data, (uint8, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint256[]));
                placedFee = fee;
                betOfId[keccak256(bytes(id))] = lastBet;
            }
        }
    }

    function clearExpected() internal {
        delete want;
        delete wantRungs;
    }

    function expectBand(uint8 second, uint64 lo, uint64 hi, uint64 stake, uint16 rung) internal {
        want.push(SkechGame.Section({second: second, lo: lo, hi: hi, stake: stake}));
        wantRungs.push(rung);
    }

    function checkPlaced(string memory id, uint8 who, uint64 staked, uint64 fee) internal view {
        assertEq(refused, 0, string.concat(id, ": refused as ", REFUSALS[refused]));
        SkechGame.BetView memory b = game.betOf(betOfId[keccak256(bytes(id))]);
        assertEq(b.player, who == 0 ? player : other, "bet's player");
        assertEq(b.stake, staked, string.concat(id, ": staked"));
        assertEq(placedFee, fee, string.concat(id, ": fee"));
        assertEq(b.sections.length, want.length, string.concat(id, ": bands offered"));
        for (uint256 i = 0; i < want.length; i++) {
            assertEq(b.sections[i].second, want[i].second, "band second");
            assertEq(b.sections[i].lo, want[i].lo, "band lo");
            assertEq(b.sections[i].hi, want[i].hi, "band hi");
            assertEq(b.sections[i].stake, want[i].stake, "band stake");
            assertEq(b.rungs[i], wantRungs[i], "band rung");
        }
    }

    function checkRefused(string memory why) internal view {
        assertEq(REFUSALS[refused], why, "refusal");
        if (keccak256(bytes(why)) != keccak256("Replay")) assertEq(game.betOf(lastBet).player, address(0), "a refused piece leaves no bet");
    }

    function barAt(uint64 second, uint64 prevClose, uint64 high, uint64 low, uint64 close) internal {
        uint64 at = openAt + second * 1000;
        // A second is posted once it is over: `postBar` moves the clock on if it is not yet.
        postBar(at, prevClose, high, low, close);
    }

    function expectSettled(string memory id, uint32 hit, uint32 miss, uint64 paid, uint64 owed) internal {
        expectedSettles.push(Expected({bet: betOfId[keccak256(bytes(id))], hit: hit, miss: miss, paid: paid, owed: owed}));
    }

    function settleAdd(string memory id) internal {
        bytes32 b = betOfId[keccak256(bytes(id))];
        if (b != bytes32(0)) toSettle.push(b);
    }

    function settle() internal {
        vm.recordLogs();
        game.settle(toSettle);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != SkechGame.Settled.selector) continue;
            (uint32 hit, uint32 miss, uint64 paid, uint64 owed,) = abi.decode(logs[i].data, (uint32, uint32, uint64, uint64, uint64));
            Expected memory e = expectedSettles[seen++];
            assertEq(logs[i].topics[1], e.bet, "settled bet");
            assertEq(hit, e.hit, "hit mask");
            assertEq(miss, e.miss, "miss mask");
            assertEq(paid, e.paid, "paid");
            assertEq(owed, e.owed, "owed");
        }
        assertEq(seen, expectedSettles.length, "bets settled");
        delete toSettle;
        delete expectedSettles;
    }

    function checkState(uint64 balA, uint64 balB, uint64 allowA, uint64 allowB, uint64 pool, uint64 fees, uint64 owedA, uint64 owedB, uint64 houseOwed) internal view {
        assertEq(game.balanceOf(player), balA, "balance a");
        assertEq(game.sessionOf(player).allowance, allowA, "allowance a");
        if (balB > 0 || allowB > 0) {
            assertEq(game.balanceOf(other), balB, "balance b");
            assertEq(game.sessionOf(other).allowance, allowB, "allowance b");
        }
        assertEq(game.pool(), pool, "pool");
        assertEq(game.fees(), fees, "fees");
        assertEq(iou.basisOf(player), owedA, "owed a");
        assertEq(iou.basisOf(other), owedB, "owed b");
        assertEq(iou.basisOf(address(revenue)), houseOwed, "owed the house");
        assertEq(game.owed(), owedA + owedB + houseOwed, "owed in all");
        address[] memory ps = new address[](2);
        ps[0] = player;
        ps[1] = other;
        assertAccounted(ps);
    }
}
