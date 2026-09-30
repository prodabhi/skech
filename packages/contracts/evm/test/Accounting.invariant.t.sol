// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {SkechGame} from "../src/SkechGame.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Plays the game at random: deposits, pieces, bars, settlements, expiries, redemptions, IOU transfers,
/// withdrawals, fee collection, and batches sent again. Every call it makes should go through: a revert it does not
/// expect fails the run (`fail_on_revert`).
contract Handler is Base {
    uint256[3] internal playerKeys = [uint256(0xB0B), uint256(0xD0D0), uint256(0xE0E0)];
    uint256[3] internal sessionKeys = [uint256(0x5E55), uint256(0x5E56), uint256(0x5E57)];
    address[] public players;
    bytes32[] public bets;
    uint64 public drawing;
    /// @dev The last bar posted: the next must follow on from its close.
    uint64 public lastSecond;
    uint64 public lastClose;
    uint256 public collected;
    /// @dev The last batch placed, as sent, to send again.
    bytes internal lastPlace;
    /// @dev Set if sending a batch again ever changed anything.
    bool public replayChanged;
    uint256 public replays;
    /// @dev IOU transfers each player has received: each may carry one unit of basis more than its shares are worth.
    mapping(address => uint256) public transfersTo;

    function setUp() public override {
        super.setUp();
        for (uint256 i = 0; i < 3; i++) {
            address who = vm.addr(playerKeys[i]);
            players.push(who);
            usdc.mint(who, 1_000e6);
            deposit(who, 200e6);
            registerSession(playerKeys[i], sessionKeys[i], 1_000e6);
        }
        players.push(keeper);
        players.push(address(this));
        lastSecond = openAtNow() - 1000;
        lastClose = PRICE;
    }

    function depositMore(uint256 who, uint64 amount) external {
        who = bound(who, 0, 2);
        amount = uint64(bound(amount, 1, 50e6));
        address p = players[who];
        if (usdc.balanceOf(p) < amount) return;
        deposit(p, amount);
    }

    function withdrawSome(uint256 who, uint64 amount) external {
        who = bound(who, 0, 2);
        address p = players[who];
        uint64 held = game.balanceOf(p);
        if (held == 0) return;
        amount = uint64(bound(amount, 1, held));
        vm.prank(p);
        game.withdraw(amount, p);
    }

    function placePiece(uint256 who, uint8 seconds_, uint32 chance, uint64 stake, uint8 rows) external {
        who = bound(who, 0, 2);
        seconds_ = uint8(bound(seconds_, 1, 3));
        chance = uint32(bound(chance, 0, 1_000_000_000));
        stake = uint64(bound(stake, 1_000, 2 * PER_DOT));
        rows = uint8(bound(rows, 0, 10));
        // Pieces open on the current second; bars are posted in order behind them.
        uint64 openAt = openAtNow();
        if (openAt <= lastSecond) {
            vm.warp(lastSecond / 1000 + 1);
            openAt = openAtNow();
        }
        SkechGame.Section[] memory s = new SkechGame.Section[](seconds_);
        for (uint256 i = 0; i < seconds_; i++) {
            uint64 lo = LO + uint64(rows) * UNIT;
            s[i] = SkechGame.Section({second: uint8(i + 1), lo: lo, hi: lo + 3 * UNIT, stake: stake});
        }
        SkechGame.Piece memory p = piece(++drawing, 0, s);
        p.player = players[who];
        uint32[] memory chances = new uint32[](seconds_);
        for (uint256 i = 0; i < seconds_; i++) {
            chances[i] = chance;
        }
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0] = placement(p, sessionKeys[who]);
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, p.openAt - 400, chances, 0);
        lastPlace = abi.encodeCall(SkechGame.place, (pls, q, sig));
        game.place(pls, q, sig);
        bytes32 betId = game.betIdOf(p.player, p.drawing, 0);
        if (game.betOf(betId).player != address(0)) bets.push(betId);
    }

    function postNextBar(uint64 swing, bool up) external {
        swing = uint64(bound(swing, 0, 12 * UNIT));
        uint64 second = lastSecond + 1000;
        uint64 close = up ? lastClose + swing : (lastClose > swing ? lastClose - swing : lastClose);
        uint64 high = close > lastClose ? close : lastClose;
        uint64 low = close < lastClose ? close : lastClose;
        postBar(second, lastClose, high, low, close);
        lastSecond = second;
        lastClose = close;
    }

    function settleAll() external {
        if (bets.length == 0) return;
        bytes32[] memory ids = new bytes32[](bets.length);
        for (uint256 i = 0; i < ids.length; i++) {
            ids[i] = bets[i];
        }
        game.settle(ids);
    }

    function redeemSome(uint256 who, uint256 shares) external {
        who = bound(who, 0, 3);
        address holder = who == 3 ? address(revenue) : players[who];
        uint256 held = iou.balanceOf(holder);
        if (held == 0 || game.pool() == 0) return;
        shares = bound(shares, 1, held);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        // The one refusal expected: too little to pay off, or too small a part of it.
        try game.redeem(holder, shares) {}
        catch (bytes memory err) {
            assertEq(bytes4(err), SkechGame.NothingToRedeem.selector, "redeem reverted unexpectedly");
        }
    }

    function transferIou(uint256 from, uint256 to, uint256 shares) external {
        address a = players[bound(from, 0, 2)];
        address b = players[bound(to, 0, 2)];
        uint256 held = iou.balanceOf(a);
        if (held == 0 || a == b) return;
        shares = bound(shares, 1, held);
        vm.prank(a);
        iou.transfer(b, shares);
        transfersTo[b]++;
    }

    /// @dev The last batch, sent again as it was: every piece in it is spent, placed or refused, so nothing moves.
    /// Past its window it is turned away whole; inside it every piece is refused as a replay.
    function replayLast() external {
        if (lastPlace.length == 0) return;
        uint256[3] memory held;
        uint256[3] memory allowed;
        for (uint256 i = 0; i < 3; i++) {
            held[i] = game.balanceOf(players[i]);
            allowed[i] = game.sessionOf(players[i]).allowance;
        }
        (uint64 pool, uint64 fees, uint64 owed) = (game.pool(), game.fees(), game.owed());
        (bool ok, bytes memory err) = address(game).call(lastPlace);
        if (!ok) assertEq(bytes4(err), SkechGame.Window.selector, "replay reverted unexpectedly");
        replays++;
        bool changed = game.pool() != pool || game.fees() != fees || game.owed() != owed;
        for (uint256 i = 0; i < 3; i++) {
            changed = changed || game.balanceOf(players[i]) != held[i] || game.sessionOf(players[i]).allowance != allowed[i];
        }
        if (changed) replayChanged = true;
    }

    /// @dev An hour past every bet's last second, and each expired: what no bar decided is refunded.
    function expireAll(uint64 hours_) external {
        if (bets.length == 0) return;
        hours_ = uint64(bound(hours_, 0, 2));
        vm.warp(vm.getBlockTimestamp() + hours_ * 3600);
        bytes32[] memory ids = new bytes32[](bets.length);
        for (uint256 i = 0; i < ids.length; i++) {
            ids[i] = bets[i];
        }
        game.expire(ids);
    }

    function collect() external {
        collected += game.collectFees();
    }
}

