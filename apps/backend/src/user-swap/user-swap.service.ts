import { BadRequestException, Injectable } from '@nestjs/common';
import {
  USER_SWAP_ALLOWED_CHAIN,
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_ERROR_CODES,
  USER_SWAP_USDC_ADDRESS,
  type UserSwapNormalizedQuote,
  type UserSwapQuoteRequest,
  type UserSwapToken,
} from './user-swap.types';
import { MainnetUniswapV4Service } from './mainnet-uniswap-v4.service';
import { CapabilityService } from '../capabilities/capability.service';

const SUPPORTED_TOKENS = new Set<UserSwapToken>(['USDC', 'EURC']);

const TOKEN_ADDRESSES: Record<UserSwapToken, string> = {
  USDC: USER_SWAP_USDC_ADDRESS,
  EURC: USER_SWAP_EURC_ADDRESS,
};

/** Mainnet-only quote boundary for browser-signed External Wallet swaps. */
@Injectable()
export class UserSwapService {
  constructor(
    private readonly mainnetSwap: MainnetUniswapV4Service,
    private readonly capabilities: CapabilityService,
  ) {}

  async quote(request: UserSwapQuoteRequest): Promise<UserSwapNormalizedQuote> {
    this.capabilities.assert('swap');
    const normalized = this.normalize(request);
    // Live executable quote from the official Uniswap V4 Quoter on Arc
    // Mainnet. Inspection errors propagate so misconfigured requests and
    // unavailable liquidity fail closed. The live amounts below are what the
    // frontend renders; there is no static or 1:1 fallback.
    const live = await this.mainnetSwap.inspectQuote({
      chainId: 5_042,
      tokenInAddress: normalized.tokenInAddress,
      tokenOutAddress: normalized.tokenOutAddress,
      amountIn: normalized.amountIn,
      recipient: normalized.toAddress,
      walletAddress: normalized.fromAddress,
      walletControl: 'external-wallet',
      slippageBps: normalized.slippageBps,
      deadline: normalized.deadline,
    });
    return {
      ...normalized,
      provider: 'uniswap-v4',
      raw: {
        executable: live.executable,
        status: live.status,
        poolId: live.poolId,
        quoter: live.quoter,
        quote: live.quote,
        observation: live.observation,
        quotedAt: live.quotedAt,
        expiresAt: live.expiresAt,
        expiresAtBlock: live.expiresAtBlock,
        expectedAmountOut: live.quote.amountOut,
        minimumAmountOut: live.quote.minAmountOut,
        expectedOutput: live.quote.amountOut,
        minimumOutput: live.quote.minAmountOut,
      },
    };
  }

  private normalize(request: UserSwapQuoteRequest): Omit<
    UserSwapNormalizedQuote,
    'provider' | 'raw'
  > {
    if (request.chain !== USER_SWAP_ALLOWED_CHAIN) {
      this.invalid('Only ARC-MAINNET is supported.');
    }
    if (!SUPPORTED_TOKENS.has(request.tokenIn as UserSwapToken)) {
      this.invalid('tokenIn must be USDC or EURC.');
    }
    if (!SUPPORTED_TOKENS.has(request.tokenOut as UserSwapToken)) {
      this.invalid('tokenOut must be USDC or EURC.');
    }
    if (request.tokenIn === request.tokenOut) {
      this.invalid('tokenIn and tokenOut must be different.');
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(request.fromAddress)) {
      this.invalid('fromAddress must be a valid EVM address.');
    }
    const toAddress = request.toAddress ?? request.fromAddress;
    if (toAddress.toLowerCase() !== request.fromAddress.toLowerCase()) {
      this.invalid('toAddress must equal the connected wallet address.');
    }
    if (!/^[1-9]\d*$/.test(request.amountIn)) {
      this.invalid('amountIn must be a canonical positive integer string.');
    }
    const slippageBps = request.slippageBps ?? 50;
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500) {
      this.invalid('slippageBps must be an integer between 1 and 500.');
    }

    const tokenIn = request.tokenIn as UserSwapToken;
    const tokenOut = request.tokenOut as UserSwapToken;

    return {
      tokenIn,
      tokenOut,
      amountIn: request.amountIn,
      fromAddress: request.fromAddress,
      toAddress,
      chain: USER_SWAP_ALLOWED_CHAIN,
      slippageBps,
      deadline: Math.floor(Date.now() / 1_000) + 600,
      tokenInAddress: TOKEN_ADDRESSES[tokenIn],
      tokenOutAddress: TOKEN_ADDRESSES[tokenOut],
      recipientAddress: toAddress,
    };
  }

  private invalid(message: string): never {
    throw new BadRequestException({
      code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
      message,
    });
  }
}
