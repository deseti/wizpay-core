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
  getAddress,
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
import {
  ARC_TESTNET_RPC_URL,
  resolveArcTestnetRpcUrl,
} from '../config/arc-rpc';

export const USER_SWAP_ARC_TESTNET_CHAIN_ID = 5_042_002;
export const USER_SWAP_XYLONET_DEFAULT_RPC_URL = ARC_TESTNET_RPC_URL;
export const USER_SWAP_XYLONET_USDC_ADDRESS =
  '0x3600000000000000000000000000000000000000' as const;
export const USER_SWAP_XYLONET_EURC_ADDRESS =
  '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' as const;
export const XYLONET_PUBLIC_CLIENT = Symbol('XYLONET_PUBLIC_CLIENT');
const EXECUTOR_FEE_BPS = 25;
const QUOTE_TTL_SECONDS = 600;

const XYLONET_SUPPORTED_PAIRS = new Set<string>(['USDC->EURC', 'EURC->USDC']);

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

const EXECUTOR_V2_ABI = [
  {
    inputs: [],
    name: 'owner',
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'feeRecipient',
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'feeBps',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ type: 'address' }],
    name: 'allowedRouters',
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ type: 'address' }],
    name: 'allowedTokens',
    outputs: [{ type: 'bool' }],
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
    const routerAddress = this.getConfiguredAddressList(
      'APP_XYLONET_ROUTER_ADDRESSES',
    )[0];
    const executorAddress = this.getConfiguredAddress(
      'WIZPAY_SWAP_EXECUTOR_V2_ADDRESS',
    );
    const safeAddress = this.getConfiguredAddress('WIZPAY_FEE_SAFE');
    const tokenAddresses = this.getConfiguredTokens();
    await this.assertExecutorCapability({
      executorAddress,
      routerAddress,
      safeAddress,
      tokenAddresses,
    });
    const feeBps = EXECUTOR_FEE_BPS;
    const feeAmount = (amountIn * BigInt(feeBps)) / 10_000n;
    const netAmountIn = amountIn - feeAmount;

    const amountOut = await this.readAmountOut({
      routerAddress,
      tokenIn: tokenAddresses[request.tokenIn],
      tokenOut: tokenAddresses[request.tokenOut],
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
      tokenInAddress: tokenAddresses[request.tokenIn],
      tokenOutAddress: tokenAddresses[request.tokenOut],
      recipientAddress: request.fromAddress,
      expiresAt: new Date(Date.now() + QUOTE_TTL_SECONDS * 1_000).toISOString(),
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
        tokenInAddress: tokenAddresses[request.tokenIn],
        tokenOutAddress: tokenAddresses[request.tokenOut],
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
      return await this.getPublicClient().readContract({
        address: input.routerAddress,
        abi: XYLONET_ROUTER_ABI,
        functionName: 'getAmountOut',
        args: [input.tokenIn, input.tokenOut, input.netAmountIn],
      });
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

    if (
      !Number.isInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps > 10_000
    ) {
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

    return value;
  }

  private getConfiguredAddressList(name: string): Address[] {
    const values = (process.env[name] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length === 0 || values.some((value) => !isAddress(value))) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.XYLONET_CONFIG_MISSING,
        message: `${name} must contain at least one valid EVM address.`,
      });
    }
    return [...new Set(values.map((value) => getAddress(value)))];
  }

  private getConfiguredTokens(): Record<UserSwapToken, Address> {
    const parsed = new Map<string, Address>();
    for (const entry of (process.env.APP_XYLONET_TOKEN_ADDRESSES ?? '').split(
      ',',
    )) {
      const [symbol, value] = entry.split('=').map((part) => part?.trim());
      if (symbol && value && isAddress(value))
        parsed.set(symbol.toUpperCase(), getAddress(value));
    }
    const usdc = parsed.get('USDC');
    const eurc = parsed.get('EURC');
    if (!usdc || !eurc || usdc === eurc) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.XYLONET_CONFIG_MISSING,
        message:
          'APP_XYLONET_TOKEN_ADDRESSES must configure distinct USDC and EURC addresses.',
      });
    }
    return { USDC: usdc, EURC: eurc };
  }

  private async assertExecutorCapability(input: {
    executorAddress: Address;
    routerAddress: Address;
    safeAddress: Address;
    tokenAddresses: Record<UserSwapToken, Address>;
  }) {
    const client = this.getPublicClient();
    const code = await client.getBytecode({ address: input.executorAddress });
    if (!code || code === '0x')
      this.invalidExecutor('Canonical executor has no deployed code.');
    const [
      owner,
      feeRecipient,
      feeBps,
      routerAllowed,
      usdcAllowed,
      eurcAllowed,
    ] = await Promise.all([
      client.readContract({
        address: input.executorAddress,
        abi: EXECUTOR_V2_ABI,
        functionName: 'owner',
      }),
      client.readContract({
        address: input.executorAddress,
        abi: EXECUTOR_V2_ABI,
        functionName: 'feeRecipient',
      }),
      client.readContract({
        address: input.executorAddress,
        abi: EXECUTOR_V2_ABI,
        functionName: 'feeBps',
      }),
      client.readContract({
        address: input.executorAddress,
        abi: EXECUTOR_V2_ABI,
        functionName: 'allowedRouters',
        args: [input.routerAddress],
      }),
      client.readContract({
        address: input.executorAddress,
        abi: EXECUTOR_V2_ABI,
        functionName: 'allowedTokens',
        args: [input.tokenAddresses.USDC],
      }),
      client.readContract({
        address: input.executorAddress,
        abi: EXECUTOR_V2_ABI,
        functionName: 'allowedTokens',
        args: [input.tokenAddresses.EURC],
      }),
    ]);
    if (
      typeof owner !== 'string' ||
      typeof feeRecipient !== 'string' ||
      owner.toLowerCase() !== input.safeAddress.toLowerCase() ||
      feeRecipient.toLowerCase() !== input.safeAddress.toLowerCase() ||
      feeBps !== BigInt(EXECUTOR_FEE_BPS) ||
      routerAllowed !== true ||
      usdcAllowed !== true ||
      eurcAllowed !== true
    )
      this.invalidExecutor(
        'Canonical WizPaySwapExecutorV2 is not safely configured.',
      );
  }

  private invalidExecutor(message: string): never {
    throw new ServiceUnavailableException({
      code: USER_SWAP_ERROR_CODES.XYLONET_CONFIG_MISSING,
      message,
    });
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
    return resolveArcTestnetRpcUrl([
      { name: 'ARC_TESTNET_RPC_URL', value: process.env.ARC_TESTNET_RPC_URL },
      {
        name: 'NEXT_PUBLIC_ARC_TESTNET_RPC_URL',
        value: process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL,
      },
    ]);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
