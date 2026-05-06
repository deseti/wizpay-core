// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFXEngine} from "../IFXEngine.sol";

interface IERC20MetadataLike {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

contract MockFXEngine is IFXEngine {
    error ExchangeRateNotConfigured();
    error SlippageToleranceExceeded();
    error TransferInFailed();
    error InsufficientLiquidity();
    error TransferOutFailed();

    mapping(address => mapping(address => uint256)) public exchangeRates;
    bool public slippageFailure;

    /**
     * @notice Sets a mock exchange rate for a token pair.
     * @param tokenIn Input token address.
     * @param tokenOut Output token address.
     * @param rate Quote scaled to 18 decimals.
     */
    function setExchangeRate(address tokenIn, address tokenOut, uint256 rate) external {
        exchangeRates[tokenIn][tokenOut] = rate;
    }

    /**
     * @notice Forces quoted swaps to fail slippage checks when enabled.
     * @param enabled True to force failing output quotes.
     */
    function setSlippageFailure(bool enabled) external {
        slippageFailure = enabled;
    }

    /**
     * @notice Estimates output for the configured mock rate table.
     * @param tokenIn Input token address.
     * @param tokenOut Output token address.
     * @param amountIn Input token amount.
     * @return estimatedAmountOut Estimated token output.
     */
    function getEstimatedAmount(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) public view override returns (uint256 estimatedAmountOut) {
        if (tokenIn == tokenOut) {
            return amountIn;
        }

        uint256 rate = exchangeRates[tokenIn][tokenOut];
        if (rate == 0) {
            return 0;
        }

        estimatedAmountOut = (amountIn * rate) / 1e18;
        return _scaleAmount(tokenIn, tokenOut, estimatedAmountOut);
    }

    /**
     * @notice Executes a mock swap using the configured exchange rate table.
     * @param tokenIn Input token address.
     * @param tokenOut Output token address.
     * @param amountIn Input token amount.
     * @param minAmountOut Minimum acceptable output amount.
     * @param to Recipient of the output tokens.
     * @return amountOut Actual output amount.
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) external override returns (uint256 amountOut) {
        uint256 quotedAmountOut = getEstimatedAmount(tokenIn, tokenOut, amountIn);
        if (quotedAmountOut == 0) revert ExchangeRateNotConfigured();

        amountOut = slippageFailure ? quotedAmountOut / 2 : quotedAmountOut;
        if (amountOut < minAmountOut) revert SlippageToleranceExceeded();

        if (!IERC20MetadataLike(tokenIn).transferFrom(msg.sender, address(this), amountIn)) {
            revert TransferInFailed();
        }

        if (IERC20MetadataLike(tokenOut).balanceOf(address(this)) < amountOut) {
            revert InsufficientLiquidity();
        }

        if (!IERC20MetadataLike(tokenOut).transfer(to, amountOut)) {
            revert TransferOutFailed();
        }
    }

    function _scaleAmount(
        address tokenIn,
        address tokenOut,
        uint256 amount
    ) internal view returns (uint256) {
        uint8 tokenInDecimals = IERC20MetadataLike(tokenIn).decimals();
        uint8 tokenOutDecimals = IERC20MetadataLike(tokenOut).decimals();

        if (tokenInDecimals > tokenOutDecimals) {
            return amount / (10 ** (tokenInDecimals - tokenOutDecimals));
        }

        if (tokenOutDecimals > tokenInDecimals) {
            return amount * (10 ** (tokenOutDecimals - tokenInDecimals));
        }

        return amount;
    }
}
