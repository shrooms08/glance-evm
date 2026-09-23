// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IStockRouter
/// @notice Swap venue between USDG and tokenized stocks. The caller must approve the input token beforehand.
interface IStockRouter {
    /// @notice Swaps exactly `usdgIn` USDG for `token`, sending the output to `to`.
    /// @param token The tokenized stock to buy.
    /// @param usdgIn Exact USDG amount pulled from the caller.
    /// @param minOut Minimum stock tokens the router must deliver.
    /// @param to Recipient of the stock tokens.
    /// @return out The amount of stock tokens delivered, as reported by the router.
    function swapUsdgForToken(address token, uint256 usdgIn, uint256 minOut, address to) external returns (uint256 out);

    /// @notice Swaps exactly `tokensIn` of `token` for USDG, sending the output to `to`.
    /// @param token The tokenized stock to sell.
    /// @param tokensIn Exact stock token amount pulled from the caller.
    /// @param minOut Minimum USDG the router must deliver.
    /// @param to Recipient of the USDG.
    /// @return out The amount of USDG delivered, as reported by the router.
    function swapTokenForUsdg(address token, uint256 tokensIn, uint256 minOut, address to)
        external
        returns (uint256 out);
}
