// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SkechGame} from "../src/SkechGame.sol";
import {SkechIOU} from "../src/SkechIOU.sol";
import {SkechRevenue} from "../src/SkechRevenue.sol";
import {ISkechIOU} from "../src/interfaces/ISkechIOU.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev The three contracts behind proxies, a player with USDC and a session, and the signatures every test needs.
abstract contract Base is Test {
    uint256 internal constant ORACLE_KEY = 0xA11CE;
    uint256 internal constant PLAYER_KEY = 0xB0B;
    uint256 internal constant SESSION_KEY = 0x5E55;
    uint256 internal constant P256_KEY = 0x7256;
    uint256 internal constant KEEPER_KEY = 0xC0FFEE;
    uint256 internal constant OTHER_KEY = 0xD0D0;
    uint256 internal constant OTHER_SESSION_KEY = 0x5E56;

    /// @dev P-256's order, to flip a high `s`.
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    uint8 internal constant BTC = 0;
    /// @dev A $0.20 grid, on an $83,591 price.
    uint64 internal constant UNIT = 20_000_000;
    uint64 internal constant PRICE = 8_359_144_000_000;
    /// @dev A band from $83,591.40 to $83,592.00, judged $0.20 wider each way.
    uint64 internal constant LO = 8_359_140_000_000;
    uint64 internal constant HI = 8_359_200_000_000;
    uint64 internal constant PER_DOT = 100_000; // 10 cents
    uint64 internal constant HALF_DOT = 50_000;
    uint64 internal constant T0 = 1_790_000_000; // seconds

    address internal admin;
    address internal oracle;
    address internal player;
    address internal session;
    address internal keeper;
    address internal other;
    address internal otherSession;

    MockUSDC public usdc;
    SkechIOU public iou;
    SkechRevenue public revenue;
    SkechGame public game;

    function setUp() public virtual {
        admin = vm.addr(ORACLE_KEY);
        oracle = admin;
        player = vm.addr(PLAYER_KEY);
        session = vm.addr(SESSION_KEY);
        keeper = vm.addr(KEEPER_KEY);
        other = vm.addr(OTHER_KEY);
        otherSession = vm.addr(OTHER_SESSION_KEY);
        vm.label(admin, "admin/oracle");
        vm.label(player, "player");
        vm.label(session, "session");
        vm.label(keeper, "keeper");
        vm.label(other, "other");

        usdc = new MockUSDC();
        revenue = SkechRevenue(
            payable(address(new ERC1967Proxy(address(new SkechRevenue()), abi.encodeCall(SkechRevenue.initialize, (admin)))))
        );
        iou = SkechIOU(
            address(new ERC1967Proxy(address(new SkechIOU()), abi.encodeCall(SkechIOU.initialize, (admin, admin, 3_500_000_000))))
        );
        game = SkechGame(
            address(
                new ERC1967Proxy(
                    address(new SkechGame()),
                    abi.encodeCall(SkechGame.initialize, (admin, oracle, IERC20(address(usdc)), ISkechIOU(address(iou)), address(revenue)))
                )
            )
        );
        vm.startPrank(admin);
        iou.grantRole(iou.MINTER_ROLE(), address(game));
        iou.revokeRole(iou.MINTER_ROLE(), admin);
        vm.stopPrank();
        vm.label(address(game), "game");
        vm.label(address(iou), "iou");
        vm.label(address(revenue), "revenue");

        vm.warp(T0);
        vm.roll(1000);
        usdc.mint(player, 1_000e6);
        usdc.mint(other, 1_000e6);
    }

    /* ---- signing ---- */

    function sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev What the browser does: sign the digest with P-256 over SHA-256, `s` in the low half.
    function signP256(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(key, sha256(abi.encodePacked(digest)));
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        return abi.encodePacked(r, s);
    }

    function priceSig(uint64 price, uint64 time) internal view returns (bytes memory) {
        return sign(ORACLE_KEY, game.priceDigest("BTC-USD", price, time));
    }

    /* ---- sessions ---- */

    function registerSession(uint256 playerKey, uint256 sessionKey, uint64 allowance) internal {
        address who = vm.addr(playerKey);
        uint64 until = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 digest = game.sessionDigest(who, 0, vm.addr(sessionKey), 0, 0, until, allowance, vm.getBlockTimestamp() + 60);
        game.registerSession(who, 0, vm.addr(sessionKey), 0, 0, until, allowance, vm.getBlockTimestamp() + 60, sign(playerKey, digest));
    }

    function registerP256Session(uint256 playerKey, uint256 p256Key, uint64 allowance) internal {
        address who = vm.addr(playerKey);
        (uint256 x, uint256 y) = vm.publicKeyP256(p256Key);
        uint64 until = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 digest = game.sessionDigest(who, 1, address(0), bytes32(x), bytes32(y), until, allowance, vm.getBlockTimestamp() + 60);
        game.registerSession(who, 1, address(0), bytes32(x), bytes32(y), until, allowance, vm.getBlockTimestamp() + 60, sign(playerKey, digest));
    }

    /// @dev An EIP-3009 `ReceiveWithAuthorization` from `key`'s address to the game, as a wallet signs it for x402.
    function authorization(uint256 key, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), vm.addr(key), address(game), value, validAfter, validBefore, nonce)
        );
        return sign(key, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function deposit(address who, uint64 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(game), amount);
        game.deposit(amount);
        vm.stopPrank();
    }

    /// @dev A player with money in and a session on: the usual starting point.
    function ready() internal {
        deposit(player, 100e6);
        registerSession(PLAYER_KEY, SESSION_KEY, 100e6);
    }

    /* ---- pieces ---- */

    function openAtNow() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp()) * 1000;
    }

    function section(uint8 second, uint64 lo, uint64 hi, uint64 stake) internal pure returns (SkechGame.Section memory) {
        return SkechGame.Section({second: second, lo: lo, hi: hi, stake: stake});
    }

    /// @dev A piece of `player`'s, opening on this block's second, on the default grid, with `sections`.
    function piece(uint64 drawing, uint32 index, SkechGame.Section[] memory sections) internal view returns (SkechGame.Piece memory p) {
        p.player = player;
        p.drawing = drawing;
        p.index = index;
        p.market = BTC;
        p.difficulty = game.difficultyOf(BTC);
        p.openAt = openAtNow();
        p.perDot = PER_DOT;
        p.unit = UNIT;
        p.priceSeen = PRICE;
        p.priceTime = p.openAt - 500;
        p.sections = sections;
        p.strokeHash = keccak256(stroke());
    }

    function stroke() internal pure returns (bytes memory) {
        return hex"0000000100000002";
    }

    function oneSection(uint64 stake) internal pure returns (SkechGame.Section[] memory s) {
        s = new SkechGame.Section[](1);
        s[0] = section(1, LO, HI, stake);
    }

    function twoSections() internal pure returns (SkechGame.Section[] memory s) {
        s = new SkechGame.Section[](2);
        s[0] = section(1, LO, HI, HALF_DOT);
        s[1] = section(2, LO + 5 * UNIT, HI + 5 * UNIT, HALF_DOT);
    }

    function placement(SkechGame.Piece memory p, uint256 sessionKey) internal view returns (SkechGame.Placement memory pl) {
        pl.piece = p;
        pl.sessionSig = sign(sessionKey, game.pieceDigest(p));
        pl.priceSig = priceSig(p.priceSeen, p.priceTime);
        pl.stroke = stroke();
    }

    function placementP256(SkechGame.Piece memory p, uint256 p256Key) internal view returns (SkechGame.Placement memory pl) {
        pl.piece = p;
        pl.sessionSig = signP256(p256Key, game.pieceDigest(p));
        pl.priceSig = priceSig(p.priceSeen, p.priceTime);
        pl.stroke = stroke();
    }

    /// @dev The oracle's quote for `pls`, received at `receivedAt` each, with `chances` for every section in order.
    function quote(SkechGame.Placement[] memory pls, uint64 receivedAt, uint32[] memory chances, int64 momentum)
        internal
        view
        returns (SkechGame.Quote memory q, bytes memory sig)
    {
        q.market = BTC;
        q.openAt = pls[0].piece.openAt;
        q.unit = UNIT;
        q.price = PRICE;
        q.momentum = momentum;
        q.receivedAt = new uint64[](pls.length);
        bytes32[] memory hashes = new bytes32[](pls.length);
        for (uint256 i = 0; i < pls.length; i++) {
            q.receivedAt[i] = receivedAt;
            hashes[i] = game.hashPiece(pls[i].piece);
        }
        q.chances = chances;
        sig = sign(ORACLE_KEY, game.quoteDigest(q, hashes));
    }

    function chancesOf(uint32 a) internal pure returns (uint32[] memory c) {
        c = new uint32[](1);
        c[0] = a;
    }

    function chancesOf(uint32 a, uint32 b) internal pure returns (uint32[] memory c) {
        c = new uint32[](2);
        c[0] = a;
        c[1] = b;
    }

    /// @dev Place one piece with a secp256k1 session, received in time, at these chances.
    function placeOne(SkechGame.Piece memory p, uint256 sessionKey, uint32[] memory chances) internal returns (bytes32 betId) {
        SkechGame.Placement[] memory pls = new SkechGame.Placement[](1);
        pls[0] = placement(p, sessionKey);
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, p.openAt - 400, chances, 0);
        game.place(pls, q, sig);
        return game.betIdOf(p.player, p.drawing, p.index);
    }

    /* ---- bars ---- */

    /// @dev The oracle's bar for `second`. A second is posted only once it is over on chain: the clock moves on to it.
    function bar(uint64 second, uint64 prevClose, uint64 high, uint64 low, uint64 close)
        internal
        returns (SkechGame.Bar memory b, bytes memory sig)
    {
        if (vm.getBlockTimestamp() * 1000 < second + 1000) vm.warp((second + 1000) / 1000);
        b = SkechGame.Bar({market: BTC, second: second, prevClose: prevClose, high: high, low: low, close: close});
        sig = sign(ORACLE_KEY, game.barDigest(b));
    }

    function postBar(uint64 second, uint64 prevClose, uint64 high, uint64 low, uint64 close) internal {
        (SkechGame.Bar memory b, bytes memory sig) = bar(second, prevClose, high, low, close);
        game.postBar(b, sig);
    }

    function settleOne(bytes32 betId) internal {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = betId;
        game.settle(ids);
    }

    /// @dev The one accounting invariant: every USDC in the game is someone's balance, the pool, or a fee.
    function assertAccounted(address[] memory players) internal view {
        uint256 sum;
        for (uint256 i = 0; i < players.length; i++) {
            sum += game.balanceOf(players[i]);
        }
        assertEq(usdc.balanceOf(address(game)), sum + game.pool() + game.fees(), "usdc accounted for");
    }
}
