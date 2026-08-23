import { BadRequestException, Injectable } from '@nestjs/common';
import {
  USER_SWAP_ALLOWED_CHAIN,
  USER_SWAP_ERROR_CODES,
  type UserSwapNormalizedQuote,
  type UserSwapQuoteRequest,
  type UserSwapToken,
} from './user-swap.types';
import { XylonetQuoteProviderService } from './xylonet-quote-provider.service';

export const USER_SWAP_USDC_ADDRESS =
  '0x3600000000000000000000000000000000000000' as const;
export const USER_SWAP_EURC_ADDRESS =
  '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' as const;

const SUPPORTED_TOKENS = new Set<UserSwapToken>(['USDC', 'EURC']);

/** XyloNet-only quote boundary for browser-signed External Wallet swaps. */
@Injectable()
export class UserSwapService {
  constructor(
    private readonly xylonetQuoteProvider: XylonetQuoteProviderService,
  ) {}

  async quote(request: UserSwapQuoteRequest): Promise<UserSwapNormalizedQuote> {
    const normalized = this.normalize(request);
    return this.xylonetQuoteProvider.quote(normalized);
  }

  private normalize(request: UserSwapQuoteRequest) {
    if (request.chain !== USER_SWAP_ALLOWED_CHAIN) {
      this.invalid('Only ARC-TESTNET is supported.');
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

    return {
      tokenIn: request.tokenIn as UserSwapToken,
      tokenOut: request.tokenOut as UserSwapToken,
      amountIn: request.amountIn,
      fromAddress: request.fromAddress,
      toAddress,
      chain: USER_SWAP_ALLOWED_CHAIN,
      slippageBps: request.slippageBps,
    };
  }

  private invalid(message: string): never {
    throw new BadRequestException({
      code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
      message,
    });
  }
}
