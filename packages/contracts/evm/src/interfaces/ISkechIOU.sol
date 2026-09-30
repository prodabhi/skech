// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice What the game needs of the IOU: to issue it for what it cannot pay, and to take it back when it can.
interface ISkechIOU is IERC20 {
    /// @notice Shares per USDC, x1e18, rising by a fixed amount every block.
    function index() external view returns (uint256);
    /// @notice What `shares` are worth now, in USDC (6 decimals).
    function valueOf(uint256 shares) external view returns (uint64);
    /// @notice The USDC `account` was owed when its shares were issued, moved pro rata with them.
    function basisOf(address account) external view returns (uint64);
    /// @notice What every share is worth now, in USDC: the game's whole IOU debt.
    function totalAssets() external view returns (uint64);
    /// @notice Issue shares worth `value` USDC now to `to`.
    function mint(address to, uint64 value) external returns (uint256 shares);
    /// @notice Take `shares` back from `from`: what they are worth now, and the basis they carried.
    function burn(address from, uint256 shares) external returns (uint64 value, uint64 basis);
}
