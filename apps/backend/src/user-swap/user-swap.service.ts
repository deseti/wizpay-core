import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StablefxQuoteProviderService } from './stablefx-quote-provider.service';
import {
  DEFAULT_SWAP_PROVIDER,
  USER_SWAP_ALLOWED_CHAIN,
  USER_SWAP_API_BASE_URL,
  USER_SWAP_ERROR_CODES,
  type UserSwapChain,
  type UserSwapNormalizedQuote,
  type UserSwapPrepareRequest,
  type UserSwapPrepareResponse,
  type UserSwapProvider,
  type UserSwapQuoteRequest,
  type UserSwapStatusRequest,
  type UserSwapStatusResponse,
  type UserSwapToken,
  type UserSwapTransactionPayload,
} from './user-swap.types';
import { XylonetQuoteProviderService } from './xylonet-quote-provider.service';

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

// Bounded retry policy for transient upstream Circle Stablecoin Kits failures.
// Only the statuses below are treated as transient; client/validation errors
// (400/401/403) are never retried so the existing public error shape is kept.
const CIRCLE_RETRYABLE_STATUSES = new Set<number>([
  404, 408, 429, 500, 502, 503, 504,
]);
const CIRCLE_MAX_ATTEMPTS = 3;
// Backoff applied before attempt N+1 (attempt 1 runs immediately).
const CIRCLE_RETRY_DELAYS_MS = [750, 1500] as const;
// Circle Stablecoin Kits upstream error code for deterministic route/liquidity
// unavailability. Observed as HTTP 404 with body { code: 331001,
// message: "No route available" }. This is not a transient transport failure,
// so it must fail closed without retrying.
const CIRCLE_ROUTE_UNAVAILABLE_CODE = 331001;
// Stable internal reason surfaced in the error details so callers can detect
// route unavailability without depending on the upstream HTTP status alone.
const CIRCLE_ROUTE_UNAVAILABLE_REASON = 'CIRCLE_ROUTE_UNAVAILABLE';

@Injectable()
export class UserSwapService {
  private readonly logger = new Logger(UserSwapService.name);

  // Providers are optional so existing callers/tests that construct
  // `new UserSwapService()` keep working; Nest injects them in the app module.
  constructor(
    private readonly stablefxQuoteProvider: StablefxQuoteProviderService = new StablefxQuoteProviderService(),
    private readonly xylonetQuoteProvider: XylonetQuoteProviderService = new XylonetQuoteProviderService(),
  ) {}

  async quote(request: UserSwapQuoteRequest): Promise<UserSwapNormalizedQuote> {
    const provider = this.getActiveProvider(request.provider);

    if (provider === 'stablefx') {
      return this.quoteWithStablefxProvider(request);
    }

    if (provider === 'xylonet') {
      return this.quoteWithXylonet(request);
    }

    return this.quoteWithSwapKit(request);
  }

