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
    mapping(address => mapping(address => uint256)) public exchangeRates;
    bool public slippageFailure;

    function setExchangeRate(address tokenIn, address tokenOut, uint256 rate) external {
        exchangeRates[tokenIn][tokenOut] = rate;
    }

    function setSlippageFailure(bool enabled) external {
        slippageFailure = enabled;
    }

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

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) external override returns (uint256 amountOut) {
        uint256 quotedAmountOut = getEstimatedAmount(tokenIn, tokenOut, amountIn);
        require(quotedAmountOut > 0, "MockFXEngine: exchange rate not configured");

        amountOut = slippageFailure ? quotedAmountOut / 2 : quotedAmountOut;
        require(amountOut >= minAmountOut, "MockFXEngine: slippage tolerance exceeded");

        require(
            IERC20MetadataLike(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "MockFXEngine: transfer in failed"
        );

        require(
            IERC20MetadataLike(tokenOut).balanceOf(address(this)) >= amountOut,
            "MockFXEngine: insufficient liquidity"
        );
        require(
            IERC20MetadataLike(tokenOut).transfer(to, amountOut),
            "MockFXEngine: transfer out failed"
        );
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
