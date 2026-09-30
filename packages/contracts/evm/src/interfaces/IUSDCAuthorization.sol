// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice EIP-3009 on Circle's USDC (FiatToken v2.2): a signed transfer that only the payee may carry out.
/// @dev The `bytes signature` form, which also takes ERC-1271 signatures from contract wallets.
interface IUSDCAuthorization {
    /// @notice Move `value` from `from` to `to` on `from`'s signature. Reverts unless `msg.sender == to`, the time is
    /// after `validAfter` and before `validBefore`, and `nonce` has not been used by `from` before.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}