contract AccountingInvariant is Test {
    Handler internal h;

    function setUp() public {
        h = new Handler();
        h.setUp();
        targetContract(address(h));
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = Handler.depositMore.selector;
        selectors[1] = Handler.withdrawSome.selector;
        selectors[2] = Handler.placePiece.selector;
        selectors[3] = Handler.postNextBar.selector;
        selectors[4] = Handler.settleAll.selector;
        selectors[5] = Handler.redeemSome.selector;
        selectors[6] = Handler.collect.selector;
        selectors[7] = Handler.transferIou.selector;
        selectors[8] = Handler.replayLast.selector;
        selectors[9] = Handler.expireAll.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: selectors}));
    }

    /// Every USDC the game holds is a balance, the pool or an uncollected fee. Nothing is created or lost.
    function invariant_everyDollarIsAccountedFor() public view {
        uint256 sum;
        for (uint256 i = 0; i < 5; i++) {
            sum += h.game().balanceOf(h.players(i));
        }
        assertEq(h.usdc().balanceOf(address(h.game())), sum + h.game().pool() + h.game().fees());
    }

    /// The fees that left went to the revenue holder, and only there.
    function invariant_feesGoToRevenue() public view {
        assertEq(h.usdc().balanceOf(address(h.revenue())), h.collected());
    }

    /// An IOU holder's basis never exceeds what their shares are worth, but for a unit a transfer rounds up.
    function invariant_basisNeverExceedsValue() public view {
        for (uint256 i = 0; i < 3; i++) {
            address p = h.players(i);
            assertLe(h.iou().basisOf(p), h.iou().assetsOf(p) + 1 + h.transfersTo(p));
        }
    }

    /// What the game counts as owed is exactly the basis of every IOU share outstanding, however they moved.
    function invariant_owedIsEveryIousBasis() public view {
        uint256 sum = h.iou().basisOf(address(h.revenue()));
        for (uint256 i = 0; i < 5; i++) {
            sum += h.iou().basisOf(h.players(i));
        }
        assertEq(h.game().owed(), sum);
        // And the house is never owed.
        assertEq(h.iou().balanceOf(address(h.revenue())), 0);
    }

    /// Sending a batch again, as it was, changes nothing: no stake, fee, balance or allowance moves.
    function invariant_replayingABatchChangesNothing() public view {
        assertFalse(h.replayChanged());
    }
}
