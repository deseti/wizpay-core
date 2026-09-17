import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ArcNetworkKey } from '@wizpay/arc-network';
import type { Hex } from 'viem';
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
  ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
  buildPermit2TypedData,
  buildUserControlledSwapPlan,
  encodePermit2PermitAndSwap,
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
      status: 'candidate-non-executable' as const,
      executable: false as const,
      chainId: 5_042,
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
      this.requireExternalWalletPermit(request, plan);
    }
    this.readiness.requireExecutable();
  }

  execute(request: MainnetUniswapV4PrepareRequest): never {
    this.assertMainnetProcess();
    this.readiness.validateBoundary(request);
    this.readiness.requireExecutable();
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
    const transactionData =
      request.permit2Signature !== undefined ||
      request.permit2Nonce !== undefined
        ? this.permit2SwapData(request, plan)
        : plan.swap.data;
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

  permit2TypedData(request: MainnetUniswapV4PrepareRequest, nonce: number) {
    this.assertMainnetProcess();
    const normalized = this.readiness.validateBoundary(request);
    if (!request.quoteResult) {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message: 'A successful pinned quote observation is required.',
      });
    }
    const plan = buildUserControlledSwapPlan(normalized, request.quoteResult);
    return buildPermit2TypedData({
      token: plan.quote.tokenIn,
      amount: plan.quote.amountIn,
      spender: ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
      nonce,
      deadline: normalized.deadline,
    });
  }

  private requireExternalWalletPermit(
    request: MainnetUniswapV4PrepareRequest,
    plan: MainnetUniswapV4SwapPlan,
  ): never {
    if (plan.permit2 === null) {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message: 'Permit2 signatures are not valid for native USDC input.',
      });
    }
    if (
      typeof request.permit2Nonce !== 'number' ||
      !Number.isInteger(request.permit2Nonce) ||
      request.permit2Nonce < 0 ||
      request.permit2Nonce > 2 ** 48 - 1 ||
      typeof request.permit2Signature !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(request.permit2Signature)
    ) {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message: 'Permit2 nonce and signature are invalid.',
      });
    }
    encodePermit2PermitAndSwap({
      quote: plan.quote,
      recipient: plan.recipient,
      deadline: plan.deadline,
      nonce: request.permit2Nonce,
      signature: request.permit2Signature as Hex,
    });
    this.readiness.requireExecutable();
  }

  private permit2SwapData(
    request: MainnetUniswapV4PrepareRequest,
    plan: MainnetUniswapV4SwapPlan,
  ): Hex {
    if (
      plan.permit2 === null ||
      typeof request.permit2Nonce !== 'number' ||
      !Number.isInteger(request.permit2Nonce) ||
      request.permit2Nonce < 0 ||
      request.permit2Nonce > 2 ** 48 - 1 ||
      typeof request.permit2Signature !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(request.permit2Signature)
    ) {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message: 'Permit2 nonce and signature are invalid.',
      });
    }
    return encodePermit2PermitAndSwap({
      quote: plan.quote,
      recipient: plan.recipient,
      deadline: plan.deadline,
      nonce: request.permit2Nonce,
      signature: request.permit2Signature as Hex,
    });
  }

  private assertMainnetProcess() {
    const network =
      this.config.get<BackendArcNetworkConfiguration>('arcNetwork');
    const key = (network?.key ?? process.env.WIZPAY_ARC_NETWORK) as
      | ArcNetworkKey
      | undefined;
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
