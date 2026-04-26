// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IFXEngine
 * @dev Interface for the ARC native Foreign Exchange Engine
 * Provides atomic, low-latency stablecoin swaps on the ARC blockchain
 */
interface IFXEngine {
    /**
     * @dev Executes an atomic swap between two stablecoins
     * @param tokenIn The address of the input stablecoin (e.g., EURC)
     * @param tokenOut The address of the output stablecoin (e.g., USDC)
     * @param amountIn The amount of input tokens to swap
     * @param minAmountOut The minimum acceptable output amount (slippage protection)
     * @param to The address that will receive the output tokens
     * @return amountOut The actual amount of output tokens received
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) external returns (uint256 amountOut);

    /**
     * @dev Estimates the output amount for a given input amount
     * @param tokenIn The address of the input stablecoin
     * @param tokenOut The address of the output stablecoin
     * @param amountIn The amount of input tokens
     * @return estimatedAmountOut The estimated amount of output tokens
     */
    function getEstimatedAmount(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256 estimatedAmountOut);
}