  // Runs the StableFX quote path. When WIZPAY_STABLEFX_FALLBACK_TO_SWAPKIT is
  // explicitly enabled, a genuine upstream StableFX failure falls back to the
  // swapkit provider with an explicit (non-silent) warning log. The fallback is
  // disabled by default so the provider fails closed. A missing API key is a
  // hard misconfiguration and is never subject to fallback.
  private async quoteWithStablefxProvider(
    request: UserSwapQuoteRequest,
  ): Promise<UserSwapNormalizedQuote> {
    if (!this.isStablefxFallbackEnabled()) {
      return this.quoteWithStablefx(request);
    }

    try {
      return await this.quoteWithStablefx(request);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        const code = this.readExceptionCode(error);

        // Configuration failure (missing key): fail closed, do not fall back.
        if (code === USER_SWAP_ERROR_CODES.STABLEFX_API_KEY_MISSING) {
          throw error;
        }
      }

      this.logger.warn(
        `[user-swap] StableFX quote failed; falling back to swapkit ` +
          `(WIZPAY_STABLEFX_FALLBACK_TO_SWAPKIT=true). provider=stablefx ` +
          `error=${this.getErrorMessage(error)}`,
      );

      return this.quoteWithSwapKit(request);
    }
  }

  private async quoteWithSwapKit(
    request: UserSwapQuoteRequest,
  ): Promise<UserSwapNormalizedQuote> {
    const normalized = this.normalizeBaseRequest(request);
    const slippageBps = this.readOptionalSlippageBps(request);
    const raw = await this.callCircleStablecoinApi(
      '/v1/stablecoinKits/quote',
      this.buildCircleSwapParams(normalized, slippageBps),
      'GET',
    );

    return this.normalizeQuoteResponse(normalized, raw);
  }

  // Quote-only StableFX path. Reuses the same request validation/normalization
  // as swapkit, then delegates to the StableFX reference quote provider. No
  // settlement, trade creation, or Permit2 funding happens here.
  private async quoteWithStablefx(
    request: UserSwapQuoteRequest,
  ): Promise<UserSwapNormalizedQuote> {
    const normalized = this.normalizeBaseRequest(request, {
      requireKitKey: false,
    });

    return this.stablefxQuoteProvider.quote({
      tokenIn: normalized.tokenIn,
      tokenOut: normalized.tokenOut,
      amountIn: normalized.amountIn,
      fromAddress: normalized.fromAddress,
      toAddress: normalized.toAddress,
      chain: normalized.chain,
      slippageBps: this.readOptionalSlippageBps(request),
    });
  }

  private async quoteWithXylonet(
    request: UserSwapQuoteRequest,
  ): Promise<UserSwapNormalizedQuote> {
    const normalized = this.normalizeBaseRequest(request, {
      requireKitKey: false,
    });

    return this.xylonetQuoteProvider.quote({
      tokenIn: normalized.tokenIn,
      tokenOut: normalized.tokenOut,
      amountIn: normalized.amountIn,
      fromAddress: normalized.fromAddress,
      toAddress: normalized.toAddress,
      chain: normalized.chain,
      slippageBps: this.readOptionalSlippageBps(request),
    });
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

  private normalizeBaseRequest(
    request: UserSwapQuoteRequest,
    options: { requireKitKey?: boolean } = {},
  ) {
    this.guardConfig(request.chain, options);

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

  private guardConfig(
    chain: string,
    options: { requireKitKey?: boolean } = {},
  ): void {
    const { requireKitKey = true } = options;

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

    if (requireKitKey && !this.getKitKey()) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.KIT_KEY_MISSING,
        message: 'User-wallet swap Circle Kit key is not configured.',
      });
    }
  }

  // Resolves the active backend quote provider. Request-level provider is used
  // by External Wallet /swap quotes; WIZPAY_SWAP_PROVIDER remains the legacy
  // default when the request does not specify one.
  private getActiveProvider(requestedProvider?: string): UserSwapProvider {
    const configured = (
      requestedProvider?.trim() || process.env.WIZPAY_SWAP_PROVIDER?.trim()
    )?.toLowerCase();

    if (!configured) {
      return DEFAULT_SWAP_PROVIDER;
    }

    if (
      configured === 'swapkit' ||
      configured === 'stablefx' ||
      configured === 'xylonet'
    ) {
      return configured;
    }

    throw new BadRequestException({
      code: USER_SWAP_ERROR_CODES.PROVIDER_UNSUPPORTED,
      message:
        'Unsupported user-wallet swap provider. Supported providers: swapkit, stablefx, xylonet.',
    });
  }

  // StableFX-to-swapkit fallback is opt-in and disabled by default so the
  // StableFX provider fails closed.
  private isStablefxFallbackEnabled(): boolean {
    return this.readEnvFlag('WIZPAY_STABLEFX_FALLBACK_TO_SWAPKIT');
  }

  // Reads the structured error code from a Nest HttpException response body.
  private readExceptionCode(error: {
    getResponse?: () => unknown;
  }): string | undefined {
    const response =
      typeof error.getResponse === 'function' ? error.getResponse() : undefined;

    if (this.isRecord(response) && typeof response.code === 'string') {
      return response.code;
    }

    return undefined;
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

    const query = method === 'GET' && params ? this.toSearchParams(params) : '';
    const url = `${USER_SWAP_API_BASE_URL}${path}${query ? `?${query}` : ''}`;

    // Bounded retry loop for transient upstream failures. Attempt 1 runs
    // immediately; subsequent attempts wait per CIRCLE_RETRY_DELAYS_MS.
    for (let attempt = 1; attempt <= CIRCLE_MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
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
        // Network/transport failure: preserve the existing immediate failure shape.
        throw new BadGatewayException({
          code: USER_SWAP_ERROR_CODES.CIRCLE_STABLECOIN_API_FAILED,
          message: `Circle Stablecoin Kits API request failed: ${this.getErrorMessage(error)}`,
        });
      }

      const rawText = await response.text();
      const raw = this.parseJsonOrText(rawText);

      if (response.ok) {
        return raw;
      }

      // Deterministic route/liquidity unavailability (HTTP 404 + code 331001).
      // This is not transient, so fail closed immediately without retrying.
      if (
        response.status === 404 &&
        this.readUpstreamErrorCode(raw) === CIRCLE_ROUTE_UNAVAILABLE_CODE
      ) {
        this.logger.warn(
          `[user-swap-circle] Route unavailable (no retry): ` +
          `method=${method} path=${path} status=${response.status} ` +
          `upstreamCode=${CIRCLE_ROUTE_UNAVAILABLE_CODE} ` +
          `attempt=${attempt} maxAttempts=${CIRCLE_MAX_ATTEMPTS}`,
        );

        throw new BadGatewayException({
          // Preserve USER_SWAP_ERROR_CODES compatibility for existing callers.
          code: USER_SWAP_ERROR_CODES.CIRCLE_STABLECOIN_API_FAILED,
          // Stable internal reason so callers can detect route unavailability.
          reason: CIRCLE_ROUTE_UNAVAILABLE_REASON,
          message: 'Circle Stablecoin Kits route unavailable.',
          details: raw,
        });
      }

      const isRetryable = CIRCLE_RETRYABLE_STATUSES.has(response.status);
      const hasAttemptsLeft = attempt < CIRCLE_MAX_ATTEMPTS;

      // Safe diagnostic log. Never includes Authorization, kit key, API key,
      // or entity secret.
      this.logger.warn(
        `[user-swap-circle] Upstream non-OK response: ` +
        `method=${method} path=${path} status=${response.status} ` +
        `attempt=${attempt} maxAttempts=${CIRCLE_MAX_ATTEMPTS} ` +
        `retryable=${isRetryable}`,
      );

      if (isRetryable && hasAttemptsLeft) {
        await this.delay(CIRCLE_RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }

      if (isRetryable) {
        // Transient status but no attempts left: report exhausted retries.
        this.logger.error(
          `[user-swap-circle] Exhausted retries for transient upstream failure: ` +
          `method=${method} path=${path} status=${response.status} ` +
          `attempts=${attempt} maxAttempts=${CIRCLE_MAX_ATTEMPTS}`,
        );
      }

      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.CIRCLE_STABLECOIN_API_FAILED,
        message: `Circle Stablecoin Kits API returned ${response.status}.`,
        details: raw,
      });
    }

    // Defensive fallback: the loop returns or throws on every path above.
    throw new BadGatewayException({
      code: USER_SWAP_ERROR_CODES.CIRCLE_STABLECOIN_API_FAILED,
      message: 'Circle Stablecoin Kits API retry loop terminated unexpectedly.',
    });
  }

  // Resolves after the given delay. Isolated so retry backoff is testable.
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Safely extracts a numeric upstream error code from a parsed Circle error
  // body. Returns undefined when the body is not an object or has no numeric
  // `code`. Never throws and never reads secret material.
  private readUpstreamErrorCode(raw: unknown): number | undefined {
    if (!this.isRecord(raw)) {
      return undefined;
    }

    const code = raw.code;

    if (typeof code === 'number') {
      return code;
    }

    // Some upstreams serialize the code as a numeric string; accept that too.
    if (typeof code === 'string' && /^\d+$/.test(code)) {
      return Number(code);
    }

    return undefined;
  }

  private normalizeQuoteResponse(
    request: ReturnType<UserSwapService['normalizeBaseRequest']>,
    raw: unknown,
  ): UserSwapNormalizedQuote {
    this.guardObjectResponse(raw);

    return {
      ...request,
      provider: 'swapkit',
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
