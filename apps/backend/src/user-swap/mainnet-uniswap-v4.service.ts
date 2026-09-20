import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ArcNetworkKey } from '@wizpay/arc-network';
import type { BackendArcNetworkConfiguration } from '../config/arc-network.config';
import {
  ARC_MAINNET_UNISWAP_V4_ERROR_CODES,
  MainnetUniswapV4ReadinessService,
  type MainnetUniswapV4BoundaryRequest,
} from './mainnet-uniswap-v4-readiness.service';
import {
  ARC_MAINNET_UNISWAP_V4_POOL_ID,
  ARC_MAINNET_UNISWAP_V4_POOL_KEY,
  ARC_MAINNET_UNISWAP_V4_QUOTER,
  WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
  buildUserControlledSwapPlan,
  encodeQuoteExactInputSingle,
  type MainnetUniswapV4QuoteObservation,
  type MainnetUniswapV4Receipt,
  type MainnetUniswapV4SwapPlan,
  verifySwapReceipt,
} from './mainnet-uniswap-v4-protocol';

export type MainnetUniswapV4QuoteRequest = MainnetUniswapV4BoundaryRequest &
  Readonly<{
    quoteResult?: MainnetUniswapV4QuoteObservation;
  }>;

export type MainnetUniswapV4PrepareRequest = MainnetUniswapV4BoundaryRequest &
  Readonly<{
    quoteResult?: MainnetUniswapV4QuoteObservation;
    permit2Nonce?: unknown;
    permit2Signature?: unknown;
  }>;

@Injectable()
export class MainnetUniswapV4Service {
  constructor(
    private readonly readiness: MainnetUniswapV4ReadinessService,
    private readonly config: ConfigService,
  ) {}

  inspectQuote(request: MainnetUniswapV4QuoteRequest) {
    this.assertMainnetProcess();
    const normalized = this.readiness.validateBoundary(request);
    const quoterCalldata = encodeQuoteExactInputSingle({
      tokenIn: normalized.tokenInAddress,
      tokenOut: normalized.tokenOutAddress,
      amountIn: normalized.amountIn,
    });
    const validated = request.quoteResult
      ? buildUserControlledSwapPlan(normalized, request.quoteResult).quote
      : undefined;
    return Object.freeze({
      status: 'executor-prepared' as const,
      executable: false as const,
      chainId: 5_042,
      executor: WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
      poolKey: ARC_MAINNET_UNISWAP_V4_POOL_KEY,
      poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
      quoter: Object.freeze({
        to: ARC_MAINNET_UNISWAP_V4_QUOTER,
        data: quoterCalldata,
        value: '0',
      }),
      quote: validated
        ? Object.freeze({
            zeroForOne: validated.zeroForOne,
            tokenIn: validated.tokenIn,
            tokenOut: validated.tokenOut,
            amountIn: validated.amountIn.toString(),
            amountOut: validated.amountOut.toString(),
            gasEstimate: validated.gasEstimate.toString(),
            minAmountOut: validated.minAmountOut.toString(),
            minHopPriceX36: validated.minHopPriceX36.toString(),
            slippageBps: validated.slippageBps,
            poolId: validated.poolId,
          })
        : undefined,
      walletControl: normalized.walletControl,
      poolIdentityStatus: 'candidate-unverified' as const,
      blockers: this.readiness.readiness.blockers,
    });
  }

  prepare(request: MainnetUniswapV4PrepareRequest): MainnetUniswapV4SwapPlan {
    this.assertMainnetProcess();
    const normalized = this.readiness.validateBoundary(request);
    if (!request.quoteResult) {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message: 'A successful pinned quote observation is required.',
      });
    }
    const plan = buildUserControlledSwapPlan(normalized, request.quoteResult);
    if (
      request.permit2Signature !== undefined ||
      request.permit2Nonce !== undefined
    ) {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message:
          'Permit2 signatures are not used for Arc Mainnet Swap Executor execution.',
      });
    }
    return plan;
  }

  execute(request: MainnetUniswapV4PrepareRequest): never {
    this.assertMainnetProcess();
    this.readiness.validateBoundary(request);
    throw new ServiceUnavailableException({
      code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.UNAVAILABLE,
      message:
        'Arc Mainnet swaps are signed by the external wallet against WizPaySwapExecutorMainnet. The backend does not custody or submit user funds.',
    });
  }

  verifyReceipt(
    receipt: MainnetUniswapV4Receipt,
    request: MainnetUniswapV4PrepareRequest,
  ) {
    this.assertMainnetProcess();
    const normalized = this.readiness.validateBoundary(request);
    if (!request.quoteResult) {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message: 'A successful pinned quote observation is required.',
      });
    }
    const plan = buildUserControlledSwapPlan(normalized, request.quoteResult);
    if (
      request.permit2Signature !== undefined ||
      request.permit2Nonce !== undefined
    ) {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message:
          'Permit2 signatures are not used for Arc Mainnet Swap Executor execution.',
      });
    }
    const transactionData = plan.swap.data;
    const verified = verifySwapReceipt(receipt, {
      walletAddress: normalized.walletAddress,
      recipient: normalized.recipient,
      tokenIn: plan.quote.tokenIn,
      tokenOut: plan.quote.tokenOut,
      amountIn: plan.quote.amountIn,
      minAmountOut: plan.quote.minAmountOut,
      transactionData,
      transactionValue: plan.swap.value,
      zeroForOne: plan.quote.zeroForOne,
    });
    return Object.freeze({
      amountOut: verified.amountOut.toString(),
      tokenInSpent: verified.tokenInSpent.toString(),
    });
  }

  private assertMainnetProcess() {
    const network =
      this.config.get<BackendArcNetworkConfiguration>('arcNetwork');
    const key = (network?.key ?? process.env.WIZPAY_ARC_NETWORK) as
      ArcNetworkKey | undefined;
    if (key !== 'arc-mainnet') {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message: 'Uniswap V4 USDC/EURC is isolated to Arc Mainnet.',
      });
    }
    if (this.readiness.readiness.executable !== false) {
      throw new ServiceUnavailableException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.UNAVAILABLE,
        message: 'Arc Mainnet Uniswap V4 execution is not authorized.',
      });
    }
  }
}
