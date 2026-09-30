// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {SkechGame} from "../src/SkechGame.sol";
import {SkechIOU} from "../src/SkechIOU.sol";
import {SkechRevenue} from "../src/SkechRevenue.sol";
import {ISkechIOU} from "../src/interfaces/ISkechIOU.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract SkechGameTest is Base {
    /* ------------------------------------------------------------------ */
    /* Money in and out                                                    */
    /* ------------------------------------------------------------------ */

    function test_depositAndWithdraw() public {
        deposit(player, 50e6);
        assertEq(game.balanceOf(player), 50e6);
        assertEq(usdc.balanceOf(address(game)), 50e6);
        vm.prank(player);
        game.withdraw(20e6, player);
        assertEq(game.balanceOf(player), 30e6);
        assertEq(usdc.balanceOf(player), 970e6);
        vm.prank(player);
        vm.expectRevert(SkechGame.Insufficient.selector);
        game.withdraw(31e6, player);
        vm.prank(player);
        vm.expectRevert(SkechGame.ZeroAmount.selector);
        game.withdraw(0, player);
        vm.prank(player);
        vm.expectRevert(SkechGame.ZeroAddress.selector);
        game.withdraw(1, address(0));
    }

    function test_depositWithPermitIsRelayable() public {
        uint256 deadline = vm.getBlockTimestamp() + 60;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                player,
                address(game),
                uint256(25e6),
                usdc.nonces(player),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PLAYER_KEY, digest);
        // The relayer sends it; the player pays no gas.
        vm.prank(keeper);
        game.depositWithPermit(player, 25e6, deadline, v, r, s);
        assertEq(game.balanceOf(player), 25e6);
        // Someone spent the permit first: the allowance is there anyway, and the deposit still goes through.
        (v, r, s) = vm.sign(
            PLAYER_KEY,
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    usdc.DOMAIN_SEPARATOR(),
                    keccak256(
                        abi.encode(
                            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                            player,
                            address(game),
                            uint256(5e6),
                            usdc.nonces(player),
                            deadline
                        )
                    )
                )
            )
        );
        usdc.permit(player, address(game), 5e6, deadline, v, r, s);
        // Then only the owner may use the allowance it left.
        vm.prank(keeper);
        vm.expectRevert(SkechGame.BadSignature.selector);
        game.depositWithPermit(player, 5e6, deadline, v, r, s);
        vm.prank(player);
        game.depositWithPermit(player, 5e6, deadline, v, r, s);
        assertEq(game.balanceOf(player), 30e6);
    }

    /// An allowance the owner left standing cannot be pulled into the game by someone else on a permit that fails.
    function test_aFailedPermitMovesNobodyElsesAllowance() public {
        vm.prank(player);
        usdc.approve(address(game), 50e6);
        vm.prank(keeper);
        vm.expectRevert(SkechGame.BadSignature.selector);
        game.depositWithPermit(player, 50e6, vm.getBlockTimestamp() + 60, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(game.balanceOf(player), 0);
        assertEq(usdc.allowance(player, address(game)), 50e6);
    }

    /* ---- EIP-3009: one signature, no allowance ---- */

    function test_depositWithAuthorizationNeedsNoAllowance() public {
        uint256 until = vm.getBlockTimestamp() + 300;
        bytes memory sig = authorization(PLAYER_KEY, 25e6, 0, until, keccak256("a"));
        // The relayer sends it; the player pays no gas and never approved anything.
        assertEq(usdc.allowance(player, address(game)), 0);
        vm.expectEmit(true, true, false, true, address(game));
        emit SkechGame.Deposited(player, player, 25e6);
        vm.prank(keeper);
        game.depositWithAuthorization(player, 25e6, 0, until, keccak256("a"), sig);
        assertEq(game.balanceOf(player), 25e6);
        assertEq(game.balanceOf(keeper), 0, "credited to the signer, never the sender");
        assertEq(usdc.balanceOf(player), 1_000e6 - 25e6);
        assertEq(usdc.allowance(player, address(game)), 0, "and no allowance left behind");
        assertTrue(usdc.authorizationState(player, keccak256("a")));
    }

    function test_depositsWithAuthorizationCanBeInFlightTogether() public {
        uint256 until = vm.getBlockTimestamp() + 300;
        // Signed one after the other, sent in the other order: random nonces do not queue the way a permit's do.
        bytes memory first = authorization(PLAYER_KEY, 5e6, 0, until, keccak256("first"));
        bytes memory second = authorization(PLAYER_KEY, 7e6, 0, until, keccak256("second"));
        game.depositWithAuthorization(player, 7e6, 0, until, keccak256("second"), second);
        game.depositWithAuthorization(player, 5e6, 0, until, keccak256("first"), first);
        assertEq(game.balanceOf(player), 12e6);
    }

    function test_depositWithAuthorizationIsSpentOnce() public {
        uint256 until = vm.getBlockTimestamp() + 300;
        bytes memory sig = authorization(PLAYER_KEY, 5e6, 0, until, keccak256("once"));
        game.depositWithAuthorization(player, 5e6, 0, until, keccak256("once"), sig);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        game.depositWithAuthorization(player, 5e6, 0, until, keccak256("once"), sig);
        assertEq(game.balanceOf(player), 5e6);
    }

    function test_depositWithAuthorizationKeepsItsTerms() public {
        uint256 until = vm.getBlockTimestamp() + 300;
        bytes memory sig = authorization(PLAYER_KEY, 5e6, 0, until, keccak256("n"));
        // More than was signed for.
        vm.expectRevert("FiatTokenV2: invalid signature");
        game.depositWithAuthorization(player, 50e6, 0, until, keccak256("n"), sig);
        // Someone else's money on this signature.
        vm.expectRevert("FiatTokenV2: invalid signature");
        game.depositWithAuthorization(other, 5e6, 0, until, keccak256("n"), sig);
        // A different window.
        vm.expectRevert("FiatTokenV2: invalid signature");
        game.depositWithAuthorization(player, 5e6, 0, until + 1, keccak256("n"), sig);
        assertEq(game.balanceOf(player), 0);
        assertEq(game.balanceOf(other), 0);
    }

    function test_depositWithAuthorizationHasAWindow() public {
        uint256 at = vm.getBlockTimestamp();
        bytes memory early = authorization(PLAYER_KEY, 5e6, at + 60, at + 300, keccak256("early"));
        vm.expectRevert("FiatTokenV2: authorization is not yet valid");
        game.depositWithAuthorization(player, 5e6, at + 60, at + 300, keccak256("early"), early);
        bytes memory late = authorization(PLAYER_KEY, 5e6, 0, at + 30, keccak256("late"));
        vm.warp(at + 30);
        vm.expectRevert("FiatTokenV2: authorization is expired");
        game.depositWithAuthorization(player, 5e6, 0, at + 30, keccak256("late"), late);
        // Its window open: it goes.
        vm.warp(at + 61);
        game.depositWithAuthorization(player, 5e6, at + 60, at + 300, keccak256("early"), early);
        assertEq(game.balanceOf(player), 5e6);
    }

    function test_anAuthorizationToTheGameCannotBeSpentAnywhereElse() public {
        uint256 until = vm.getBlockTimestamp() + 300;
        bytes memory sig = authorization(PLAYER_KEY, 5e6, 0, until, keccak256("x"));
        // Seen in the mempool and taken straight to USDC: only the payee may carry it out.
        vm.prank(keeper);
        vm.expectRevert("FiatTokenV2: caller must be the payee");
        usdc.receiveWithAuthorization(player, address(game), 5e6, 0, until, keccak256("x"), sig);
        // Still unspent: the game can use it.
        game.depositWithAuthorization(player, 5e6, 0, until, keccak256("x"), sig);
        assertEq(game.balanceOf(player), 5e6);
    }

    function test_depositWithAuthorizationStopsWhilePausedAndChecksItsInputs() public {
        uint256 until = vm.getBlockTimestamp() + 300;
        bytes memory sig = authorization(PLAYER_KEY, 5e6, 0, until, keccak256("p"));
        vm.prank(admin);
        game.pause();
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        game.depositWithAuthorization(player, 5e6, 0, until, keccak256("p"), sig);
        vm.prank(admin);
        game.unpause();
        vm.expectRevert(SkechGame.ZeroAmount.selector);
        game.depositWithAuthorization(player, 0, 0, until, keccak256("p"), sig);
        vm.expectRevert(SkechGame.ZeroAddress.selector);
        game.depositWithAuthorization(address(0), 5e6, 0, until, keccak256("p"), sig);
        game.depositWithAuthorization(player, 5e6, 0, until, keccak256("p"), sig);
        address[] memory ps = new address[](1);
        ps[0] = player;
        assertAccounted(ps);
    }

    function test_withdrawBySigOnceOnly() public {
        deposit(player, 50e6);
        uint256 deadline = vm.getBlockTimestamp() + 60;
        bytes memory sig = sign(PLAYER_KEY, game.withdrawDigest(player, 10e6, other, deadline));
        vm.prank(keeper);
        game.withdrawBySig(player, 10e6, other, deadline, sig);
        assertEq(game.balanceOf(player), 40e6);
        assertEq(usdc.balanceOf(other), 1010e6);
        // The nonce moved on: the same signature is dead.
        vm.expectRevert(SkechGame.BadSignature.selector);
        game.withdrawBySig(player, 10e6, other, deadline, sig);
        // And a signature by someone else is no good.
        sig = sign(OTHER_KEY, game.withdrawDigest(player, 10e6, other, deadline));
        vm.expectRevert(SkechGame.BadSignature.selector);
        game.withdrawBySig(player, 10e6, other, deadline, sig);
        // Nor an expired one.
        sig = sign(PLAYER_KEY, game.withdrawDigest(player, 10e6, other, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(SkechGame.Expired.selector);
        game.withdrawBySig(player, 10e6, other, deadline, sig);
    }

    function test_withdrawWorksWhilePaused() public {
        deposit(player, 50e6);
        vm.prank(admin);
        game.pause();
        vm.prank(player);
        game.withdraw(50e6, player);
        assertEq(game.balanceOf(player), 0);
        vm.prank(player);
        usdc.approve(address(game), 1e6);
        vm.prank(player);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        game.deposit(1e6);
    }

    /* ------------------------------------------------------------------ */
    /* Sessions                                                            */
    /* ------------------------------------------------------------------ */

    function test_registerSecpSession() public {
        registerSession(PLAYER_KEY, SESSION_KEY, 100e6);
        SkechGame.Session memory s = game.sessionOf(player);
        assertEq(s.key, session);
        assertEq(s.allowance, 100e6);
        assertEq(s.validUntil, vm.getBlockTimestamp() + 1 days);
        assertEq(game.nonces(player), 1);
    }

    function test_registerP256Session() public {
        registerP256Session(PLAYER_KEY, P256_KEY, 100e6);
        (uint256 x, uint256 y) = vm.publicKeyP256(P256_KEY);
        SkechGame.Session memory s = game.sessionOf(player);
        assertEq(s.key, address(0));
        assertEq(s.x, bytes32(x));
        assertEq(s.y, bytes32(y));
    }

    function test_sessionNeedsThePlayersSignature() public {
        uint64 until = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 digest = game.sessionDigest(player, 0, session, 0, 0, until, 1e6, vm.getBlockTimestamp() + 60);
        vm.expectRevert(SkechGame.BadSignature.selector);
        game.registerSession(player, 0, session, 0, 0, until, 1e6, vm.getBlockTimestamp() + 60, sign(OTHER_KEY, digest));
        // A used signature cannot register again.
        bytes memory sig = sign(PLAYER_KEY, digest);
        game.registerSession(player, 0, session, 0, 0, until, 1e6, vm.getBlockTimestamp() + 60, sig);
        vm.expectRevert(SkechGame.BadSignature.selector);
        game.registerSession(player, 0, session, 0, 0, until, 1e6, vm.getBlockTimestamp() + 60, sig);
        // Wrong shapes.
        vm.expectRevert(SkechGame.BadSession.selector);
        game.registerSession(player, 0, address(0), 0, 0, until, 1e6, vm.getBlockTimestamp() + 60, sig);
        vm.expectRevert(SkechGame.BadSession.selector);
        game.registerSession(player, 1, address(0), bytes32(uint256(1)), bytes32(uint256(1)), until, 1e6, vm.getBlockTimestamp() + 60, sig);
        vm.expectRevert(SkechGame.BadSession.selector);
        game.registerSession(player, 2, session, 0, 0, until, 1e6, vm.getBlockTimestamp() + 60, sig);
    }

    function test_revokeSession() public {
        ready();
        // A session signed and never sent: revoking uses up the nonce it was signed at, so it cannot bring the key back.
        uint64 until = uint64(vm.getBlockTimestamp() + 1 days);
        uint256 deadline = vm.getBlockTimestamp() + 60;
        bytes memory pending = sign(PLAYER_KEY, game.sessionDigest(player, 0, session, 0, 0, until, 100e6, deadline));
        vm.prank(player);
        game.revokeSession();
        assertEq(game.sessionOf(player).validUntil, 0);
        vm.expectRevert(SkechGame.BadSignature.selector);
        game.registerSession(player, 0, session, 0, 0, until, 100e6, deadline, pending);
        SkechGame.Piece memory p = piece(1, 0, oneSection(HALF_DOT));
        vm.expectEmit(true, true, false, true);
        emit SkechGame.Refused(game.betIdOf(player, 1, 0), player, 1, 0, SkechGame.Refusal.Session);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        assertEq(game.balanceOf(player), 100e6);
    }

    function test_revokeSessionBySigIsRelayableOnce() public {
        ready();
        uint256 deadline = vm.getBlockTimestamp() + 60;
        bytes memory sig = sign(PLAYER_KEY, game.revokeDigest(player, deadline));
        // Someone else's signature, or an expired one, does nothing.
        bytes memory forged = sign(OTHER_KEY, game.revokeDigest(player, deadline));
        vm.expectRevert(SkechGame.BadSignature.selector);
        game.revokeSessionBySig(player, deadline, forged);
        vm.warp(deadline + 1);
        vm.expectRevert(SkechGame.Expired.selector);
        game.revokeSessionBySig(player, deadline, sig);
        vm.warp(deadline);
        vm.expectEmit(true, false, false, false);
        emit SkechGame.SessionRevoked(player);
        vm.prank(keeper);
        game.revokeSessionBySig(player, deadline, sig);
        assertEq(game.sessionOf(player).validUntil, 0);
        // Spent: it cannot be sent again.
        vm.expectRevert(SkechGame.BadSignature.selector);
        game.revokeSessionBySig(player, deadline, sig);
    }

    /* ------------------------------------------------------------------ */
    /* Placing                                                             */
    /* ------------------------------------------------------------------ */

    function test_placeAPiece() public {
        ready();
        SkechGame.Piece memory p = piece(7, 0, twoSections());
        // 50% and 10%: 1.5x and 8x at difficulty 51.
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000, 100_000_000));
        SkechGame.BetView memory b = game.betOf(betId);
        assertEq(b.player, player);
        assertEq(b.stake, 2 * HALF_DOT);
        assertEq(b.liveMask, 3);
        assertEq(b.hitMask, 0);
        assertEq(b.sections.length, 2);
        assertEq(b.rungs[0], 150);
        assertEq(b.rungs[1], 800);
        assertEq(b.sections[1].lo, LO + 5 * UNIT);
        // The stake left the balance; 4% is a fee; the rest is the pool.
        assertEq(game.balanceOf(player), 100e6 - 2 * HALF_DOT);
        assertEq(game.fees(), 4_000);
        assertEq(game.pool(), 96_000);
        assertEq(game.sessionOf(player).allowance, 100e6 - 2 * HALF_DOT);
        address[] memory ps = new address[](1);
        ps[0] = player;
        assertAccounted(ps);
    }

    function test_placeWithAP256Session() public {
        deposit(player, 100e6);
        registerP256Session(PLAYER_KEY, P256_KEY, 100e6);
        SkechGame.Piece memory p = piece(7, 0, oneSection(HALF_DOT));
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0] = placementP256(p, P256_KEY);
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        game.place(pls, q, sig);
        assertEq(game.betOf(game.betIdOf(player, 7, 0)).stake, HALF_DOT);
        // Another key's signature is refused.
        p.index = 1;
        pls[0] = placementP256(p, P256_KEY + 1);
        (q, sig) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        vm.expectEmit(true, true, false, true);
        emit SkechGame.Refused(game.betIdOf(player, 7, 1), player, 7, 1, SkechGame.Refusal.SessionSig);
        game.place(pls, q, sig);
    }

    function test_placeABatchOfPlayers() public {
        ready();
        deposit(other, 100e6);
        registerSession(OTHER_KEY, OTHER_SESSION_KEY, 100e6);
        SkechGame.Piece memory a = piece(1, 0, oneSection(HALF_DOT));
        SkechGame.Piece memory b = piece(2, 0, twoSections());
        b.player = other;
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](2);
        pls[0] = placement(a, SESSION_KEY);
        pls[1] = placement(b, OTHER_SESSION_KEY);
        uint32[] memory chances = new uint32[](3);
        chances[0] = 500_000_000;
        chances[1] = 100_000_000;
        chances[2] = 10_000_000;
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, a.openAt - 400, chances, 0);
        game.place(pls, q, sig);
        assertEq(game.betOf(game.betIdOf(player, 1, 0)).rungs[0], 150);
        assertEq(game.betOf(game.betIdOf(other, 2, 0)).rungs[0], 800);
        assertEq(game.betOf(game.betIdOf(other, 2, 0)).rungs[1], 9600);
        assertEq(game.pool(), 3 * HALF_DOT * 96 / 100);
        address[] memory ps = new address[](2);
        ps[0] = player;
        ps[1] = other;
        assertAccounted(ps);
    }

    function test_momentumMarginComesOffTheSideThePriceMovedTo() public {
        ready();
        // Both bands above the price; momentum up: with it. 60% earns 1.1x with the margin, 1.5x without.
        SkechGame.Piece memory p = piece(3, 0, twoSections());
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0] = placement(p, SESSION_KEY);
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, p.openAt - 400, chancesOf(600_000_000, 600_000_000), 1_000_000);
        game.place(pls, q, sig);
        assertEq(game.betOf(game.betIdOf(player, 3, 0)).rungs[0], 110);
        p.index = 1;
        pls[0] = placement(p, SESSION_KEY);
        (q, sig) = quote(pls, p.openAt - 400, chancesOf(600_000_000, 600_000_000), -1_000_000);
        game.place(pls, q, sig);
        assertEq(game.betOf(game.betIdOf(player, 3, 1)).rungs[0], 150);
    }

    function test_bandsNotOfferedAreRefundedAndBigOnesTrimmed() public {
        ready();
        SkechGame.Section[] memory s = new SkechGame.Section[](3);
        s[0] = section(1, LO, HI, HALF_DOT);
        s[1] = section(2, LO, HI, HALF_DOT);
        // 300 dots at 1.1x would pay more than 256 dots: only 23,272,727 of the stake is taken.
        s[2] = section(3, LO, HI, 300 * PER_DOT);
        SkechGame.Piece memory p = piece(4, 0, s);
        uint32[] memory chances = new uint32[](3);
        chances[0] = 500_000_000;
        chances[1] = 0; // not on offer
        chances[2] = 900_000_000; // 1.1x
        bytes32 betId = placeOne(p, SESSION_KEY, chances);
        SkechGame.BetView memory b = game.betOf(betId);
        assertEq(b.sections.length, 2);
        assertEq(b.sections[0].second, 1);
        assertEq(b.sections[1].second, 3);
        assertEq(b.sections[1].stake, 23_272_727);
        assertEq(b.stake, HALF_DOT + 23_272_727);
        assertEq(game.balanceOf(player), 100e6 - HALF_DOT - 23_272_727);
    }

    function test_aBandWhoseSecondIsAlreadyOnChainIsNotTaken() public {
        ready();
        // The bar for the piece's first second is already posted: that band cannot be bet on.
        SkechGame.Piece memory p = piece(5, 0, twoSections());
        postBar(p.openAt + 1000, PRICE, PRICE, PRICE, PRICE);
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000, 500_000_000));
        SkechGame.BetView memory b = game.betOf(betId);
        assertEq(b.sections.length, 1);
        assertEq(b.sections[0].second, 2);
    }

    function test_refusals() public {
        ready();
        SkechGame.Piece memory p = piece(9, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        // Replay: the same drawing and index.
        expectRefused(betId, 9, 0, SkechGame.Refusal.Replay);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        // Difficulty changed under the player. Every refusal spends its piece's name: each try from here is a new index.
        p.index = 1;
        p.difficulty = 60;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.Difficulty);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        p.difficulty = 51;
        // Received too late.
        p.index++;
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0] = placement(p, SESSION_KEY);
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, p.openAt + 201, chancesOf(500_000_000), 0);
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.Late);
        game.place(pls, q, sig);
        // The price seen is too old, or from the future.
        p.priceTime = p.openAt - 400 - 15_001;
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.StalePrice);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        p.priceTime = p.openAt - 399;
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.StalePrice);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        p.priceTime = p.openAt - 500;
        // A dot too cheap or too dear.
        p.perDot = 9_999;
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.PerDot);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        p.perDot = 100_000_001;
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.PerDot);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        p.perDot = PER_DOT;
        // Bands off the grid, out of reach, or upside down.
        p.sections[0].lo = LO + 1;
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.Sections);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        p.sections[0].lo = LO;
        p.sections[0].second = 31;
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.Sections);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        p.sections[0].second = 0;
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.Sections);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        p.sections[0].second = 1;
        p.sections[0].hi = LO;
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.Sections);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        p.sections[0].hi = HI;
        p.sections[0].stake = 10_000_000_001;
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.Sections);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        p.sections[0].stake = HALF_DOT;
        // The stroke does not match its hash.
        p.index++;
        pls[0] = placement(p, SESSION_KEY);
        pls[0].stroke = hex"00";
        (q, sig) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.Stroke);
        game.place(pls, q, sig);
        // The price the player saw was not signed by the oracle.
        p.index++;
        pls[0] = placement(p, SESSION_KEY);
        pls[0].priceSig = sign(OTHER_KEY, game.priceDigest("BTC-USD", p.priceSeen, p.priceTime));
        (q, sig) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.PriceSig);
        game.place(pls, q, sig);
        // Signed by the wrong session key.
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.SessionSig);
        placeOne(p, OTHER_SESSION_KEY, chancesOf(500_000_000));
        // Nothing on offer.
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.NotOffered);
        placeOne(p, SESSION_KEY, chancesOf(0));
        // Session expired.
        vm.warp(vm.getBlockTimestamp() + 1 days);
        p.openAt = openAtNow();
        p.priceTime = p.openAt - 500;
        p.index++;
        expectRefused(game.betIdOf(player, 9, p.index), 9, p.index, SkechGame.Refusal.Session);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        // Through all of that, nothing was charged; and a refused piece is spent, so it never goes in later.
        assertEq(game.balanceOf(player), 100e6 - HALF_DOT);
        assertTrue(game.wasRefused(game.betIdOf(player, 9, p.index)));
        assertFalse(game.wasRefused(betId));
        assertEq(game.sessionOf(player).allowance, 100e6 - HALF_DOT);
    }

    function test_refusedForAllowanceOrBalance() public {
        deposit(player, 1e6);
        registerSession(PLAYER_KEY, SESSION_KEY, 60_000);
        SkechGame.Piece memory p = piece(1, 0, oneSection(70_000));
        expectRefused(game.betIdOf(player, 1, 0), 1, 0, SkechGame.Refusal.Allowance);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        registerSession(PLAYER_KEY, SESSION_KEY, 100e6);
        p.index = 1;
        p.sections[0].stake = 2e6;
        expectRefused(game.betIdOf(player, 1, 1), 1, 1, SkechGame.Refusal.Balance);
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        assertEq(game.balanceOf(player), 1e6);
    }

    /// A piece refused for want of money is public calldata: sent again once the price has moved the player's way,
    /// and the balance topped up, it would be a free option. Its name was spent when it was refused.
    function test_aRefusedPieceCannotBePlacedLater() public {
        deposit(player, 30_000);
        registerSession(PLAYER_KEY, SESSION_KEY, 100e6);
        SkechGame.Piece memory p = piece(1, 0, oneSection(HALF_DOT));
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0] = placement(p, SESSION_KEY);
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        bytes32 betId = game.betIdOf(player, 1, 0);
        expectRefused(betId, 1, 0, SkechGame.Refusal.Balance);
        game.place(pls, q, sig);
        assertTrue(game.wasRefused(betId));
        // The same calldata, inside the window, after a top-up: refused as a replay, and nothing moves.
        deposit(player, 100e6);
        vm.warp(vm.getBlockTimestamp() + 2);
        expectRefused(betId, 1, 0, SkechGame.Refusal.Replay);
        game.place(pls, q, sig);
        assertEq(game.betOf(betId).player, address(0));
        assertEq(game.balanceOf(player), 100e6 + 30_000);
        assertEq(game.pool(), 0);
    }

    function test_quoteMustBeTheOraclesAndFitThePieces() public {
        ready();
        SkechGame.Piece memory p = piece(1, 0, oneSection(HALF_DOT));
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0] = placement(p, SESSION_KEY);
        (SkechGame.Quote memory q,) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = game.hashPiece(p);
        bytes memory bad = sign(OTHER_KEY, game.quoteDigest(q, hashes));
        vm.expectRevert(SkechGame.NotOracle.selector);
        game.place(pls, q, bad);
        // A quote for other pieces does not fit these.
        SkechGame.Piece memory p2 = piece(2, 0, oneSection(HALF_DOT));
        hashes[0] = game.hashPiece(p2);
        bytes memory forP2 = sign(ORACLE_KEY, game.quoteDigest(q, hashes));
        vm.expectRevert(SkechGame.NotOracle.selector);
        game.place(pls, q, forP2);
        // Chances must cover every band.
        (q,) = quote(pls, p.openAt - 400, chancesOf(500_000_000, 500_000_000), 0);
        hashes[0] = game.hashPiece(p);
        bytes memory sig = sign(ORACLE_KEY, game.quoteDigest(q, hashes));
        vm.expectRevert(SkechGame.BadQuote.selector);
        game.place(pls, q, sig);
        // A grid unit is a sliver of the price.
        (q,) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        q.unit = uint64(PRICE / 1000);
        sig = sign(ORACLE_KEY, game.quoteDigest(q, hashes));
        vm.expectRevert(SkechGame.BadQuote.selector);
        game.place(pls, q, sig);
        // The piece and the quote must agree on the second, the market and the grid.
        (q,) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        q.unit = UNIT / 2;
        sig = sign(ORACLE_KEY, game.quoteDigest(q, hashes));
        expectRefused(game.betIdOf(player, 1, 0), 1, 0, SkechGame.Refusal.Mismatch);
        game.place(pls, q, sig);
    }

    function test_theWindow() public {
        ready();
        SkechGame.Piece memory p = piece(1, 0, oneSection(HALF_DOT));
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0] = placement(p, SESSION_KEY);
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        // Four seconds on: the piece's first second is over. Too late to land.
        vm.warp(vm.getBlockTimestamp() + 4);
        vm.expectRevert(SkechGame.Window.selector);
        game.place(pls, q, sig);
        // Three seconds after opening is still inside the grace.
        vm.warp(vm.getBlockTimestamp() - 1);
        game.place(pls, q, sig);
        // And a piece for a second well ahead of the chain's clock does not land either.
        p.index = 1;
        p.openAt = openAtNow() + 4000;
        p.priceTime = p.openAt - 500;
        pls[0] = placement(p, SESSION_KEY);
        (q, sig) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        vm.expectRevert(SkechGame.Window.selector);
        game.place(pls, q, sig);
    }

    /// Closing a market stops new pieces, not settlement: the bets already open are posted and paid as ever.
    function test_aClosedMarketStillSettles() public {
        ready();
        deposit(other, 100e6);
        registerSession(OTHER_KEY, OTHER_SESSION_KEY, 100e6);
        SkechGame.Piece memory lost = piece(1, 0, oneSection(10 * PER_DOT));
        lost.player = other;
        lost.sections[0].lo = LO + 40 * UNIT;
        lost.sections[0].hi = HI + 40 * UNIT;
        placeOne(lost, OTHER_SESSION_KEY, chancesOf(500_000_000));
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        vm.prank(admin);
        game.setMarket(BTC, "BTC-USD", false, 51);
        vm.warp(vm.getBlockTimestamp() + 2);
        (SkechGame.Bar memory b, bytes memory sig) = bar(p.openAt + 1000, LO, HI, LO, HI);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = betId;
        game.postBarAndSettle(b, sig, ids);
        assertEq(game.betOf(betId).hitMask, 1);
        assertEq(game.balanceOf(player), 100e6 - HALF_DOT + 72_500);
        // A market that was never set up still takes no bars.
        (b, sig) = bar(p.openAt + 2000, HI, HI, HI, HI);
        b.market = 7;
        sig = sign(ORACLE_KEY, game.barDigest(b));
        vm.expectRevert(SkechGame.MarketInactive.selector);
        game.postBar(b, sig);
    }

    /// A bet whose bars never come is not stuck: an hour after its last second, its undecided bands are refunded.
    function test_expireRefundsWhatNoBarDecided() public {
        ready();
        deposit(other, 100e6);
        registerSession(OTHER_KEY, OTHER_SESSION_KEY, 100e6);
        SkechGame.Piece memory lost = piece(1, 0, oneSection(10 * PER_DOT));
        lost.player = other;
        lost.sections[0].lo = LO + 40 * UNIT;
        lost.sections[0].hi = HI + 40 * UNIT;
        bytes32 lostId = placeOne(lost, OTHER_SESSION_KEY, chancesOf(500_000_000));
        SkechGame.Piece memory p = piece(2, 0, twoSections());
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000, 500_000_000));
        // Only the first second is ever posted, and it misses both bets.
        postBar(p.openAt + 1000, LO - 10 * UNIT, LO - 10 * UNIT, LO - 12 * UNIT, LO - 11 * UNIT);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = betId;
        ids[1] = lostId;
        // Not yet due: nothing moves.
        uint64 due = p.openAt + 30_000 + game.EXPIRE_AFTER_MS();
        vm.warp(due / 1000 - 1);
        game.expire(ids);
        assertEq(game.betOf(betId).liveMask, 3);
        uint64 poolBefore = game.pool();
        uint64 fees = game.fees();
        vm.warp(due / 1000);
        vm.expectEmit(true, true, false, true);
        emit SkechGame.Settled(betId, player, 0, 1, 0, 0, 0);
        vm.expectEmit(true, true, false, true);
        emit SkechGame.Refunded(betId, player, 2, HALF_DOT, 0);
        game.expire(ids);
        // The first band was decided by its bar, a miss; the second never was: its stake is back, from the pool.
        SkechGame.BetView memory b = game.betOf(betId);
        assertEq(b.liveMask, 0);
        assertEq(b.hitMask, 0);
        assertEq(game.balanceOf(player), 100e6 - 2 * HALF_DOT + HALF_DOT);
        assertEq(game.pool(), poolBefore - HALF_DOT);
        assertEq(game.fees(), fees);
        // The loser's one band was decided: nothing to give back.
        assertEq(game.betOf(lostId).liveMask, 0);
        assertEq(game.balanceOf(other), 100e6 - 10 * PER_DOT);
        // Again, or a bar that turns up late, changes nothing.
        game.expire(ids);
        postBar(p.openAt + 2000, LO - 11 * UNIT, HI + 10 * UNIT, LO - 11 * UNIT, HI);
        settleOne(betId);
        assertEq(game.balanceOf(player), 100e6 - HALF_DOT);
        address[] memory ps = new address[](2);
        ps[0] = player;
        ps[1] = other;
        assertAccounted(ps);
    }

    /// A refund the pool cannot pay is owed, as a win would be.
    function test_expireOwesWhatThePoolCannotPay() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        assertEq(game.pool(), HALF_DOT * 96 / 100);
        vm.warp((p.openAt + 30_000 + game.EXPIRE_AFTER_MS()) / 1000);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = betId;
        game.expire(ids);
        assertEq(game.pool(), 0);
        assertEq(game.balanceOf(player), 100e6 - HALF_DOT + HALF_DOT * 96 / 100);
        assertEq(iou.basisOf(player), HALF_DOT * 4 / 100);
        address[] memory ps = new address[](1);
        ps[0] = player;
        assertAccounted(ps);
    }

    function test_inactiveMarket() public {
        ready();
        vm.prank(admin);
        game.setMarket(BTC, "BTC-USD", false, 51);
        SkechGame.Piece memory p = piece(1, 0, oneSection(HALF_DOT));
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0] = placement(p, SESSION_KEY);
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        vm.expectRevert(SkechGame.MarketInactive.selector);
        game.place(pls, q, sig);
    }

    /* ------------------------------------------------------------------ */
    /* Bars                                                                */
    /* ------------------------------------------------------------------ */

    function test_barsAreSignedOnceAndFollowOn() public {
        uint64 t = openAtNow();
        postBar(t, PRICE, PRICE + 100, PRICE - 100, PRICE + 50);
        (uint64 pc, uint64 h, uint64 l, uint64 c) = game.barAt(BTC, t);
        assertEq(pc, PRICE);
        assertEq(h, PRICE + 100);
        assertEq(l, PRICE - 100);
        assertEq(c, PRICE + 50);
        // The same again is fine; a different one for the same second is not.
        postBar(t, PRICE, PRICE + 100, PRICE - 100, PRICE + 50);
        (SkechGame.Bar memory b, bytes memory sig) = bar(t, PRICE, PRICE + 100, PRICE - 100, PRICE + 60);
        vm.expectRevert(SkechGame.BarConflict.selector);
        game.postBar(b, sig);
        // The next second must open where this one closed.
        (b, sig) = bar(t + 1000, PRICE + 40, PRICE + 100, PRICE - 100, PRICE + 60);
        vm.expectRevert(SkechGame.BarDiscontinuous.selector);
        game.postBar(b, sig);
        postBar(t + 1000, PRICE + 50, PRICE + 100, PRICE - 100, PRICE + 60);
        // Only the oracle's.
        (b,) = bar(t + 2000, PRICE + 60, PRICE + 100, PRICE - 100, PRICE + 60);
        bytes memory forged = sign(OTHER_KEY, game.barDigest(b));
        vm.expectRevert(SkechGame.NotOracle.selector);
        game.postBar(b, forged);
        // And it has to be a bar.
        (b, sig) = bar(t + 2000, PRICE + 60, PRICE - 100, PRICE + 100, PRICE + 60);
        vm.expectRevert(SkechGame.BadBar.selector);
        game.postBar(b, sig);
        (b, sig) = bar(t + 2500, PRICE + 60, PRICE + 100, PRICE - 100, PRICE + 60);
        vm.expectRevert(SkechGame.BadBar.selector);
        game.postBar(b, sig);
    }

    /// A second goes up only once it is over by the chain's clock, and fits the seconds either side of it, whichever
    /// went up first.
    function test_barsWaitForTheirSecondAndFitBothNeighbours() public {
        uint64 t = openAtNow() + 5000;
        // The second after next: its bar is signed, but it is not over on chain yet.
        SkechGame.Bar memory b = SkechGame.Bar({market: BTC, second: t, prevClose: PRICE, high: PRICE, low: PRICE, close: PRICE});
        bytes memory sig = sign(ORACLE_KEY, game.barDigest(b));
        vm.warp(t / 1000);
        vm.expectRevert(SkechGame.BadBar.selector);
        game.postBar(b, sig);
        vm.warp(t / 1000 + 1);
        game.postBar(b, sig);
        // Posted out of order: the second before must close where this one opened.
        (b, sig) = bar(t - 1000, PRICE - 50, PRICE, PRICE - 50, PRICE - 10);
        vm.expectRevert(SkechGame.BarDiscontinuous.selector);
        game.postBar(b, sig);
        postBar(t - 1000, PRICE - 50, PRICE, PRICE - 50, PRICE);
        (uint64 pc,,, uint64 c) = game.barAt(BTC, t - 1000);
        assertEq(pc, PRICE - 50);
        assertEq(c, PRICE);
    }

    /* ------------------------------------------------------------------ */
    /* Settling                                                            */
    /* ------------------------------------------------------------------ */

    function test_aHitPaysFromThePoolLessTheProfitFee() public {
        ready();
        // The other player loses a dollar first, so the pool can pay.
        deposit(other, 100e6);
        registerSession(OTHER_KEY, OTHER_SESSION_KEY, 100e6);
        SkechGame.Section[] memory far = new SkechGame.Section[](1);
        far[0] = section(1, LO + 40 * UNIT, HI + 40 * UNIT, 10 * PER_DOT);
        SkechGame.Piece memory lost = piece(1, 0, far);
        lost.player = other;
        bytes32 lostId = placeOne(lost, OTHER_SESSION_KEY, chancesOf(500_000_000));
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000)); // 1.5x
        uint64 poolBefore = game.pool();
        assertEq(poolBefore, (10 * PER_DOT + HALF_DOT) * 96 / 100);
        // The second: the price runs through the band (judged $0.20 wider: it reaches lo - unit).
        uint64 t = p.openAt + 1000;
        postBar(t, LO - 5 * UNIT, LO - UNIT, LO - 6 * UNIT, LO - 2 * UNIT);
        settleOne(betId);
        SkechGame.BetView memory b = game.betOf(betId);
        assertEq(b.liveMask, 0);
        assertEq(b.hitMask, 1);
        // 0.5 dot at 1.5x is 75,000: 25,000 profit, 2,500 of it the house's.
        assertEq(game.balanceOf(player), 100e6 - HALF_DOT + 72_500);
        assertEq(game.fees(), (10 * PER_DOT + HALF_DOT) * 4 / 100 + 2_500);
        assertEq(game.pool(), poolBefore - 75_000);
        // The loser's band missed: nothing moves but its mask.
        settleOne(lostId);
        b = game.betOf(lostId);
        assertEq(b.liveMask, 0);
        assertEq(b.hitMask, 0);
        assertEq(game.balanceOf(other), 100e6 - 10 * PER_DOT);
        // Settling again changes nothing.
        settleOne(betId);
        settleOne(lostId);
        assertEq(game.balanceOf(player), 100e6 - HALF_DOT + 72_500);
        address[] memory ps = new address[](2);
        ps[0] = player;
        ps[1] = other;
        assertAccounted(ps);
    }

    function test_aJumpAcrossTheBandCountsAsCrossingIt() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        // The second before closed below the band; every trade this second is above it: the price jumped through.
        postBar(p.openAt + 1000, LO - 10 * UNIT, HI + 10 * UNIT, HI + 5 * UNIT, HI + 8 * UNIT);
        settleOne(betId);
        assertEq(game.betOf(betId).hitMask, 1);
    }

    function test_edgesAreInclusiveOneUnitWide() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, twoSections());
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000, 500_000_000));
        // Exactly one unit under the band: a hit. Two units under: a miss.
        postBar(p.openAt + 1000, LO - UNIT, LO - UNIT, LO - 3 * UNIT, LO - 2 * UNIT);
        postBar(p.openAt + 2000, LO - 2 * UNIT, LO + 3 * UNIT, LO - 2 * UNIT, LO + 2 * UNIT); // second band is 5 units up: reaches lo2 - unit? lo2 - unit = LO + 4 * UNIT > high: miss
        settleOne(betId);
        SkechGame.BetView memory b = game.betOf(betId);
        assertEq(b.liveMask, 0);
        assertEq(b.hitMask, 1);
    }

    function test_partialSettlementWaitsForTheRest() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, twoSections());
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000, 500_000_000));
        postBar(p.openAt + 1000, LO - 5 * UNIT, LO - 4 * UNIT, LO - 6 * UNIT, LO - 4 * UNIT);
        settleOne(betId);
        SkechGame.BetView memory b = game.betOf(betId);
        assertEq(b.liveMask, 2);
        assertEq(b.hitMask, 0);
        // One transaction a second: the bar and the settlement together.
        (SkechGame.Bar memory br, bytes memory sig) = bar(p.openAt + 2000, LO - 4 * UNIT, HI + 5 * UNIT, LO - 4 * UNIT, HI);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = betId;
        game.postBarAndSettle(br, sig, ids);
        b = game.betOf(betId);
        assertEq(b.liveMask, 0);
        assertEq(b.hitMask, 2);
    }

    function test_settlingAnUnknownBetDoesNothing() public {
        settleOne(keccak256("nothing"));
    }

    /* ------------------------------------------------------------------ */
    /* IOUs                                                                */
    /* ------------------------------------------------------------------ */

    function test_whatThePoolCannotPayIsOwedAsIOU() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(100_000_000)); // 8x
        assertEq(game.pool(), 48_000);
        postBar(p.openAt + 1000, LO, HI, LO, HI);
        // 8 x 50,000 = 400,000; profit 350,000; fee 35,000; due 365,000; the pool pays 48,000 and owes 317,000.
        vm.expectEmit(true, false, false, false);
        emit SkechGame.Owed(player, 317_000, 0);
        settleOne(betId);
        assertEq(game.pool(), 0);
        assertEq(game.balanceOf(player), 100e6 - HALF_DOT + 48_000);
        assertEq(iou.basisOf(player), 365_000 - 48_000);
        assertEq(iou.assetsOf(player), 365_000 - 48_000);
        // The house's cut comes after the player, from what the pool has left: nothing, and it is not owed.
        assertEq(game.fees(), 2_000);
        assertEq(iou.balanceOf(address(revenue)), 0);
        assertEq(iou.totalAssets(), 365_000 - 48_000);
        assertEq(game.owed(), 317_000);
    }

    /// When the pool pays the player in full but not the house's whole cut, the house takes what is left, no more.
    function test_theHousesCutIsWhatThePoolHasLeft() public {
        ready();
        deposit(other, 100e6);
        registerSession(OTHER_KEY, OTHER_SESSION_KEY, 100e6);
        SkechGame.Piece memory lost = piece(1, 0, oneSection(3 * HALF_DOT));
        lost.player = other;
        lost.sections[0].lo = LO + 40 * UNIT;
        lost.sections[0].hi = HI + 40 * UNIT;
        placeOne(lost, OTHER_SESSION_KEY, chancesOf(500_000_000));
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(250_000_000)); // 3x
        // The pool: 96% of 200,000. The hit: 150,000 gross, 100,000 profit, 10,000 the house's; 140,000 to the player.
        assertEq(game.pool(), 192_000);
        uint64 fees = game.fees();
        postBar(p.openAt + 1000, LO, HI, LO, HI);
        vm.expectEmit(true, true, false, true);
        emit SkechGame.Settled(betId, player, 1, 0, 140_000, 0, 10_000);
        settleOne(betId);
        assertEq(game.fees(), fees + 10_000);
        assertEq(game.pool(), 192_000 - 150_000);
        // Now a hit the pool pays the player, all but the house's cut.
        SkechGame.Piece memory q = piece(3, 0, oneSection(20_000));
        vm.warp(vm.getBlockTimestamp() + 1);
        q.openAt = openAtNow();
        q.priceTime = q.openAt - 500;
        bytes32 qId = placeOne(q, SESSION_KEY, chancesOf(250_000_000));
        // Pool 42,000 + 19,200 = 61,200. Hit: 60,000 gross, 40,000 profit, 4,000 cut, 56,000 due: 5,200 left for the cut.
        assertEq(game.pool(), 61_200);
        fees = game.fees();
        postBar(q.openAt + 1000, LO, HI, LO, HI);
        vm.expectEmit(true, true, false, true);
        emit SkechGame.Settled(qId, player, 1, 0, 56_000, 0, 4_000);
        settleOne(qId);
        assertEq(game.pool(), 1_200);
        assertEq(game.fees(), fees + 4_000);
        assertEq(game.owed(), 0);
    }

    function test_iouIsRedeemedByAnyoneOnceThePoolHasMoney() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(100_000_000)); // 8x
        postBar(p.openAt + 1000, LO, HI, LO, HI);
        settleOne(betId);
        uint64 owed = iou.assetsOf(player);
        assertEq(owed, 317_000);
        uint256 shares = iou.balanceOf(player);
        // Nothing in the pool: nothing to redeem.
        vm.prank(keeper);
        vm.expectRevert(SkechGame.NothingToRedeem.selector);
        game.redeem(player, shares);
        // Ten thousand blocks on, the debt has grown by 3.5e9 * 10,000 / 1e18 = 0.0035% more.
        uint256 indexBefore = iou.index();
        vm.roll(vm.getBlockNumber() + 10_000);
        assertEq(iou.index(), indexBefore + 3_500_000_000 * 10_000);
        uint64 value = iou.assetsOf(player);
        assertGt(value, owed);
        assertLt(value, owed + 20);
        // Someone else loses, and the pool has money again.
        deposit(other, 100e6);
        registerSession(OTHER_KEY, OTHER_SESSION_KEY, 100e6);
        vm.warp(vm.getBlockTimestamp() + 10);
        SkechGame.Piece memory lost = piece(3, 0, oneSection(10 * PER_DOT));
        lost.player = other;
        placeOne(lost, OTHER_SESSION_KEY, chancesOf(500_000_000));
        assertEq(game.pool(), 960_000);
        // The keeper hands the player's IOU back: the player gets the value less 10% of the growth, the keeper that 10%.
        vm.prank(keeper);
        game.redeem(player, shares);
        uint64 growth = value - owed; // 11
        assertEq(game.balanceOf(player), 100e6 - HALF_DOT + 48_000 + value - growth / 10);
        assertEq(game.balanceOf(keeper), growth / 10);
        assertEq(iou.balanceOf(player), 0);
        assertEq(iou.basisOf(player), 0);
        assertEq(game.pool(), 960_000 - value);
        assertEq(game.owed(), 0);
        // The house was never owed: there is nothing of its to redeem.
        vm.prank(keeper);
        vm.expectRevert(SkechGame.NothingToRedeem.selector);
        game.redeem(address(revenue), type(uint256).max);
        address[] memory ps = new address[](3);
        ps[0] = player;
        ps[1] = other;
        ps[2] = keeper;
        assertAccounted(ps);
    }

    function test_holderRedeemsTheirOwnIOUWithoutACut() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(100_000_000));
        postBar(p.openAt + 1000, LO, HI, LO, HI);
        settleOne(betId);
        vm.roll(vm.getBlockNumber() + 10_000);
        uint64 value = iou.assetsOf(player);
        deposit(other, 100e6);
        registerSession(OTHER_KEY, OTHER_SESSION_KEY, 100e6);
        vm.warp(vm.getBlockTimestamp() + 10);
        SkechGame.Piece memory lost = piece(3, 0, oneSection(10 * PER_DOT));
        lost.player = other;
        placeOne(lost, OTHER_SESSION_KEY, chancesOf(500_000_000));
        uint64 before = game.balanceOf(player);
        vm.prank(player);
        game.redeem(player, type(uint256).max);
        assertEq(game.balanceOf(player), before + value);
    }

    function test_iouIsRedeemedPartlyWhenThePoolIsShort() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(100_000_000));
        postBar(p.openAt + 1000, LO, HI, LO, HI);
        settleOne(betId);
        uint256 shares = iou.balanceOf(player);
        // A small loss: the pool has 96,000 against 317,000 owed.
        deposit(other, 100e6);
        registerSession(OTHER_KEY, OTHER_SESSION_KEY, 100e6);
        vm.warp(vm.getBlockTimestamp() + 10);
        SkechGame.Piece memory lost = piece(3, 0, oneSection(PER_DOT));
        lost.player = other;
        placeOne(lost, OTHER_SESSION_KEY, chancesOf(500_000_000));
        assertEq(game.pool(), 96_000);
        vm.prank(keeper);
        game.redeem(player, shares);
        // The pool is emptied, to the rounding of a share.
        assertLe(game.pool(), 1);
        uint64 paid = 96_000 - game.pool();
        // What is left is owed still, to the rounding of a share.
        assertApproxEqAbs(iou.assetsOf(player), 317_000 - paid, 1);
        assertApproxEqAbs(iou.basisOf(player), 317_000 - paid, 1);
        assertEq(game.balanceOf(player), 100e6 - HALF_DOT + 48_000 + paid);
        // Dust cannot be nibbled: a partial redemption must be worth at least the minimum.
        vm.prank(keeper);
        vm.expectRevert(SkechGame.NothingToRedeem.selector);
        game.redeem(player, shares);
    }

    function test_iouTransfersCarryTheirBasis() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(100_000_000));
        postBar(p.openAt + 1000, LO, HI, LO, HI);
        settleOne(betId);
        uint256 shares = iou.balanceOf(player);
        vm.prank(player);
        iou.transfer(other, shares / 4);
        assertApproxEqAbs(iou.basisOf(other), 317_000 / 4, 1);
        assertApproxEqAbs(iou.basisOf(player), 317_000 - 317_000 / 4, 1);
        assertEq(iou.basisOf(other) + iou.basisOf(player), 317_000);
        vm.prank(player);
        iou.transfer(other, shares - shares / 4);
        assertEq(iou.basisOf(player), 0);
        assertEq(iou.basisOf(other), 317_000);
        // Dust carries its basis with it, rounded up: sent a share-wei at a time, the basis never stays behind.
        vm.prank(other);
        iou.transfer(player, 1);
        assertEq(iou.basisOf(player), 1);
        assertEq(iou.basisOf(other), 317_000 - 1);
        assertEq(game.owed(), 317_000);
        // Only the game mints and burns.
        vm.expectRevert();
        iou.mint(other, 1);
        vm.prank(admin);
        vm.expectRevert();
        iou.burn(other, 1);
    }

    function test_iouRateCanChangeWithoutLosingAccrual() public {
        vm.roll(vm.getBlockNumber() + 1000);
        uint256 before = iou.index();
        vm.prank(admin);
        iou.setRate(7_000_000_000);
        assertEq(iou.index(), before);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(iou.index(), before + 7_000_000_000);
        // No faster than 10% a day.
        vm.prank(admin);
        vm.expectRevert(SkechIOU.BadRate.selector);
        iou.setRate(350_000_000_001);
    }

    /* ------------------------------------------------------------------ */
    /* Fees, pause, admin, upgrades                                        */
    /* ------------------------------------------------------------------ */

    function test_feesAreCollectedToTheRevenueHolder() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, oneSection(10 * PER_DOT));
        placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        assertEq(game.fees(), 40_000);
        vm.prank(keeper);
        assertEq(game.collectFees(), 40_000);
        assertEq(game.fees(), 0);
        assertEq(usdc.balanceOf(address(revenue)), 40_000);
        assertEq(game.collectFees(), 0);
        // The treasurer takes it out; nobody else.
        vm.prank(keeper);
        vm.expectRevert();
        revenue.withdraw(address(usdc), keeper, 40_000);
        vm.prank(admin);
        revenue.withdraw(address(usdc), keeper, 40_000);
        assertEq(usdc.balanceOf(keeper), 40_000);
        address[] memory ps = new address[](1);
        ps[0] = player;
        assertAccounted(ps);
    }

    function test_pauseStopsTheGameButNotWithdrawals() public {
        ready();
        vm.prank(admin);
        game.pause();
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0] = placement(p, SESSION_KEY);
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, p.openAt - 400, chancesOf(500_000_000), 0);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        game.place(pls, q, sig);
        (SkechGame.Bar memory b, bytes memory bs) = bar(p.openAt, PRICE, PRICE, PRICE, PRICE);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        game.postBar(b, bs);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        game.redeem(player, 1);
        vm.prank(player);
        game.withdraw(100e6, player);
        vm.prank(admin);
        game.unpause();
        vm.prank(keeper);
        vm.expectRevert();
        game.pause();
    }

    function test_difficultyIsSetOnChainAndOldPiecesKeepTheirs() public {
        ready();
        SkechGame.Piece memory p = piece(2, 0, oneSection(HALF_DOT));
        bytes32 betId = placeOne(p, SESSION_KEY, chancesOf(500_000_000));
        vm.prank(admin);
        game.setDifficulty(BTC, 100);
        assertEq(game.difficultyOf(BTC), 100);
        assertEq(game.betOf(betId).difficulty, 51);
        assertEq(game.betOf(betId).rungs[0], 150);
        // Now 50% earns 0.8 / 0.5 = 1.6: 1.5x still; 75% earns 1.067: under 1.1x, so the floor, which is 1.0x at 100.
        assertEq(game.rungFor(BTC, 500_000_000, false, 0), 150);
        assertEq(game.rungFor(BTC, 750_000_000, false, 0), 100);
        assertEq(game.rungFor(BTC, 600_000_000, false, 0), 110);
        // 90% earns 0.889: under the floor, so its fair multiple, never under 1x.
        assertEq(game.rungFor(BTC, 900_000_000, false, 0), 100);
        vm.prank(admin);
        vm.expectRevert(SkechGame.BadDifficulty.selector);
        game.setDifficulty(BTC, 101);
        // Under 50, ink exactly on a rung would return more than a dollar: refused, on its own and with the market.
        vm.prank(admin);
        vm.expectRevert(SkechGame.BadDifficulty.selector);
        game.setDifficulty(BTC, 49);
        vm.prank(admin);
        vm.expectRevert(SkechGame.BadDifficulty.selector);
        game.setMarket(BTC, "BTC-USD", true, 0);
        vm.prank(admin);
        game.setDifficulty(BTC, 50);
        assertEq(game.rungFor(BTC, 1_000_000_000, false, 0), 100);
        vm.prank(keeper);
        vm.expectRevert();
        game.setDifficulty(BTC, 10);
    }

    function test_configBounds() public {
        SkechGame.Config memory c = game.config();
        c.feeBps = 2001;
        vm.prank(admin);
        vm.expectRevert(SkechGame.BadConfig.selector);
        game.setConfig(c);
        c = game.config();
        c.placeGraceMs = 500;
        vm.prank(admin);
        vm.expectRevert(SkechGame.BadConfig.selector);
        game.setConfig(c);
        // Nothing left unbounded: a stale price, a huge dot or piece, a minimum redemption that stops them all.
        c = game.config();
        c.maxPriceAgeMs = 60_001;
        vm.prank(admin);
        vm.expectRevert(SkechGame.BadConfig.selector);
        game.setConfig(c);
        c = game.config();
        c.maxPriceAgeMs = 0;
        vm.prank(admin);
        vm.expectRevert(SkechGame.BadConfig.selector);
        game.setConfig(c);
        c = game.config();
        c.maxPerDot = 10_000e6 + 1;
        vm.prank(admin);
        vm.expectRevert(SkechGame.BadConfig.selector);
        game.setConfig(c);
        c = game.config();
        c.maxPieceStake = 1_000_000e6 + 1;
        vm.prank(admin);
        vm.expectRevert(SkechGame.BadConfig.selector);
        game.setConfig(c);
        c = game.config();
        c.minRedeem = 100e6 + 1;
        vm.prank(admin);
        vm.expectRevert(SkechGame.BadConfig.selector);
        game.setConfig(c);
        c = game.config();
        c.lateMs = 500;
        vm.prank(admin);
        game.setConfig(c);
        assertEq(game.config().lateMs, 500);
    }

    function test_onlyTheUpgraderUpgradesAndStorageStays() public {
        ready();
        SkechGame fresh = new SkechGame();
        vm.prank(keeper);
        vm.expectRevert();
        game.upgradeToAndCall(address(fresh), "");
        vm.prank(admin);
        game.upgradeToAndCall(address(fresh), "");
        assertEq(game.balanceOf(player), 100e6);
        assertEq(game.sessionOf(player).key, session);
        assertEq(game.oracle(), oracle);
        // The implementation cannot be initialized on its own.
        vm.expectRevert();
        fresh.initialize(admin, oracle, IERC20(address(usdc)), ISkechIOU(address(iou)), address(revenue));
        SkechIOU freshIou = new SkechIOU();
        uint256 indexBefore = iou.index();
        vm.prank(admin);
        iou.upgradeToAndCall(address(freshIou), "");
        assertEq(iou.index(), indexBefore);
    }

    /// A game still at version 1 is upgraded with what it already owes, once, by the upgrader, in the same call.
    function test_theUpgradeFromVersionOneSetsWhatIsOwed() public {
        // Initializable's slot (ERC-7201 "openzeppelin.storage.Initializable"): put the proxy back at version 1.
        bytes32 slot = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;
        vm.store(address(game), slot, bytes32(uint256(1)));
        SkechGame fresh = new SkechGame();
        vm.prank(keeper);
        vm.expectRevert();
        game.upgradeToAndCall(address(fresh), abi.encodeCall(SkechGame.initializeV2, (317_000)));
        vm.prank(admin);
        game.upgradeToAndCall(address(fresh), abi.encodeCall(SkechGame.initializeV2, (317_000)));
        assertEq(game.owed(), 317_000);
        // Once only; and a fresh deployment starts at version 2, owing nothing.
        vm.prank(admin);
        vm.expectRevert();
        game.initializeV2(1);
        SkechGame other_ = SkechGame(
            address(
                new ERC1967Proxy(
                    address(new SkechGame()),
                    abi.encodeCall(SkechGame.initialize, (admin, oracle, IERC20(address(usdc)), ISkechIOU(address(iou)), address(revenue)))
                )
            )
        );
        vm.prank(admin);
        vm.expectRevert();
        other_.initializeV2(1);
        assertEq(other_.owed(), 0);
    }

    /// The vector `packages/engine/src/quote.rs` signs: the engine's price signatures verify under this contract's domain.
    function test_takesTheEnginesPriceSignature() public {
        address engine = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        address verifier = 0x5Ec400000000000000000000000000000000C0De;
        vm.chainId(31337);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            abi.encode(
                address(new SkechGame()),
                abi.encodeCall(SkechGame.initialize, (admin, engine, IERC20(address(usdc)), ISkechIOU(address(iou)), address(revenue)))
            ),
            verifier
        );
        SkechGame at = SkechGame(verifier);
        bytes memory sig =
            hex"4078c8f2b1604da6d60a1f986b1430ea682b15e27f1b0c18b286742f694c1b9b289c1bf1a51cddfa72479675e8751f700e607290624c342878570f57704ebf8e1c";
        assertEq(ECDSA.recover(at.priceDigest("BTC-USD", 8_359_144_000_000, 1_790_629_278_967), sig), engine);
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = at.eip712Domain();
        assertEq(name, "skech");
        assertEq(version, "1");
        assertEq(chainId, 31337);
        assertEq(verifying, verifier);
    }

    /* ---- helpers ---- */

    function expectRefused(bytes32 betId, uint64 drawing, uint32 index, SkechGame.Refusal why) internal {
        vm.expectEmit(true, true, false, true);
        emit SkechGame.Refused(betId, player, drawing, index, why);
    }
}
