import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress, isAddress, isAddressEqual, zeroAddress } from 'viem';
import { createPublicClient, http, type Hash } from 'viem';
import { type ArcNetworkKey } from '@wizpay/arc-network';
import type { BackendArcNetworkConfiguration } from '../config/arc-network.config';
import {
  ARC_MAINNET_UNISWAP_V4_ERROR_CODES,
  MainnetUniswapV4ReadinessService,
  type MainnetUniswapV4BoundaryRequest,
} from './mainnet-uniswap-v4-readiness.service';
import {
  MainnetUniswapV4QuoteService,
  QUOTE_EXPIRY_SECONDS,
} from './mainnet-uniswap-v4-quote.service';
import {
  ARC_MAINNET_UNISWAP_V4_POOL_ID,
  ARC_MAINNET_UNISWAP_V4_POOL_KEY,
  ARC_MAINNET_UNISWAP_V4_QUOTER,
  ARC_MAINNET_UNISWAP_V4_USDC,
  WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
  buildUserControlledSwapPlan,
  decodeExecuteSwap,
  encodeQuoteExactInputSingle,
  type MainnetUniswapV4QuoteObservation,
  type MainnetUniswapV4Receipt,
  type MainnetUniswapV4SwapPlan,
  verifySwapReceipt,
} from './mainnet-uniswap-v4-protocol';

const OFFICIAL_PAIR_TOKENS = [
  '0x3600000000000000000000000000000000000000',
  '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
] as const;

function isOfficialPairToken(address: `0x${string}`): boolean {
  return OFFICIAL_PAIR_TOKENS.some((token) =>
    isAddressEqual(address, token as `0x${string}`),
  );
}

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

export type MainnetUniswapV4PayrollQuoteRequest = Readonly<{
  tokenInAddress: unknown;
  tokenOutAddress: unknown;
  outputTotals: unknown;
  slippageBps: unknown;
  walletAddress: unknown;
  recipient: unknown;
}>;

export type MainnetUniswapV4PayrollQuote = Readonly<{
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  obligations: string;
  grossInput: string;
  feeAmount: string;
  netAmountIn: string;
  minTotalOut: string;
  minHopPriceX36: string;
  slippageBps: number;
  payrollFeeBps: string;
  quoteBlock: number;
  quotedAt: string;
  expiresAt: string;
  expiresAtBlock: number;
}>;

@Injectable()
export class MainnetUniswapV4Service {
  private readonly receiptClient;

  constructor(
    private readonly readiness: MainnetUniswapV4ReadinessService,
    private readonly quotes: MainnetUniswapV4QuoteService,
    private readonly config: ConfigService,
  ) {
    const network = this.config.getOrThrow<BackendArcNetworkConfiguration>('arcNetwork');
    this.receiptClient = createPublicClient({
      chain: {
        id: network.chainId,
        name: network.key,
        nativeCurrency: { decimals: 18, name: 'USDC', symbol: 'USDC' },
        rpcUrls: { default: { http: [network.rpcUrl] } },
      },
      transport: http(network.rpcUrl, { retryCount: 1, timeout: 10_000 }),
    });
  }

  /**
   * Live executable readiness: Arc Mainnet process isolation plus live
   * two-RPC quorum over pool/executor state. No quoter call. Used by the
   * readiness endpoint and as the single authoritative gate.
   */
  async liveReadiness(): Promise<
    Readonly<{
      available: boolean;
      executable: boolean;
      poolIdentityStatus: 'verified-live';
      blockers: readonly string[];
    }>
  > {
    this.assertMainnetProcess();
    await this.quotes.assertLiveStaticQuorum();
    return Object.freeze({
      available: true as const,
      executable: true as const,
      poolIdentityStatus: 'verified-live' as const,
      blockers: Object.freeze([]) as readonly string[],
    });
  }

  async inspectQuote(request: MainnetUniswapV4QuoteRequest) {
    this.assertMainnetProcess();
    const normalized = this.readiness.validateBoundary(request);
    const live = await this.quotes.liveQuote(normalized);
    const validated = live.validated;
    return Object.freeze({
      status: 'live' as const,
      executable: true as const,
      chainId: 5_042,
      executor: WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
      poolKey: ARC_MAINNET_UNISWAP_V4_POOL_KEY,
      poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
      quoter: Object.freeze({
        to: ARC_MAINNET_UNISWAP_V4_QUOTER,
        data: encodeQuoteExactInputSingle({
          tokenIn: normalized.tokenInAddress,
          tokenOut: normalized.tokenOutAddress,
          amountIn: normalized.amountIn,
        }),
        value: '0',
      }),
      quote: Object.freeze({
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
      }),
      observation: live.observation,
      quotedAt: live.quotedAt,
      expiresAt: live.expiresAt,
      expiresAtBlock: live.expiresAtBlock,
      quoteExpirySeconds: QUOTE_EXPIRY_SECONDS,
      walletControl: normalized.walletControl,
      poolIdentityStatus: 'verified-live' as const,
      blockers: Object.freeze([]) as readonly string[],
    });
  }

