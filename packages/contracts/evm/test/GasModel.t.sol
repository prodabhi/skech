// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {Base} from "./Base.t.sol";
import {SkechGame} from "../src/SkechGame.sol";

/// @dev What each of the relayer's transactions costs, measured in the worst state it can meet, and the linear
/// model the relayer sets gas limits from. Monad charges the limit, not what runs, and its receipts report the
/// limit as used, so the limit has to be right before sending: this is where it is made right. Runs isolated
/// (foundry.toml), so every call is its own transaction and starts cold, priced as Monad prices it (`network`).
///
/// Writes `snapshots/GasModel.json`, which `packages/relayer/src/gas.ts` reads: execution gas per scenario, the
/// coefficients derived from it, and the cross-check batches. `snapshots/GasModelRaw.json` keeps the whole
/// transactions as measured. `FORGE_SNAPSHOT_CHECK=true forge test` fails when a number moves, so a contract change
/// that moves gas is a change here too.
///
/// Every number in GasModel.json is execution only: the transaction's 21,000 and its calldata (16 a byte set,
/// 4 a byte clear) are taken off what was measured, and the relayer puts back what its own bytes cost.
///
/// What the measurements cannot see is where a bet lands in storage. Monad warms storage a page of 128 slots at
/// a time; a bet's words are consecutive but start anywhere, so on chain they may straddle two pages where here
/// they sat in one, and a session's three words likewise. `place.pageSlack` and `settle.pageSlack` allow for
/// that, per piece and per bet: one more page loaded and written, one more page read.
contract GasModelTest is Base {
    string internal constant G = "GasModel";
    string internal constant RAW = "GasModelRaw";
    uint32 internal constant EVEN = 500_000_000; // 50%: 1.5x at difficulty 51
    uint32 internal constant LONG = 100_000_000; // 10%: 8x
    uint64 internal constant FAR = 40 * UNIT; // a band $8 off the price: never hit
    /// @dev Monad: a page read for the first time is 8,100; written for the first time, 8,000 + 2,800 more.
    uint256 internal constant PAGE_READ = 8_100;
    uint256 internal constant PAGE_WRITE = 10_800;

    struct Player {
        address who;
        uint256 key;
        uint256 p256;
    }

    Player[] internal ps;
    mapping(string => uint256) internal coefs;

    /* ---- measuring ---- */

    function calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i = 0; i < data.length; i++) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// @dev Send `data` to the game as its own transaction; record the whole of it raw, and its execution by `name`.
    function measure(bytes memory data, string memory name) internal returns (uint256 exec) {
        (bool ok, bytes memory ret) = address(game).call(data);
        if (!ok) {
            console.log(name, "reverted");
            console.logBytes(ret);
            revert(name);
        }
        uint256 whole = vm.snapshotGasLastFrame(RAW, name);
        exec = whole - 21_000 - calldataGas(data);
        vm.snapshotValue(G, name, exec);
    }

    function setCoef(string memory name, uint256 value) internal {
        coefs[name] = value;
        vm.snapshotValue(G, name, value);
    }

    function coef(string memory name) internal view returns (uint256) {
        return coefs[name];
    }

    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    /// @dev `model` must cover `measured`, and not by more than the slack a worst-case term can leave.
    function check(string memory name, uint256 measured, uint256 model) internal {
        vm.snapshotValue(G, string.concat("check.", name, ".measured"), measured);
        vm.snapshotValue(G, string.concat("check.", name, ".model"), model);
        console.log(string.concat("check ", name), measured, model, (model * 1000) / measured);
        assertGe(model, measured, string.concat(name, ": the model is short"));
        assertLe(model, (measured * 140) / 100, string.concat(name, ": the model is far too loose"));
    }

    /* ---- players and pieces ---- */

    function newPlayer(uint64 balance) internal returns (Player memory p) {
        uint256 i = ps.length;
        p = Player({who: vm.addr(0xC0DE00 + i), key: 0xC0DE00 + i, p256: 0x7256000 + i});
        ps.push(p);
        usdc.mint(p.who, balance);
        deposit(p.who, balance);
        registerP256Session(p.key, p.p256, 1_000e6);
    }

    /// @dev `n` sections, one a second from `first`, all on the band `lo`..`lo + 3 units`, `stake` each.
    function run(uint8 first, uint256 n, uint64 lo, uint64 stake) internal pure returns (SkechGame.Section[] memory s) {
        s = new SkechGame.Section[](n);
        for (uint256 i = 0; i < n; i++) {
            s[i] = section(uint8(first + i), lo, lo + (HI - LO), stake);
        }
    }

    function strokeOf(uint256 length) internal pure returns (bytes memory b) {
        b = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            b[i] = 0x11;
        }
    }

    function pieceOf(Player memory p, uint64 drawing, SkechGame.Section[] memory secs, bytes memory strokeBytes)
        internal
        view
        returns (SkechGame.Placement memory pl)
    {
        SkechGame.Piece memory pc = piece(drawing, 0, secs);
        pc.player = p.who;
        pc.strokeHash = keccak256(strokeBytes);
        pl.piece = pc;
        pl.sessionSig = signP256(p.p256, game.pieceDigest(pc));
        pl.priceSig = priceSig(pc.priceSeen, pc.priceTime);
        pl.stroke = strokeBytes;
    }

    function one(SkechGame.Placement memory pl) internal pure returns (SkechGame.Placement[] memory pls) {
        pls = new SkechGame.Placement[](1);
        pls[0] = pl;
    }

    /// @dev Place a batch, every band at `chance`; every piece must be taken.
    function placeAll(SkechGame.Placement[] memory pls, uint32 chance, string memory name)
        internal
        returns (uint256 exec)
    {
        uint256 bands;
        for (uint256 i = 0; i < pls.length; i++) {
            bands += pls[i].piece.sections.length;
        }
        uint32[] memory chances = new uint32[](bands);
        for (uint256 i = 0; i < bands; i++) {
            chances[i] = chance;
        }
        (SkechGame.Quote memory q, bytes memory sig) = quote(pls, pls[0].piece.openAt - 400, chances, 0);
        exec = measure(abi.encodeCall(SkechGame.place, (pls, q, sig)), name);
        for (uint256 i = 0; i < pls.length; i++) {
            require(game.betOf(betId(pls[i])).stake > 0, string.concat(name, ": a piece was refused"));
        }
    }

    function betId(SkechGame.Placement memory pl) internal view returns (bytes32) {
        return game.betIdOf(pl.piece.player, pl.piece.drawing, pl.piece.index);
    }

    /* ---- bars ---- */

    /// @dev Every bar covers LO..HI: a band there is hit, a band FAR off is missed; the close never moves.
    function barAt(uint64 second) internal returns (SkechGame.Bar memory b, bytes memory sig) {
        return bar(second, PRICE, HI, LO, PRICE);
    }

    function post(uint64 second) internal {
        (SkechGame.Bar memory b, bytes memory sig) = barAt(second);
        game.postBar(b, sig);
    }

    function postAndSettle(uint64 second, bytes32[] memory list, string memory name) internal returns (uint256) {
        (SkechGame.Bar memory b, bytes memory sig) = barAt(second);
        return measure(abi.encodeCall(SkechGame.postBarAndSettle, (b, sig, list)), name);
    }

    function settleAll(bytes32[] memory list, string memory name) internal returns (uint256) {
        return measure(abi.encodeCall(SkechGame.settle, (list)), name);
    }

    function ids(bytes32 a) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](1);
        out[0] = a;
    }

    function ids(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](2);
        out[0] = a;
        out[1] = b;
    }

    function ids(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](3);
        out[0] = a;
        out[1] = b;
        out[2] = c;
    }

    function none() internal pure returns (bytes32[] memory out) {
        out = new bytes32[](0);
    }

    /* ---- the transaction itself: proxy, dispatch, the paused check ---- */

    function test_transactionBase() public {
        uint256 base = settleAll(none(), "settle.txBase");
        // The proxy's cold account (10,100), the page its implementation slot is on and the page the paused flag is on
        // (8,100 each), and a little code: about 28,000. Far more would mean the 21,000 is being counted in the frame.
        assertLt(base, 40_000, "an empty settle costs too much: is the frame's gas execution only?");
        assertGt(base, 15_000);
        console.log("transaction base %d", base);
    }

    /* ---- place ---- */

    function test_place() public {
        Player memory a = newPlayer(100e6);
        Player memory b = newPlayer(100e6);
        Player memory c = newPlayer(100e6);
        Player memory d = newPlayer(100e6);
        bytes memory small = strokeOf(8);

        // A fresh game: the pool and the fees are both zero, so those two writes grow the state.
        assertEq(game.pool(), 0);
        assertEq(game.fees(), 0);
        uint256 cold = placeAll(one(pieceOf(a, 1, run(1, 1, LO, HALF_DOT), small)), EVEN, "place.1x1.cold");
        uint256 g11 = placeAll(one(pieceOf(a, 2, run(1, 1, LO, HALF_DOT), small)), EVEN, "place.1x1");
        uint256 g14 = placeAll(one(pieceOf(b, 1, run(1, 4, LO, HALF_DOT), small)), EVEN, "place.1x4");
        SkechGame.Placement[] memory four = new SkechGame.Placement[](4);
        four[0] = pieceOf(a, 3, run(1, 1, LO, HALF_DOT), small);
        four[1] = pieceOf(b, 2, run(1, 1, LO, HALF_DOT), small);
        four[2] = pieceOf(c, 1, run(1, 1, LO, HALF_DOT), small);
        four[3] = pieceOf(d, 1, run(1, 1, LO, HALF_DOT), small);
        uint256 g41 = placeAll(four, EVEN, "place.4x1");
        uint256 g1k = placeAll(one(pieceOf(c, 2, run(1, 1, LO, HALF_DOT), strokeOf(1000))), EVEN, "place.1x1.stroke1k");

        // The model: what one more piece, one more band, one more byte of stroke, one more cold slot costs.
        uint256 coldSlot = ceilDiv(cold - g11, 2);
        uint256 perSection = ceilDiv(g14 - g11, 3);
        uint256 perByte = ceilDiv(g1k - g11, 1000 - 8);
        uint256 perPiece = ceilDiv(g41 - g11 - 24 * perByte, 3) - perSection;
        uint256 base = g11 - perPiece - perSection - 8 * perByte;
        setCoef("place.base", base);
        setCoef("place.piece", perPiece);
        setCoef("place.section", perSection);
        setCoef("place.byte", perByte);
        setCoef("place.coldSlot", coldSlot);
        // A bet's words may straddle two pages on chain, and so may a session's.
        setCoef("place.pageSlack", PAGE_WRITE + PAGE_READ);
        console.log("place: base %d, piece %d, section %d", base, perPiece, perSection);
        console.log("place: byte %d, cold slot %d", perByte, coldSlot);

        // The fitted shapes come back exactly; then batches the coefficients were not fitted on.
        check("place.1x1.cold", cold, placeModel(1, 1, 8, 2));
        check("place.1x4", g14, placeModel(1, 4, 8, 0));
        check("place.4x1", g41, placeModel(4, 4, 32, 0));
        SkechGame.Placement[] memory mixed = new SkechGame.Placement[](3);
        mixed[0] = pieceOf(a, 4, run(1, 2, LO, HALF_DOT), small);
        mixed[1] = pieceOf(b, 3, run(1, 2, LO, HALF_DOT), strokeOf(300));
        mixed[2] = pieceOf(d, 2, run(1, 2, LO, HALF_DOT), strokeOf(2000));
        uint256 gMixed = placeAll(mixed, EVEN, "place.3x2.mixed");
        check("place.3x2.mixed", gMixed, placeModel(3, 6, 8 + 300 + 2000, 0));
        vm.snapshotValue(G, "check.place.3x2.mixed.strokeBytes", 8 + 300 + 2000);
        uint256 g18 = placeAll(one(pieceOf(c, 3, run(1, 8, LO, HALF_DOT), small)), EVEN, "place.1x8");
        check("place.1x8", g18, placeModel(1, 8, 8, 0));
        // The longest stroke the relayer takes is 24.6 KB: the slope measured at 1 KB has to hold far out.
        uint256 g12k =
            placeAll(one(pieceOf(d, 3, run(1, 1, LO, HALF_DOT), strokeOf(12_000))), EVEN, "place.1x1.stroke12k");
        check("place.1x1.stroke12k", g12k, placeModel(1, 1, 12_000, 0));
    }

    /// @dev The relayer's formula, without the page slack: the checks measure what was measured, in one page.
    function placeModel(uint256 pieces, uint256 sections, uint256 strokeBytes, uint256 coldSlots)
        internal
        view
        returns (uint256)
    {
        return coef("place.base") + pieces * coef("place.piece") + sections * coef("place.section") + strokeBytes
            * coef("place.byte") + coldSlots * coef("place.coldSlot");
    }

    /* ---- bars and settling ---- */

    mapping(string => bytes32) internal bet;
    mapping(string => Player) internal who;

    /// @dev Place one piece for `name`'s player, one band a second from `first`, and remember its bet.
    function placeFor(
        string memory name,
        uint64 drawing,
        uint8 first,
        uint256 n,
        uint64 lo,
        uint64 stake,
        uint32 chance
    ) internal {
        SkechGame.Placement memory pl = pieceOf(who[name], drawing, run(first, n, lo, stake), strokeOf(8));
        placeAll(one(pl), chance, string.concat("setup.", name));
        bet[name] = betId(pl);
    }

    function test_settle() public {
        uint256 txBase = settleAll(none(), "settle.txBase");
        coefs["settle.txBase"] = txBase;
        phaseOne();
        uint64 open1 = openAtNow();
        vm.warp(open1 / 1000 + 8);
        post(open1);
        // One bar, nothing to settle, the second before it on chain.
        uint256 gBar = postAndSettle(open1 + 1000, none(), "bar");
        post(open1 + 2000);
        // One bet with one live band, missed.
        uint256 gMiss = settleAll(ids(bet["a"]), "settle.miss1");
        // One bet with four live bands, one of them decided: three more words read, their bars not yet posted.
        uint256 gMissLive4 = settleAll(ids(bet["c"]), "settle.miss1.live4");
        // A hit paid in full, into an empty balance, the house's fee into empty fees.
        game.collectFees();
        assertEq(game.fees(), 0);
        uint256 gHitCold = settleAll(ids(bet["b"]), "settle.hit1.coldFees");
        assertGt(game.balanceOf(who["b"].who), 0);
        post(open1 + 3000);
        // A hit the pool cannot cover: it pays what it has, and the player and the house are each minted an IOU.
        uint256 gIou = settleAll(ids(bet["d"]), "settle.iou1");
        assertEq(game.pool(), 0);
        assertGt(iou.balanceOf(who["d"].who), 0);
        // With nothing in the pool at all: the player is not paid, only owed. Sets up the redeem below.
        settleAll(ids(bet["f"]), "setup.iouNoPay");
        assertEq(game.balanceOf(who["f"].who), 0);
        assertGt(iou.balanceOf(who["f"].who), 0);

        phaseTwo();
        uint64 open2 = openAtNow();
        vm.warp(open2 / 1000 + 8);
        post(open2);
        // Two of phase one's bars in one transaction, nothing to settle.
        uint256 gBars2 = postTwo(open1 + 4000, open1 + 5000, "bars2");
        post(open2 + 2000);
        // A hit into an empty balance with the fees already non-zero.
        assertGt(game.fees(), 0);
        uint256 gHit = settleAll(ids(bet["e"]), "settle.hit1");
        // One bet with three live bands, all three decided, missed: the extra bands cost a posted bar's page each.
        uint256 gMiss3 = settleAll(ids(bet["m3"]), "settle.miss3");

        // The model, everything over the bare transaction.
        setCoef("settle.bar", gBar - txBase);
        setCoef("settle.barExtra", gBars2 - gBar);
        setCoef("settle.bet", gMiss - txBase);
        setCoef("settle.live", ceilDiv(gMiss3 - gMiss, 2));
        setCoef("settle.hit", gHit - gMiss);
        setCoef("settle.coldFees", gHitCold - gHit);
        setCoef("settle.iou", gIou - gHit);
        // A bet's words may straddle two pages on chain: one more page read.
        setCoef("settle.pageSlack", PAGE_READ);
        console.log("settle: tx %d, bar %d, extra bar %d", txBase, coef("settle.bar"), coef("settle.barExtra"));
        console.log("settle: bet %d, live %d, hit %d", coef("settle.bet"), coef("settle.live"), coef("settle.hit"));
        console.log("settle: cold fees %d, iou %d", coef("settle.coldFees"), coef("settle.iou"));

        // The fitted shapes come back exactly; then batches the coefficients were not fitted on: c has three live
        // bands, two of them now decided; x hits; y misses.
        check("settle.hit1.coldFees", gHitCold, settleModel(0, 1, 0, 1, true, 0));
        check("settle.iou1", gIou, settleModel(0, 1, 0, 1, false, 1));
        check("settle.miss1.live4", gMissLive4, settleModel(0, 1, 3, 0, false, 0));
        check(
            "settle.mixed",
            settleAll(ids(bet["c"], bet["x"], bet["y"]), "settle.mixed"),
            settleModel(0, 3, 2, 1, false, 0)
        );
        post(open2 + 3000);
        // A bar with two bets on it: z hits; c2 has both bands live and both decided, missed.
        check(
            "bar.settle.mixed",
            postAndSettle(open2 + 4000, ids(bet["z"], bet["c2"]), "bar.settle.mixed"),
            settleModel(1, 2, 1, 1, false, 0)
        );
        redeems();
    }

    /// @dev Everyone draws on the same second. a and c miss; b, d and f hit, b at 1.5x, d and f at 8x, each with
    /// exactly their stake in the balance, so being paid writes a fresh slot. m3 misses three bands in a row.
    function phaseOne() internal {
        who["a"] = newPlayer(100e6);
        who["b"] = newPlayer(HALF_DOT);
        who["c"] = newPlayer(100e6);
        who["d"] = newPlayer(10 * PER_DOT);
        who["f"] = newPlayer(HALF_DOT);
        who["m3"] = who["c"];
        placeFor("m3", 3, 2, 3, LO + FAR, HALF_DOT, EVEN);
        placeFor("a", 1, 2, 1, LO + FAR, HALF_DOT, EVEN);
        SkechGame.Section[] memory cs = new SkechGame.Section[](4);
        cs[0] = section(2, LO + FAR, HI + FAR, HALF_DOT);
        cs[1] = section(4, LO + FAR, HI + FAR, HALF_DOT);
        cs[2] = section(5, LO + FAR, HI + FAR, HALF_DOT);
        cs[3] = section(6, LO + FAR, HI + FAR, HALF_DOT);
        SkechGame.Placement memory c = pieceOf(who["c"], 1, cs, strokeOf(8));
        placeAll(one(c), EVEN, "setup.c");
        bet["c"] = betId(c);
        placeFor("b", 1, 2, 1, LO, HALF_DOT, EVEN);
        placeFor("d", 1, 3, 1, LO, 10 * PER_DOT, LONG);
        placeFor("f", 1, 3, 1, LO, HALF_DOT, LONG);
        assertEq(game.balanceOf(who["b"].who), 0);
        assertEq(game.balanceOf(who["d"].who), 0);
        assertEq(game.balanceOf(who["f"].who), 0);
    }

    /// @dev Eight seconds on: a loses a dollar so the pool has money again, and more bets to check the model against.
    function phaseTwo() internal {
        who["e"] = newPlayer(HALF_DOT);
        who["x"] = newPlayer(100e6);
        who["y"] = newPlayer(100e6);
        who["l"] = who["a"];
        who["z"] = who["a"];
        who["c2"] = who["c"];
        placeFor("l", 2, 2, 1, LO + FAR, 10 * PER_DOT, EVEN);
        placeFor("e", 1, 2, 1, LO, HALF_DOT, EVEN);
        placeFor("x", 1, 2, 1, LO, HALF_DOT, EVEN);
        placeFor("y", 1, 2, 1, LO + FAR, HALF_DOT, EVEN);
        placeFor("z", 3, 4, 1, LO, HALF_DOT, EVEN);
        placeFor("c2", 2, 3, 2, LO + FAR, HALF_DOT, EVEN);
        assertGt(game.pool(), 500_000);
    }

    function postTwo(uint64 first, uint64 second, string memory name) internal returns (uint256) {
        SkechGame.Bar[] memory two = new SkechGame.Bar[](2);
        bytes[] memory sigs = new bytes[](2);
        (two[0], sigs[0]) = barAt(first);
        (two[1], sigs[1]) = barAt(second);
        return measure(abi.encodeCall(SkechGame.postBarsAndSettle, (two, sigs, none())), name);
    }

    /// @dev f's IOU in full, by a keeper paid a cut, into two empty balances; d's in part, the pool being short.
    function redeems() internal {
        address f = who["f"].who;
        address d = who["d"].who;
        vm.roll(vm.getBlockNumber() + 10_000);
        assertGt(iou.assetsOf(f), iou.basisOf(f) + 10);
        assertLt(iou.assetsOf(f), game.pool());
        vm.prank(keeper);
        uint256 full = measure(abi.encodeCall(SkechGame.redeem, (f, type(uint256).max)), "redeem.full");
        assertGt(game.balanceOf(keeper), 0);
        assertGt(iou.assetsOf(d), game.pool());
        vm.prank(keeper);
        uint256 part = measure(abi.encodeCall(SkechGame.redeem, (d, type(uint256).max)), "redeem.partial");
        assertGt(iou.balanceOf(d), 0);
        setCoef("redeem", full > part ? full : part);
        console.log("redeem: full %d, partial %d", full, part);
    }

    /// @dev The relayer's formula, without the page slack.
    function settleModel(uint256 bars, uint256 bets, uint256 extraLive, uint256 hits, bool coldFees, uint256 ious)
        internal
        view
        returns (uint256 gas)
    {
        gas = coef("settle.txBase");
        if (bars > 0) gas += coef("settle.bar") + (bars - 1) * coef("settle.barExtra");
        gas += bets * coef("settle.bet") + extraLive * coef("settle.live") + hits * coef("settle.hit") + ious
            * coef("settle.iou");
        if (coldFees && hits > 0) gas += coef("settle.coldFees");
    }

    /* ---- sessions ---- */

    function test_session() public {
        // A first session for a player: three fresh words and a P-256 key checked.
        uint256 key = 0xC0DE99;
        (uint256 x, uint256 y) = vm.publicKeyP256(0x7256999);
        address who = vm.addr(key);
        uint64 until = uint64(vm.getBlockTimestamp() + 1 days);
        uint256 deadline = vm.getBlockTimestamp() + 60;
        bytes32 digest = game.sessionDigest(who, 1, address(0), bytes32(x), bytes32(y), until, 100e6, deadline);
        uint256 fresh = measure(
            abi.encodeCall(
                SkechGame.registerSession,
                (who, 1, address(0), bytes32(x), bytes32(y), until, 100e6, deadline, sign(key, digest))
            ),
            "session.fresh"
        );
        // Renewed: the same words, written again.
        digest = game.sessionDigest(who, 1, address(0), bytes32(x), bytes32(y), until + 1, 100e6, deadline);
        uint256 again = measure(
            abi.encodeCall(
                SkechGame.registerSession,
                (who, 1, address(0), bytes32(x), bytes32(y), until + 1, 100e6, deadline, sign(key, digest))
            ),
            "session.renewed"
        );
        assertLt(again, fresh);
        // The session's three words may straddle two pages on chain.
        setCoef("session", fresh + PAGE_WRITE);
        console.log("session: fresh %d, renewed %d", fresh, again);
    }
}
