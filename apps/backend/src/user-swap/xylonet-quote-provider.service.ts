import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  type Address,
  type PublicClient,
} from 'viem';
import {
  USER_SWAP_ALLOWED_CHAIN,
  USER_SWAP_ERROR_CODES,
  type UserSwapChain,
  type UserSwapNormalizedQuote,
  type UserSwapToken,
} from './user-swap.types';

export const USER_SWAP_ARC_TESTNET_CHAIN_ID = 5_042_002;
export const USER_SWAP_XYLONET_DEFAULT_RPC_URL =
  'https://rpc.testnet.arc.network';
export const USER_SWAP_XYLONET_USDC_ADDRESS =
  '0x3600000000000000000000000000000000000000' as const;
export const USER_SWAP_XYLONET_EURC_ADDRESS =
  '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' as const;
export const XYLONET_PUBLIC_CLIENT = Symbol('XYLONET_PUBLIC_CLIENT');

const XYLONET_SUPPORTED_PAIRS = new Set<string>([
  'USDC->EURC',
  'EURC->USDC',
]);

const TOKEN_ADDRESS_BY_SYMBOL: Record<UserSwapToken, Address> = {
  USDC: USER_SWAP_XYLONET_USDC_ADDRESS,
  EURC: USER_SWAP_XYLONET_EURC_ADDRESS,
};

