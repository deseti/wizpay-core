import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  USER_SWAP_ALLOWED_CHAIN,
  USER_SWAP_API_BASE_URL,
  USER_SWAP_ERROR_CODES,
  type UserSwapChain,
  type UserSwapNormalizedQuote,
  type UserSwapPrepareRequest,
  type UserSwapPrepareResponse,
  type UserSwapQuoteRequest,
  type UserSwapStatusRequest,
  type UserSwapStatusResponse,
  type UserSwapToken,
  type UserSwapTransactionPayload,
} from './user-swap.types';

const SUPPORTED_TOKENS = new Set<UserSwapToken>(['USDC', 'EURC']);
const DEFAULT_SLIPPAGE_BPS = 200;
export const USER_SWAP_STABLECOIN_KITS_CHAIN = 'Arc_Testnet' as const;
export const USER_SWAP_USDC_ADDRESS =
  '0x3600000000000000000000000000000000000000' as const;
export const USER_SWAP_EURC_ADDRESS =
  '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' as const;

const TOKEN_ADDRESS_BY_SYMBOL: Record<UserSwapToken, string> = {
  USDC: USER_SWAP_USDC_ADDRESS,
  EURC: USER_SWAP_EURC_ADDRESS,
};

@Injectable()
export class UserSwapService {
  async quote(request: UserSwapQuoteRequest): Promise<UserSwapNormalizedQuote> {
    const normalized = this.normalizeBaseRequest(request);
    const slippageBps = this.readOptionalSlippageBps(request);
    const raw = await this.callCircleStablecoinApi(
      '/v1/stablecoinKits/quote',
      this.buildCircleSwapParams(normalized, slippageBps),
      'GET',
    );

    return this.normalizeQuoteResponse(normalized, raw);
  }

  async prepare(
    request: UserSwapPrepareRequest,
  ): Promise<UserSwapPrepareResponse> {
    const normalized = this.normalizeBaseRequest(request);
    const slippageBps = request.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const raw = await this.callCircleStablecoinApi('/v1/stablecoinKits/swap', {
      ...this.buildCircleSwapParams(normalized, slippageBps),
    });

    return this.normalizePrepareResponse(normalized, slippageBps, raw);
  }

  private buildCircleSwapParams(
    request: ReturnType<UserSwapService['normalizeBaseRequest']>,
    slippageBps?: number,
  ): Record<string, string | number> {
    return {
      tokenInAddress: TOKEN_ADDRESS_BY_SYMBOL[request.tokenIn],
      tokenInChain: USER_SWAP_STABLECOIN_KITS_CHAIN,
      tokenOutAddress: TOKEN_ADDRESS_BY_SYMBOL[request.tokenOut],
      tokenOutChain: USER_SWAP_STABLECOIN_KITS_CHAIN,
      fromAddress: request.fromAddress,
      toAddress: request.toAddress,
      amount: request.amountIn,
      ...(slippageBps === undefined ? {} : { slippageBps }),
    };
  }

