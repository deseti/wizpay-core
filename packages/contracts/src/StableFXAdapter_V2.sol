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
    error ReciprocalInvariantViolation(uint256 rate, uint256 inverseRate, uint256 product);
    error RateDeviationExceeded(uint256 prevRate, uint256 newRate, uint256 deviation);
    error SolvencyConstraintViolation(uint256 remaining, uint256 minRequired);
    error WrongRedemptionToken(address expected, address requested);

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

    // Internal ledger state (replaces balanceOf for accounting decisions)
    mapping(address => uint256) public poolLedger;      // deposited principal per token
    mapping(address => uint256) public accruedFees;     // fee revenue per token
    mapping(address => address) public depositToken;    // each LP's deposit token

    // Accounting constants
    uint256 public constant RECIPROCAL_TOLERANCE = 0.01e18;   // 1% tolerance
    uint256 public constant MAX_RATE_DEVIATION_BPS = 1000;    // 10% max deviation
    uint256 public constant MIN_RESERVE_RATIO = 1000;         // 10% minimum reserve
    
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
    event RateSkippedInTVL(address indexed token);
    
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
     * @dev Uses internal ledger (poolLedger + accruedFees) instead of balanceOf().
     *      Skips tokens with expired/misconfigured rates rather than reverting.
     * @return totalValue Total pool value expressed in base-asset units.
     */
    function getTVL() public returns (uint256 totalValue) {
        for (uint256 i = 0; i < acceptedTokens.length; i++) {
            address token = acceptedTokens[i];
            uint256 ledgerBalance = poolLedger[token] + accruedFees[token];
            
            if (ledgerBalance > 0) {
                (bool success, uint256 converted) = _safeGetEstimatedAmount(token, baseAsset, ledgerBalance);
                if (success) {
                    totalValue += converted;
                } else {
                    emit RateSkippedInTVL(token);
                }
            }
        }
        return totalValue;
    }

    /**
     * @notice Safe wrapper for rate conversion that returns false instead of reverting.
     * @dev Uses try/catch on external self-call to isolate rate failures.
     * @param tokenIn Input token address.
     * @param tokenOut Output token address.
     * @param amountIn Amount to convert.
     * @return success Whether the conversion succeeded.
     * @return result The converted amount (0 if failed).
     */
    function _safeGetEstimatedAmount(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal view returns (bool success, uint256 result) {
        if (tokenIn == tokenOut) return (true, amountIn);
        
        try this.getExchangeRate(tokenIn, tokenOut) returns (uint256 rate) {
            uint256 tokenInDecimals = getTokenDecimals(tokenIn);
            uint256 tokenOutDecimals = getTokenDecimals(tokenOut);
            
            result = (amountIn * rate) / 1e18;
            
            if (tokenInDecimals > tokenOutDecimals) {
                result = result / (10 ** (tokenInDecimals - tokenOutDecimals));
            } else if (tokenOutDecimals > tokenInDecimals) {
                result = result * (10 ** (tokenOutDecimals - tokenInDecimals));
            }
            
            return (true, result);
        } catch {
            return (false, 0);
        }
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
        
        // 1. Capture TVL BEFORE updating poolLedger (ledger-based, immune to donations)
        uint256 tvlBefore = getTVL();
        
        // 2. Transfer tokens from user
        _transferTokenFrom(token, msg.sender, address(this), amount);
        
        // 3. Update internal ledger AFTER transfer but BEFORE minting shares
        poolLedger[token] += amount;
        
        // 4. Record deposit token for same-asset redemption enforcement
        depositToken[msg.sender] = token;
        
        // 5. Mint shares based on tvlBefore (formula unchanged)
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
     * @notice Burns LP shares and withdraws the LP's deposited token pro-rata.
     * @dev Uses single pro-rata calculation against poolLedger instead of double conversion.
     *      Enforces same-asset redemption: LP can only withdraw the token they deposited.
     *      Applies solvency check on non-full withdrawals to maintain minimum reserve.
     * @param targetToken Accepted token to withdraw (must match LP's deposit token).
     * @param shares LP shares to burn.
     */
    function removeLiquidity(address targetToken, uint256 shares) external nonReentrant {
        if (!isAcceptedToken[targetToken]) revert TokenNotAccepted(targetToken);

        uint256 userShares = balanceOf(msg.sender);
        if (shares == 0 || shares > userShares) {
            revert InsufficientShares(userShares, shares);
        }

        // Enforce same-asset redemption: LP must withdraw the token they deposited.
        // If depositToken is not set (address(0)), allow any accepted token for backward compatibility.
        address lpDepositToken = depositToken[msg.sender];
        if (lpDepositToken != address(0) && targetToken != lpDepositToken) {
            revert WrongRedemptionToken(lpDepositToken, targetToken);
        }

        // Single pro-rata calculation against internal ledger
        uint256 ledgerBalance = poolLedger[targetToken];
        uint256 amountOut = (shares * ledgerBalance) / totalSupply();

        // Solvency check for non-full withdrawals:
        // If this is not a full withdrawal of all shares, ensure the pool retains minimum reserve.
        bool isFullWithdrawal = (shares == userShares && userShares == totalSupply());
        if (!isFullWithdrawal && ledgerBalance > 0) {
            uint256 remaining = ledgerBalance - amountOut;
            uint256 minRequired = (ledgerBalance * MIN_RESERVE_RATIO) / 10000;
            if (remaining < minRequired) {
                revert SolvencyConstraintViolation(remaining, minRequired);
            }
        }

        // Verify sufficient actual token balance for transfer
        uint256 available = IERC20(targetToken).balanceOf(address(this));
        if (available < amountOut) {
            revert InsufficientPoolLiquidity(available, amountOut);
        }

        // Update internal ledger before external interactions
        poolLedger[targetToken] -= amountOut;

        _burn(msg.sender, shares);

        _transferToken(targetToken, msg.sender, amountOut);

        emit LiquidityRemoved(targetToken, amountOut, shares);
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
        
        // Rate bounds checking: enforce max deviation from previous rate
        uint256 prevRate = exchangeRates[tokenIn][tokenOut];
        if (prevRate != 0) {
            uint256 deviation;
            if (rate > prevRate) {
                deviation = ((rate - prevRate) * 10000) / prevRate;
            } else {
                deviation = ((prevRate - rate) * 10000) / prevRate;
            }
            if (deviation > MAX_RATE_DEVIATION_BPS) {
                revert RateDeviationExceeded(prevRate, rate, deviation);
            }
        }
        
        exchangeRates[tokenIn][tokenOut] = rate;
        rateTimestamps[tokenIn][tokenOut] = block.timestamp;
        
        // Enforce reciprocal rate invariant: rate_AB * rate_BA ≈ 1e18
        uint256 inverseRate = exchangeRates[tokenOut][tokenIn];
        if (inverseRate != 0) {
            uint256 product = (rate * inverseRate) / 1e18;
            if (product < (1e18 - RECIPROCAL_TOLERANCE) || product > (1e18 + RECIPROCAL_TOLERANCE)) {
                revert ReciprocalInvariantViolation(rate, inverseRate, product);
            }
        }
        
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
        
        // Base calculation (raw amount before fee)
        uint256 rawAmountOut = (amountIn * rate) / 1e18;
        
        // Adjust decimals
        if (tokenInDecimals > tokenOutDecimals) {
            rawAmountOut = rawAmountOut / (10 ** (tokenInDecimals - tokenOutDecimals));
        } else if (tokenOutDecimals > tokenInDecimals) {
            rawAmountOut = rawAmountOut * (10 ** (tokenOutDecimals - tokenInDecimals));
        }
        
        // Take LP Fee (Fee tracked separately in accruedFees)
        uint256 lpFee = (rawAmountOut * lpFeeBps) / 10000;
        amountOut = rawAmountOut - lpFee;

        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);
        
        uint256 availableLiquidity = IERC20(tokenOut).balanceOf(address(this));
        if (availableLiquidity < amountOut) {
            revert InsufficientPoolLiquidity(availableLiquidity, amountOut);
        }
        
        // Pull input first, then release output so the pool never transfers value it has not received.
        _transferTokenFrom(tokenIn, msg.sender, address(this), amountIn);
        
        _transferToken(tokenOut, to, amountOut);

        // Fee/principal separation: track inflow and outflow in internal ledger
        poolLedger[tokenIn] += amountIn;
        poolLedger[tokenOut] -= rawAmountOut;
        accruedFees[tokenOut] += lpFee;
        
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

    /**
     * @notice Allows the owner to claim accrued LP fees for a given token.
     * @dev Transfers the full accrued fee balance to the owner and resets the counter.
     * @param token Token address to claim fees for.
     */
    function claimFees(address token) external onlyOwner nonReentrant {
        if (token == address(0)) revert TokenZeroAddress();
        uint256 fees = accruedFees[token];
        if (fees == 0) revert AmountMustBeGreaterThanZero();

        accruedFees[token] = 0;
        _transferToken(token, owner(), fees);
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