const XYLONET_ROUTER_ABI = [
  {
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
    ],
    name: 'getAmountOut',
    outputs: [{ name: 'amountOut', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const arcTestnet = defineChain({
  id: USER_SWAP_ARC_TESTNET_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [USER_SWAP_XYLONET_DEFAULT_RPC_URL] },
  },
  testnet: true,
});

export interface XylonetQuoteProviderRequest {
  tokenIn: UserSwapToken;
  tokenOut: UserSwapToken;
  amountIn: string;
  fromAddress: string;
  toAddress: string;
  chain: UserSwapChain;
  slippageBps?: number;
}

@Injectable()
export class XylonetQuoteProviderService {
  constructor(
    @Optional()
    @Inject(XYLONET_PUBLIC_CLIENT)
    private readonly publicClient?: PublicClient,
  ) {}

  async quote(
    request: XylonetQuoteProviderRequest,
  ): Promise<UserSwapNormalizedQuote> {
    this.assertSupportedChain(request.chain);
    this.assertSupportedPair(request.tokenIn, request.tokenOut);
    const amountIn = this.parseBaseUnits(request.amountIn);
    const routerAddress = this.getConfiguredAddress(
      'WIZPAY_XYLONET_ROUTER_ADDRESS',
    );
    const executorAddress = this.getConfiguredAddress(
      'WIZPAY_SWAP_EXECUTOR_ADDRESS',
    );
    const feeBps = this.getExecutorFeeBps();
    const feeAmount = (amountIn * BigInt(feeBps)) / 10_000n;
    const netAmountIn = amountIn - feeAmount;

    const amountOut = await this.readAmountOut({
      routerAddress,
      tokenIn: TOKEN_ADDRESS_BY_SYMBOL[request.tokenIn],
      tokenOut: TOKEN_ADDRESS_BY_SYMBOL[request.tokenOut],
      netAmountIn,
    });
    const minimumAmountOut = this.deriveMinimumAmountOut(
      amountOut,
      request.slippageBps,
    );

    return {
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: amountIn.toString(),
      fromAddress: request.fromAddress,
      toAddress: request.toAddress,
      chain: request.chain,
      provider: 'xylonet',
      expectedOutput: amountOut.toString(),
      ...(minimumAmountOut !== undefined
        ? { minimumOutput: minimumAmountOut.toString() }
        : {}),
      routerAddress,
      executorAddress,
      feeAmount: feeAmount.toString(),
      netAmountIn: netAmountIn.toString(),
      expectedAmountOut: amountOut.toString(),
      ...(minimumAmountOut !== undefined
        ? {
            minimumAmountOut: minimumAmountOut.toString(),
            minAmountOut: minimumAmountOut.toString(),
          }
        : {}),
      chainId: USER_SWAP_ARC_TESTNET_CHAIN_ID,
      fees: {
        feeBps,
        feeAmount: feeAmount.toString(),
        token: request.tokenIn,
      },
      raw: {
        provider: 'xylonet',
        routerAddress,
        executorAddress,
        chainId: USER_SWAP_ARC_TESTNET_CHAIN_ID,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        tokenInAddress: TOKEN_ADDRESS_BY_SYMBOL[request.tokenIn],
        tokenOutAddress: TOKEN_ADDRESS_BY_SYMBOL[request.tokenOut],
        amountIn: amountIn.toString(),
        feeAmount: feeAmount.toString(),
        netAmountIn: netAmountIn.toString(),
        expectedAmountOut: amountOut.toString(),
        expectedOutput: amountOut.toString(),
        minimumAmountOut: minimumAmountOut?.toString(),
        minAmountOut: minimumAmountOut?.toString(),
        feeBps,
      },
    };
  }

  private async readAmountOut(input: {
    routerAddress: Address;
    tokenIn: Address;
    tokenOut: Address;
    netAmountIn: bigint;
  }): Promise<bigint> {
    try {
      return (await this.getPublicClient().readContract({
        address: input.routerAddress,
        abi: XYLONET_ROUTER_ABI,
        functionName: 'getAmountOut',
        args: [input.tokenIn, input.tokenOut, input.netAmountIn],
      })) as bigint;
    } catch (error) {
      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.XYLONET_QUOTE_FAILED,
        message: `XyloNet quote failed: ${this.getErrorMessage(error)}`,
      });
    }
  }

  private assertSupportedPair(
    tokenIn: UserSwapToken,
    tokenOut: UserSwapToken,
  ): void {
    if (!XYLONET_SUPPORTED_PAIRS.has(`${tokenIn}->${tokenOut}`)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.XYLONET_UNSUPPORTED_PAIR,
        message: 'XyloNet supports only USDC->EURC and EURC->USDC quotes.',
      });
    }
  }

  private assertSupportedChain(chain: UserSwapChain): void {
    if (chain !== USER_SWAP_ALLOWED_CHAIN) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.UNSUPPORTED_CHAIN,
        message: 'Only ARC-TESTNET is supported by XyloNet quotes.',
      });
    }
  }

  private parseBaseUnits(value: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'amountIn must be a positive integer base-unit string.',
      });
    }

    const amount = BigInt(value);
    if (amount === 0n) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'amountIn must be greater than zero.',
      });
    }

    return amount;
  }

  private deriveMinimumAmountOut(
    amountOut: bigint,
    slippageBps: number | undefined,
  ): bigint | undefined {
    if (slippageBps === undefined) {
      return undefined;
    }

    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'slippageBps must be an integer between 0 and 10000.',
      });
    }

    return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  }

  private getConfiguredAddress(name: string): Address {
    const value = process.env[name]?.trim();

    if (!value || !isAddress(value)) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.XYLONET_CONFIG_MISSING,
        message: `${name} must be configured with a valid EVM address for XyloNet quotes.`,
      });
    }

    return value as Address;
  }

  private getExecutorFeeBps(): number {
    const raw = process.env.WIZPAY_SWAP_EXECUTOR_FEE_BPS?.trim();

    if (!raw || !/^\d+$/.test(raw)) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.XYLONET_FEE_CONFIG_INVALID,
        message:
          'WIZPAY_SWAP_EXECUTOR_FEE_BPS must be configured as an integer between 0 and 100.',
      });
    }

    const feeBps = Number(raw);
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 100) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.XYLONET_FEE_CONFIG_INVALID,
        message:
          'WIZPAY_SWAP_EXECUTOR_FEE_BPS must be configured as an integer between 0 and 100.',
      });
    }

    return feeBps;
  }

  private getPublicClient(): PublicClient {
    if (this.publicClient) {
      return this.publicClient;
    }

    return createPublicClient({
      chain: arcTestnet,
      transport: http(this.getRpcUrl()),
    });
  }

  private getRpcUrl(): string {
    return (
      process.env.ARC_TESTNET_RPC_URL?.trim() ||
      process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL?.trim() ||
      process.env.ARC_TESTNET_RPC_URLS?.split(/[\s,]+/)[0]?.trim() ||
      process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URLS?.split(/[\s,]+/)[0]?.trim() ||
      USER_SWAP_XYLONET_DEFAULT_RPC_URL
    );
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
