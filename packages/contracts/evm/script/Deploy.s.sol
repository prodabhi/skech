// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SkechGame} from "../src/SkechGame.sol";
import {SkechIOU} from "../src/SkechIOU.sol";
import {SkechRevenue} from "../src/SkechRevenue.sol";
import {ISkechIOU} from "../src/interfaces/ISkechIOU.sol";

/// The three contracts behind ERC-1967 proxies (UUPS), wired together.
///
///   ORACLE_ADDRESS=<engine signer> forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast --private-key <deployer>
///
/// Or `bun run deploy:contracts` from the repo root, which fills all of this in from .env.local and hands the
/// deployer's key over as SKECH_DEPLOY_KEY, in the environment, where `ps` does not show it. Without
/// --broadcast it is a dry run: gas and addresses are printed, nothing is sent and deployments/ is left alone.
///
/// The deployer is the admin of everything. ORACLE_ADDRESS: the engine's wallet (its `hello.signer`); the same
/// key as the deployer is fine on testnet. USDC: Circle's on Monad testnet unless set. IOU_RATE: how much an IOU
/// grows per block, x1e18 (3.5e9 is about 0.1% a day at 300 ms blocks). DIFFICULTY: 50 to 100, 51 unless set.
/// Writes `deployments/<chainId>.json`, which the relayer and the app read.
contract Deploy is Script {
    function run() external {
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        address usdc = vm.envOr("USDC", address(0x534b2f3A21130d7a60830c2Df862319e593943A3));
        uint256 rate = vm.envOr("IOU_RATE", uint256(3_500_000_000));
        uint8 difficulty = uint8(vm.envOr("DIFFICULTY", uint256(51)));

        uint256 key = vm.envOr("SKECH_DEPLOY_KEY", uint256(0));
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        // Broadcasting with a key of its own, the script's msg.sender is still forge's default sender, not the key's.
        address admin = key != 0 ? vm.addr(key) : msg.sender;
        SkechRevenue revenue = SkechRevenue(
            payable(address(
                    new ERC1967Proxy(address(new SkechRevenue()), abi.encodeCall(SkechRevenue.initialize, (admin)))
                ))
        );
        SkechIOU iou = SkechIOU(
            address(
                new ERC1967Proxy(address(new SkechIOU()), abi.encodeCall(SkechIOU.initialize, (admin, admin, rate)))
            )
        );
        SkechGame game = SkechGame(
            address(
                new ERC1967Proxy(
                    address(new SkechGame()),
                    abi.encodeCall(
                        SkechGame.initialize, (admin, oracle, IERC20(usdc), ISkechIOU(address(iou)), address(revenue))
                    )
                )
            )
        );
        // Only the game issues and takes back IOUs.
        iou.grantRole(iou.MINTER_ROLE(), address(game));
        iou.revokeRole(iou.MINTER_ROLE(), admin);
        if (difficulty != 51) game.setDifficulty(0, difficulty);
        vm.stopBroadcast();

        console.log("chain", block.chainid);
        console.log("SkechGame   ", address(game));
        console.log("SkechIOU    ", address(iou));
        console.log("SkechRevenue", address(revenue));
        console.log("USDC        ", usdc);
        console.log("oracle      ", oracle);
        console.log("admin       ", admin);

        // A dry run reaches here too: the file must only ever name contracts that exist.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) && !vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            console.log("dry run: nothing sent, deployments/ not written");
            return;
        }
        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "game", address(game));
        vm.serializeAddress(json, "iou", address(iou));
        vm.serializeAddress(json, "revenue", address(revenue));
        vm.serializeAddress(json, "usdc", usdc);
        vm.serializeAddress(json, "oracle", oracle);
        string memory out = vm.serializeAddress(json, "admin", admin);
        vm.writeJson(out, string.concat("../deployments/", vm.toString(block.chainid), ".json"));
    }
}

/// Upgrade one proxy to a fresh implementation of the same contract.
///
///   PROXY=<address> WHICH=game|iou|revenue forge script script/Deploy.s.sol:Upgrade --rpc-url monad_testnet --broadcast --private-key <upgrader>
///
/// The game's upgrade from version 1 also sets what it already owes in IOU, which version 1 kept no count of:
/// OWED, the sum of `SkechIOU.basisOf` over every holder (every address in the IOU's Transfer events), in USDC e6.
/// It goes in the same transaction as the upgrade (`initializeV2`), and only once.
///
/// The new implementation must keep every stored field where the live one has it: run `bun run test:check` from
/// packages/contracts first, which fails if the storage layout moved from `snapshots/StorageLayout.json`
/// (`evm/layout.ts`). A script cannot read the compiler's layout itself without FFI, so the check lives there.
contract Upgrade is Script {
    function run() external {
        address proxy = vm.envAddress("PROXY");
        string memory which = vm.envString("WHICH");
        vm.startBroadcast();
        address impl;
        if (keccak256(bytes(which)) == keccak256("game")) impl = address(new SkechGame());
        else if (keccak256(bytes(which)) == keccak256("iou")) impl = address(new SkechIOU());
        else if (keccak256(bytes(which)) == keccak256("revenue")) impl = address(new SkechRevenue());
        else revert("WHICH must be game, iou or revenue");
        bytes memory init =
            keccak256(bytes(which)) == keccak256("game") ? abi.encodeCall(SkechGame.initializeV2, (uint64(vm.envUint("OWED")))) : bytes("");
        UUPSUpgradeable(proxy).upgradeToAndCall(impl, init);
        vm.stopBroadcast();
        console.log(which, "proxy", proxy, "now runs");
        console.log(impl);
    }
}
