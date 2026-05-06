// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IFXEngine.sol";

/**
 * @title StableFXAdapter (SFX-LP)
 * @dev Decentralized Adapter contract bridging WizPay with cross-stablecoin liquidity
 * 
 * Features:
 * - Unified Liquidity Pool (ERC20 Token Vault model)
 * - Users earn fees by providing liquidity in exchange for SFX-LP tokens
 * - Automated 0.25% internal swap fee distributed to LP stakers
 * - Dynamic TVL pricing oracle
 */
contract StableFXAdapter_V2 is IFXEngine, ERC20, Ownable, ReentrancyGuard {
    error BaseAssetZeroAddress();
    error TokenZeroAddress();
    error TokenAlreadyTracked(address token);
    error TokenNotAccepted(address token);
    error AmountMustBeGreaterThanZero();
    error TokenTransferFailed(address token, address to, uint256 amount);
    error TokenTransferFromFailed(address token, address from, address to, uint256 amount);
    error TvlZero();
    error ZeroSharesMinted();
    error InsufficientShares(uint256 available, uint256 requested);
    error InvalidRate();
    error RateNotConfigured(address tokenIn, address tokenOut);
    error RateExpired(address tokenIn, address tokenOut, uint256 age, uint256 validity);
    error IdenticalTokens();
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error InsufficientPoolLiquidity(uint256 available, uint256 required);
    error FeeTooHigh(uint256 feeBps, uint256 maxFeeBps);
    error AcceptedPoolTokenWithdrawalForbidden(address token);
    error RecipientZeroAddress();

    // Exchange rate oracle (18 decimals: 1e18 = 1:1 rate)
    mapping(address => mapping(address => uint256)) public exchangeRates;
    
    // Rate validity period
    mapping(address => mapping(address => uint256)) public rateTimestamps;
    uint256 public constant RATE_VALIDITY = 31536000; // 1 year
    
    // Slippage tracking
    uint256 public slippageTolerance = 50; // 0.5%
    uint256 public constant MAX_SLIPPAGE = 500; // 5%

    // Liquidity Pool Mechanics
    uint256 public lpFeeBps = 25; // 0.25% fee distributed to LP pool
    address public baseAsset; // Base token used to calculate total TVL (e.g. USDC)
    
    address[] public acceptedTokens;
    mapping(address => bool) public isAcceptedToken;
    
    // Events
    event ExchangeRateUpdated(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 rate,
        uint256 timestamp
    );
    
    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 rate,
        uint256 lpFee
    );
    
    event LiquidityAdded(address indexed token, uint256 amountIn, uint256 sharesMinted);
    event LiquidityRemoved(address indexed token, uint256 amountOut, uint256 sharesBurned);
    event AcceptedTokenAdded(address indexed token);
    event LpFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event EmergencyWithdrawal(address indexed token, uint256 amount, address indexed to);
    
    /**
     * @notice Creates the StableFX liquidity adapter.
     * @param initialOwner Address that can manage rates, pool assets, and fees.
     * @param _baseAsset Token used as the pool's TVL accounting denomination.
     */
    constructor(address initialOwner, address _baseAsset) 
        ERC20("StableFX Liquidity Provider", "SFX-LP") 
        Ownable(initialOwner) 
    {
        if (_baseAsset == address(0)) revert BaseAssetZeroAddress();
        baseAsset = _baseAsset;
    }

    /**
     * @notice Returns the LP share decimals.
     * @dev SFX-LP decimals matches the base stablecoin (6 decimals).
     */
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @notice Adds a supported token to the liquidity pool registry.
     * @param token Token to track in pool TVL and swap accounting.
     */
    function addAcceptedToken(address token) external onlyOwner {
        if (token == address(0)) revert TokenZeroAddress();
        if (isAcceptedToken[token]) revert TokenAlreadyTracked(token);
        isAcceptedToken[token] = true;
        acceptedTokens.push(token);
        emit AcceptedTokenAdded(token);
    }

    /**
     * @notice Calculates total pool value normalized to the base asset.
     * @dev Every accepted token must have a valid conversion path into `baseAsset`.
     * @return totalValue Total pool value expressed in base-asset units.
     */
    function getTVL() public view returns (uint256 totalValue) {
        for (uint256 i = 0; i < acceptedTokens.length; i++) {
            address token = acceptedTokens[i];
            uint256 balance = IERC20(token).balanceOf(address(this));
            
            if (balance > 0) {
                totalValue += getEstimatedAmountInternal(token, baseAsset, balance);
            }
        }
        return totalValue;
    }

    /**
     * @notice Deposits accepted pool assets and mints proportional LP shares.
     * @dev Share issuance uses TVL before the deposit so incoming liquidity cannot self-inflate.
     * @param token Accepted token to deposit.
     * @param amount Token amount to deposit.
     */
    function addLiquidity(address token, uint256 amount) external nonReentrant {
        if (!isAcceptedToken[token]) revert TokenNotAccepted(token);
        if (amount == 0) revert AmountMustBeGreaterThanZero();
        
        uint256 tvlBefore = getTVL();
        
        _transferTokenFrom(token, msg.sender, address(this), amount);
        
        uint256 valueAdded = getEstimatedAmountInternal(token, baseAsset, amount);
        uint256 sharesToMint = 0;
        
        if (totalSupply() == 0) {
            sharesToMint = valueAdded; // Initialize 1:1 (assuming base asset decimals is compatible or 18)
        } else {
            if (tvlBefore == 0) revert TvlZero();
            sharesToMint = (valueAdded * totalSupply()) / tvlBefore;
        }
        
        if (sharesToMint == 0) revert ZeroSharesMinted();
        _mint(msg.sender, sharesToMint);
        
        emit LiquidityAdded(token, amount, sharesToMint);
    }

    /**
     * @notice Burns LP shares and withdraws a chosen accepted token.
     * @dev Burn happens before transfer to preserve checks-effects-interactions ordering.
     * @param targetToken Accepted token to withdraw.
     * @param shares LP shares to burn.
     */
    function removeLiquidity(address targetToken, uint256 shares) external nonReentrant {
        if (!isAcceptedToken[targetToken]) revert TokenNotAccepted(targetToken);

        uint256 userShares = balanceOf(msg.sender);
        if (shares == 0 || shares > userShares) {
            revert InsufficientShares(userShares, shares);
        }
        
        uint256 currentTvl = getTVL();
        // TVL value the shares represent
        uint256 valueToWithdraw = (shares * currentTvl) / totalSupply();
        
        // Convert the baseAsset-normalized value back to targetToken
        uint256 amountToWithdraw = getEstimatedAmountInternal(baseAsset, targetToken, valueToWithdraw);
        
        uint256 available = IERC20(targetToken).balanceOf(address(this));
        if (available < amountToWithdraw) {
            revert InsufficientPoolLiquidity(available, amountToWithdraw);
        }
        
        _burn(msg.sender, shares);
        
        _transferToken(targetToken, msg.sender, amountToWithdraw);
        
        emit LiquidityRemoved(targetToken, amountToWithdraw, shares);
    }

    /**
     * @notice Updates the quoted conversion rate for a token pair.
     * @param tokenIn Input token address.
     * @param tokenOut Output token address.
     * @param rate Oracle quote scaled to 18 decimals.
     */
    function setExchangeRate(
        address tokenIn,
        address tokenOut,
        uint256 rate
    ) external onlyOwner {
        if (tokenIn == address(0) || tokenOut == address(0)) revert TokenZeroAddress();
        if (rate == 0) revert InvalidRate();
        
        exchangeRates[tokenIn][tokenOut] = rate;
        rateTimestamps[tokenIn][tokenOut] = block.timestamp;
        
        emit ExchangeRateUpdated(tokenIn, tokenOut, rate, block.timestamp);
    }

    /**
     * @notice Returns the live exchange rate for a token pair.
     * @param tokenIn Input token address.
     * @param tokenOut Output token address.
     * @return rate Rate scaled to 18 decimals.
     */
    function getExchangeRate(
        address tokenIn,
        address tokenOut
    ) public view returns (uint256 rate) {
        if (tokenIn == tokenOut) {
            return 1e18; // 1:1
        }
        
        rate = exchangeRates[tokenIn][tokenOut];
        if (rate == 0) revert RateNotConfigured(tokenIn, tokenOut);
        
        uint256 rateAge = block.timestamp - rateTimestamps[tokenIn][tokenOut];
        if (rateAge > RATE_VALIDITY) {
            revert RateExpired(tokenIn, tokenOut, rateAge, RATE_VALIDITY);
        }
        
        return rate;
    }

    /**
     * @notice Executes an FX swap against pooled liquidity.
     * @dev Both assets must be accepted pool tokens so TVL accounting remains closed over tracked assets.
     * @param tokenIn Input token address.
     * @param tokenOut Output token address.
     * @param amountIn Input token amount.
     * @param minAmountOut Minimum acceptable output amount.
     * @param to Recipient of the output tokens.
     * @return amountOut Output amount delivered after LP fees.
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) external override nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0) revert AmountMustBeGreaterThanZero();
        if (tokenIn == tokenOut) revert IdenticalTokens();
        if (to == address(0)) revert RecipientZeroAddress();
        if (!isAcceptedToken[tokenIn]) revert TokenNotAccepted(tokenIn);
        if (!isAcceptedToken[tokenOut]) revert TokenNotAccepted(tokenOut);
        
        uint256 rate = getExchangeRate(tokenIn, tokenOut);
        
        uint256 tokenInDecimals = getTokenDecimals(tokenIn);
        uint256 tokenOutDecimals = getTokenDecimals(tokenOut);
        
        // Base calculation
        amountOut = (amountIn * rate) / 1e18;
        
        // Adjust decimals
        if (tokenInDecimals > tokenOutDecimals) {
            amountOut = amountOut / (10 ** (tokenInDecimals - tokenOutDecimals));
        } else if (tokenOutDecimals > tokenInDecimals) {
            amountOut = amountOut * (10 ** (tokenOutDecimals - tokenInDecimals));
        }
        
        // Take LP Fee (Fee stays in contract thereby increasing Pool TVL)
        uint256 lpFee = (amountOut * lpFeeBps) / 10000;
        amountOut = amountOut - lpFee;

        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);
        
        uint256 availableLiquidity = IERC20(tokenOut).balanceOf(address(this));
        if (availableLiquidity < amountOut) {
            revert InsufficientPoolLiquidity(availableLiquidity, amountOut);
        }
        
        // Pull input first, then release output so the pool never transfers value it has not received.
        _transferTokenFrom(tokenIn, msg.sender, address(this), amountIn);
        
        _transferToken(tokenOut, to, amountOut);
        
        emit SwapExecuted(tokenIn, tokenOut, amountIn, amountOut, rate, lpFee);
        return amountOut;
    }

    /**
     * @notice Estimates the swap output for a token pair.
     * @param tokenIn Input token address.
     * @param tokenOut Output token address.
     * @param amountIn Input token amount.
     * @return estimatedAmountOut Estimated output after LP fees.
     */
    function getEstimatedAmount(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view override returns (uint256 estimatedAmountOut) {
        uint256 baseExpected = getEstimatedAmountInternal(tokenIn, tokenOut, amountIn);
        // deduct LP fee for exact public estimate
        if (tokenIn != tokenOut) {
            uint256 lpFee = (baseExpected * lpFeeBps) / 10000;
            return baseExpected - lpFee;
        }
        return baseExpected;
    }

    // Internal helper without fee deduction used for TVL calculations
    function getEstimatedAmountInternal(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal view returns (uint256 estimatedAmountOut) {
        if (tokenIn == tokenOut) return amountIn;
        
        uint256 rate = getExchangeRate(tokenIn, tokenOut);
        
        uint256 tokenInDecimals = getTokenDecimals(tokenIn);
        uint256 tokenOutDecimals = getTokenDecimals(tokenOut);
        
        estimatedAmountOut = (amountIn * rate) / 1e18;
        
        if (tokenInDecimals > tokenOutDecimals) {
            estimatedAmountOut = estimatedAmountOut / (10 ** (tokenInDecimals - tokenOutDecimals));
        } else if (tokenOutDecimals > tokenInDecimals) {
            estimatedAmountOut = estimatedAmountOut * (10 ** (tokenOutDecimals - tokenInDecimals));
        }
        
        return estimatedAmountOut;
    }

    function getTokenDecimals(address token) internal view returns (uint256) {
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        if (success && data.length >= 32) {
            return abi.decode(data, (uint256));
        }
        return 6; // Default ARC stables
    }

    /**
     * @notice Updates the LP fee retained inside the pool.
     * @param newFeeBps New fee in basis points.
     */
    function updateLpFee(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > 500) revert FeeTooHigh(newFeeBps, 500);
        uint256 oldFeeBps = lpFeeBps;
        lpFeeBps = newFeeBps;
        emit LpFeeUpdated(oldFeeBps, newFeeBps);
    }

    /**
     * @notice Recovers non-pooled tokens that are accidentally sent to the adapter.
     * @param token Token address to recover.
     * @param amount Amount to recover.
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0)) revert TokenZeroAddress();
        if (amount == 0) revert AmountMustBeGreaterThanZero();
        if (isAcceptedToken[token]) revert AcceptedPoolTokenWithdrawalForbidden(token);

        _transferToken(token, owner(), amount);
        emit EmergencyWithdrawal(token, amount, owner());
    }

    function _transferToken(address token, address to, uint256 amount) internal {
        if (!IERC20(token).transfer(to, amount)) {
            revert TokenTransferFailed(token, to, amount);
        }
    }

    function _transferTokenFrom(address token, address from, address to, uint256 amount) internal {
        if (!IERC20(token).transferFrom(from, to, amount)) {
            revert TokenTransferFromFailed(token, from, to, amount);
        }
    }
}
