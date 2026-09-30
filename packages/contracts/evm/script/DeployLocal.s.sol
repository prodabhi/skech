// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SkechGame} from "../src/SkechGame.sol";
import {SkechIOU} from "../src/SkechIOU.sol";
import {SkechRevenue} from "../src/SkechRevenue.sol";
import {ISkechIOU} from "../src/interfaces/ISkechIOU.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// The game on a local chain, with a USDC of its own and a funded player: for the end-to-end run.
///
///   ORACLE_ADDRESS=<engine signer> PLAYER=<address> forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <deployer>
contract DeployLocal is Script {
    function run() external {
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        address player = vm.envAddress("PLAYER");
        vm.startBroadcast();
        address admin = msg.sender;
        MockUSDC usdc = new MockUSDC();
        usdc.mint(player, 10_000e6);
        SkechRevenue revenue = SkechRevenue(
            payable(address(new ERC1967Proxy(address(new SkechRevenue()), abi.encodeCall(SkechRevenue.initialize, (admin)))))
        );
        SkechIOU iou = SkechIOU(
            address(new ERC1967Proxy(address(new SkechIOU()), abi.encodeCall(SkechIOU.initialize, (admin, admin, 3_500_000_000))))
        );
        SkechGame game = SkechGame(
            address(
                new ERC1967Proxy(
                    address(new SkechGame()),
                    abi.encodeCall(SkechGame.initialize, (admin, oracle, IERC20(address(usdc)), ISkechIOU(address(iou)), address(revenue)))
                )
            )
        );
        iou.grantRole(iou.MINTER_ROLE(), address(game));
        iou.revokeRole(iou.MINTER_ROLE(), admin);
        vm.stopBroadcast();
        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "game", address(game));
        vm.serializeAddress(json, "iou", address(iou));
        vm.serializeAddress(json, "revenue", address(revenue));
        vm.serializeAddress(json, "usdc", address(usdc));
        vm.serializeAddress(json, "oracle", oracle);
        string memory out = vm.serializeAddress(json, "admin", admin);
        vm.writeJson(out, string.concat("../deployments/", vm.toString(block.chainid), ".json"));
        console.log("SkechGame", address(game));
        console.log("USDC", address(usdc));
    }
}