  async status(
    request: UserSwapStatusRequest,
  ): Promise<UserSwapStatusResponse> {
    this.guardConfig(request.chain);

    if (!this.isTransactionHash(request.txHash)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'txHash must be a 0x-prefixed EVM transaction hash.',
      });
    }

    const searchParams = this.toSearchParams({
      chain: USER_SWAP_STABLECOIN_KITS_CHAIN,
      txHash: request.txHash,
    });
    const raw = await this.callCircleStablecoinApi(
      `/v1/stablecoinKits/swap/status?${searchParams.toString()}`,
      undefined,
      'GET',
    );

    return {
      txHash: request.txHash,
      chain: USER_SWAP_ALLOWED_CHAIN,
      status: this.findFirst(raw, ['status', 'state', 'transactionStatus']),
      raw,
    };
  }

  private normalizeBaseRequest(request: UserSwapQuoteRequest) {
    this.guardConfig(request.chain);

    const tokenIn = this.normalizeToken(request.tokenIn);
    const tokenOut = this.normalizeToken(request.tokenOut);
    const amountIn = request.amountIn?.trim();
    const fromAddress = request.fromAddress?.trim();
    const toAddress = request.toAddress?.trim() || fromAddress;

    if (tokenIn === tokenOut) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'tokenIn and tokenOut must be different supported tokens.',
      });
    }

    if (!amountIn || !this.isPositiveDecimal(amountIn)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'amountIn must be a positive decimal string.',
      });
    }

    if (!this.isEvmAddress(fromAddress) || !this.isEvmAddress(toAddress)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'fromAddress and toAddress must be EVM addresses.',
      });
    }

    return {
      tokenIn,
      tokenOut,
      amountIn,
      fromAddress,
      toAddress,
      chain: USER_SWAP_ALLOWED_CHAIN,
    };
  }

  private guardConfig(chain: string): void {
    if (this.readEnvFlag('WIZPAY_USER_SWAP_ENABLED') !== true) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.DISABLED,
        message: 'User-wallet swap proxy is disabled.',
      });
    }

    if (chain !== USER_SWAP_ALLOWED_CHAIN) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.UNSUPPORTED_CHAIN,
        message: 'Only ARC-TESTNET is supported by user-wallet swap.',
      });
    }

    if (this.readEnvFlag('WIZPAY_USER_SWAP_ALLOW_TESTNET') !== true) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.TESTNET_DISABLED,
        message: 'User-wallet swap on Arc Testnet is disabled.',
      });
    }

    if (!this.getKitKey()) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.KIT_KEY_MISSING,
        message: 'User-wallet swap Circle Kit key is not configured.',
      });
    }
  }

  private async callCircleStablecoinApi(
    path: string,
    params?: Record<string, string | number>,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<unknown> {
    const kitKey = this.getKitKey();

    if (!kitKey) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.KIT_KEY_MISSING,
        message: 'User-wallet swap Circle Kit key is not configured.',
      });
    }

    let response: Response;
    try {
      const query = method === 'GET' && params ? this.toSearchParams(params) : '';
      const url = `${USER_SWAP_API_BASE_URL}${path}${query ? `?${query}` : ''}`;

      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${kitKey}`,
          ...(method === 'POST' && params
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body: method === 'POST' && params ? JSON.stringify(params) : undefined,
      });
    } catch (error) {
      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.CIRCLE_STABLECOIN_API_FAILED,
        message: `Circle Stablecoin Kits API request failed: ${this.getErrorMessage(error)}`,
      });
    }

    const rawText = await response.text();
    const raw = this.parseJsonOrText(rawText);

    if (!response.ok) {
      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.CIRCLE_STABLECOIN_API_FAILED,
        message: `Circle Stablecoin Kits API returned ${response.status}.`,
        details: raw,
      });
    }

    return raw;
  }

  private normalizeQuoteResponse(
    request: ReturnType<UserSwapService['normalizeBaseRequest']>,
    raw: unknown,
  ): UserSwapNormalizedQuote {
    this.guardObjectResponse(raw);

    return {
      ...request,
      expectedOutput: this.findFirst(raw, [
        'estimatedOutput',
        'expectedOutput',
        'amountOut',
        'buyAmount',
      ]),
      minimumOutput: this.findFirst(raw, [
        'minimumOutput',
        'minOutput',
        'stopLimit',
        'minAmountOut',
      ]),
      fees: this.findFirst(raw, ['fees', 'fee']),
      expiresAt: this.findFirst(raw, ['expiresAt', 'expiration', 'validUntil']),
      quoteId: this.findFirst(raw, ['quoteId', 'id']),
      raw,
    };
  }

  private normalizePrepareResponse(
    request: ReturnType<UserSwapService['normalizeBaseRequest']>,
    slippageBps: number,
    raw: unknown,
  ): UserSwapPrepareResponse {
    this.guardObjectResponse(raw);
    const transaction = this.findTransactionPayload(raw);

    if (!transaction) {
      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.CIRCLE_STABLECOIN_UNEXPECTED_RESPONSE,
        message:
          'Circle Stablecoin Kits swap response did not include a transaction payload.',
        raw,
      });
    }

    return {
      ...request,
      slippageBps,
      expectedOutput: this.findFirst(raw, [
        'estimatedOutput',
        'expectedOutput',
        'amountOut',
        'buyAmount',
      ]),
      minimumOutput: this.findFirst(raw, [
        'minimumOutput',
        'minOutput',
        'stopLimit',
        'minAmountOut',
      ]),
      transaction,
      raw,
    };
  }

  private findTransactionPayload(raw: unknown): UserSwapTransactionPayload | null {
    const candidates = [
      this.findFirst(raw, ['transaction', 'tx', 'request']),
      this.findFirst(raw, ['transactionPayload', 'txPayload']),
      this.findFirst(raw, ['data.transaction', 'data.tx', 'data.request']),
      this.findFirst(raw, ['data.transactionPayload', 'data.txPayload']),
    ];

    for (const candidate of candidates) {
      if (this.isRecord(candidate)) {
        return {
          to: candidate.to,
          from: candidate.from,
          data: candidate.data,
          value: candidate.value,
          gas: candidate.gas,
          gasPrice: candidate.gasPrice,
          maxFeePerGas: candidate.maxFeePerGas,
          maxPriorityFeePerGas: candidate.maxPriorityFeePerGas,
          chainId: candidate.chainId,
          abi: candidate.abi,
          functionName: candidate.functionName,
          args: candidate.args,
          raw: candidate,
        };
      }
    }

    return null;
  }

  private guardObjectResponse(raw: unknown): asserts raw is Record<string, unknown> {
    if (!this.isRecord(raw)) {
      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.CIRCLE_STABLECOIN_UNEXPECTED_RESPONSE,
        message: 'Circle Stablecoin Kits API returned a non-object response.',
      });
    }
  }

  private normalizeToken(value: string): UserSwapToken {
    const normalized = value?.trim().toUpperCase();

    if (!SUPPORTED_TOKENS.has(normalized as UserSwapToken)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'Only USDC and EURC are supported for user-wallet swap.',
      });
    }

    return normalized as UserSwapToken;
  }

  private findFirst(raw: unknown, paths: string[]): unknown {
    for (const path of paths) {
      const value = this.getPath(raw, path);

      if (value !== undefined && value !== null) {
        return value;
      }
    }

    return undefined;
  }

  private readOptionalSlippageBps(request: UserSwapQuoteRequest): number | undefined {
    const slippageBps = (request as UserSwapQuoteRequest & { slippageBps?: unknown })
      .slippageBps;

    return typeof slippageBps === 'number' ? slippageBps : undefined;
  }

  private toSearchParams(params: Record<string, string | number>): string {
    return new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString();
  }

  private getPath(raw: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
      if (!this.isRecord(current)) {
        return undefined;
      }

      return current[key];
    }, raw);
  }

  private parseJsonOrText(rawText: string): unknown {
    if (!rawText) {
      return {};
    }

    try {
      return JSON.parse(rawText);
    } catch {
      return rawText;
    }
  }

  private readEnvFlag(name: string): boolean {
    return process.env[name] === 'true';
  }

  private getKitKey(): string {
    return process.env.WIZPAY_USER_SWAP_KIT_KEY?.trim() ?? '';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isEvmAddress(value: string | undefined): value is `0x${string}` {
    return /^0x[a-fA-F0-9]{40}$/.test(value ?? '');
  }

  private isTransactionHash(value: string | undefined): value is `0x${string}` {
    return /^0x[a-fA-F0-9]{64}$/.test(value ?? '');
  }

  private isPositiveDecimal(value: string): boolean {
    if (!/^(?:\d+|\d*\.\d+)$/.test(value)) {
      return false;
    }

    return Number(value) > 0;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