  async prepare(request: MainnetUniswapV4PrepareRequest): Promise<Record<string, unknown>> {
    this.assertMainnetProcess();
    const normalized = this.readiness.validateBoundary(request);
    if (!request.quoteResult) {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message: 'A successful pinned quote observation is required.',
      });
    }
    await this.quotes.assertQuoteFresh(request.quoteResult);
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
    // Serialize bigints as canonical decimal strings: raw JSON cannot
    // transport bigint. The wallet signs these exact values.
    return {
      walletControl: plan.walletControl,
      chainId: plan.chainId,
      poolKey: plan.poolKey,
      poolId: plan.poolId,
      quote: {
        zeroForOne: plan.quote.zeroForOne,
        tokenIn: plan.quote.tokenIn,
        tokenOut: plan.quote.tokenOut,
        amountIn: plan.quote.amountIn.toString(),
        amountOut: plan.quote.amountOut.toString(),
        gasEstimate: plan.quote.gasEstimate.toString(),
        minAmountOut: plan.quote.minAmountOut.toString(),
        minHopPriceX36: plan.quote.minHopPriceX36.toString(),
        slippageBps: plan.quote.slippageBps,
        poolId: plan.quote.poolId,
      },
      approvals: plan.approvals.map((approval) => ({
        to: approval.to,
        data: approval.data,
        value: approval.value.toString(),
        description: approval.description,
      })),
      swap: {
        to: plan.swap.to,
        data: plan.swap.data,
        value: plan.swap.value.toString(),
        description: plan.swap.description,
      },
      permit2: plan.permit2,
      recipient: plan.recipient,
      deadline: plan.deadline,
      executable: plan.executable,
    };
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

  async verifyReceipt(
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
    await this.quotes.assertQuoteFresh(request.quoteResult);
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

  async confirmTransaction(transactionHash: string, authenticatedWallet: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash) || !isAddress(authenticatedWallet)) {
      throw new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message: 'A valid Arc Mainnet swap transaction hash is required.',
      });
    }
    const network = this.config.getOrThrow<BackendArcNetworkConfiguration>('arcNetwork');
    const client = this.receiptClient;
    let providerChainId: number;
    let transaction: Awaited<ReturnType<typeof client.getTransaction>>;
    let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
    try {
      [providerChainId, transaction, receipt] = await Promise.all([
        client.getChainId(),
        client.getTransaction({ hash: transactionHash as Hash }),
        client.getTransactionReceipt({ hash: transactionHash as Hash }),
      ]);
    } catch {
      throw new ServiceUnavailableException({
        code: 'SWAP_RECEIPT_PENDING',
        message: 'The Arc Mainnet swap receipt is not available yet.',
        retryable: true,
      });
    }
    if (providerChainId !== network.chainId) {
      throw new BadRequestException({
        code: 'SWAP_RECEIPT_MISMATCH',
        message: 'The swap receipt is not an Arc Mainnet transaction.',
      });
    }
    if (receipt.status !== 'success' || !transaction.to) {
      throw new BadRequestException({
        code: 'SWAP_RECEIPT_MISMATCH',
        message: 'The Arc Mainnet swap transaction did not succeed.',
      });
    }
    const call = decodeExecuteSwap(transaction.input);
    const walletAddress = getAddress(authenticatedWallet);
    const verified = verifySwapReceipt(
      {
        chainId: providerChainId,
        status: receipt.status,
        from: transaction.from,
        to: transaction.to,
        input: transaction.input,
        value: transaction.value.toString(),
        logs: receipt.logs,
      },
      {
        walletAddress,
        recipient: walletAddress,
        tokenIn: call.tokenIn,
        tokenOut: call.tokenOut,
        amountIn: call.amountIn,
        minAmountOut: call.minAmountOut,
        transactionData: transaction.input,
        transactionValue: transaction.value,
        zeroForOne: isAddressEqual(call.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC),
      },
    );
    return {
      transactionHash: transactionHash.toLowerCase(),
      walletAddress,
      chainId: network.chainId,
      tokenIn: call.tokenIn,
      tokenOut: call.tokenOut,
      amountIn: verified.tokenInSpent.toString(),
      amountOut: verified.amountOut.toString(),
    };
  }

  /**
   * Atomic cross-token payroll funding from live exact-in probes. Given the
   * exact output obligations, solve for the gross input whose fee-deducted
   * net amountOut (after slippage) covers obligations. Never assumes 1:1.
   * Read-only. Fails closed on non-convergence, overflow, or RPC failure.
   */
  async payrollCrossTokenQuote(
    request: MainnetUniswapV4PayrollQuoteRequest,
  ): Promise<MainnetUniswapV4PayrollQuote> {
    this.assertMainnetProcess();
    const tokenIn = this.payrollAddress(request.tokenInAddress, 'tokenInAddress');
    const tokenOut = this.payrollAddress(request.tokenOutAddress, 'tokenOutAddress');
    if (
      !isOfficialPairToken(tokenIn) ||
      !isOfficialPairToken(tokenOut) ||
      isAddressEqual(tokenIn, tokenOut)
    ) {
      this.payrollInvalid('Only the official Arc Mainnet USDC/EURC pair is supported.');
    }
    const obligations = this.payrollUint(request.outputTotals, 'outputTotals');
    const slippage =
      typeof request.slippageBps === 'number' ? request.slippageBps : 200;
    if (!Number.isInteger(slippage) || slippage < 1 || slippage > 500) {
      this.payrollInvalid('slippageBps must be an integer between 1 and 500.');
    }
    const wallet = this.payrollAddress(request.walletAddress, 'walletAddress');
    const recipient = this.payrollAddress(request.recipient, 'recipient');
    if (!isAddressEqual(wallet, recipient)) {
      this.payrollInvalid('recipient must equal the user-controlled wallet address.');
    }
    const feeBps = await this.quotes.payrollFeeBps();
    if (feeBps < 0n || feeBps > 100n) {
      this.payrollInvalid('Payroll fee is out of range on Arc Mainnet.');
    }
    const deadline = Math.floor(Date.now() / 1_000) + 600;
    const maxUint128 = (1n << 128n) - 1n;
    let gross = obligations;
    let lastMinTotalOut = 0n;
    let lastMinHopPriceX36 = 0n;
    let lastBlock = 0;
    let lastQuotedAt = '';
    let lastExpiresAt = '';
    let lastExpiresAtBlock = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // Exact on-chain fee math (floor), mirroring WizPayPayrollMainnet.
      const feeAmount = (gross * feeBps) / 10_000n;
      const net = gross - feeAmount;
      if (net <= 0n || gross > maxUint128 || net > maxUint128) {
        this.payrollUnavailable(
          'Cross-token payroll input exceeds the Uniswap V4 uint128 swap limit.',
        );
      }
      const normalized = this.readiness.validateBoundary({
        chainId: 5_042,
        tokenInAddress: tokenIn,
        tokenOutAddress: tokenOut,
        amountIn: net.toString(),
        recipient,
        walletAddress: wallet,
        walletControl: 'external-wallet',
        slippageBps: slippage,
        deadline,
      });
      const live = await this.quotes.liveQuote(normalized);
      lastMinTotalOut = live.validated.minAmountOut;
      lastMinHopPriceX36 = live.validated.minHopPriceX36;
      lastBlock = live.observation.blockNumber;
      lastQuotedAt = live.quotedAt;
      lastExpiresAt = live.expiresAt;
      lastExpiresAtBlock = live.expiresAtBlock;
      if (lastMinTotalOut >= obligations) {
        const finalFee = (gross * feeBps) / 10_000n;
        return Object.freeze({
          tokenIn,
          tokenOut,
          obligations: obligations.toString(),
          grossInput: gross.toString(),
          feeAmount: finalFee.toString(),
          netAmountIn: (gross - finalFee).toString(),
          minTotalOut: lastMinTotalOut.toString(),
          minHopPriceX36: lastMinHopPriceX36.toString(),
          slippageBps: slippage,
          payrollFeeBps: feeBps.toString(),
          quoteBlock: lastBlock,
          quotedAt: lastQuotedAt,
          expiresAt: lastExpiresAt,
          expiresAtBlock: lastExpiresAtBlock,
        });
      }
      if (lastMinTotalOut <= 0n) {
        this.payrollUnavailable(
          'Cross-token payroll quote has no output for this input.',
        );
      }
      // Ceiling scale-up toward obligations plus one dust unit.
      const next =
        (gross * obligations + lastMinTotalOut - 1n) / lastMinTotalOut + 1n;
      if (next <= gross || next > maxUint128) {
        this.payrollUnavailable(
          'Cross-token payroll quote did not converge on safe funding.',
        );
      }
      gross = next;
    }
    this.payrollUnavailable(
      'Cross-token payroll quote did not converge on safe funding.',
    );
  }

  private payrollAddress(value: unknown, field: string): `0x${string}` {
    if (typeof value !== 'string' || !isAddress(value)) {
      this.payrollInvalid(`${field} must be a valid EVM address.`);
    }
    const address = getAddress(value);
    if (isAddressEqual(address, zeroAddress)) {
      this.payrollInvalid(`${field} must not be the zero address.`);
    }
    return address;
  }

  private payrollUint(value: unknown, field: string): bigint {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
      this.payrollInvalid(`${field} must be a canonical positive integer string.`);
    }
    const parsed = BigInt(value as string);
    if (parsed > (1n << 128n) - 1n) {
      this.payrollInvalid(`${field} exceeds the Uniswap V4 uint128 swap limit.`);
    }
    return parsed;
  }

  private payrollInvalid(message: string): never {
    throw new BadRequestException({
      code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
      message,
    });
  }

  private payrollUnavailable(message: string): never {
    throw new ServiceUnavailableException({
      code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.UNAVAILABLE,
      message,
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
  }
}
