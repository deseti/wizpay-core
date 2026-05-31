import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  USER_SWAP_ERROR_CODES,
  USER_SWAP_STABLEFX_QUOTE_PATH,
  USER_SWAP_STABLEFX_QUOTE_URL,
  type UserSwapNormalizedQuote,
  type UserSwapToken,
} from './user-swap.types';

/**
 * Normalized input passed to the StableFX quote provider. Amounts are WizPay
 * internal base units (6 decimals), matching the rest of the swap layer.
 */
export interface StablefxQuoteProviderRequest {
  tokenIn: UserSwapToken;
  tokenOut: UserSwapToken;
  amountIn: string;
  fromAddress: string;
  toAddress: string;
  chain: UserSwapNormalizedQuote['chain'];
  slippageBps?: number;
}

// Both USDC and EURC use 6 decimals on Arc; WizPay represents amounts in base
// units. StableFX expects/returns human-decimal currency amounts.
const STABLEFX_TOKEN_DECIMALS = 6;

// Only documented, currently supported pairs. Cross-currency execution beyond
// these is not enabled in the quote-only phase.
const STABLEFX_SUPPORTED_PAIRS = new Set<string>([
  'USDC->EURC',
  'EURC->USDC',
]);

// Reference (indicative) quote, settled instantly. Tradable quotes, Permit2
// funding, trade creation, settlement, and webhooks are intentionally NOT
// implemented in this phase.
const STABLEFX_QUOTE_TYPE = 'reference' as const;
const STABLEFX_QUOTE_TENOR = 'instant' as const;

// Circle StableFX upstream error code for an amount below the minimum tradable
// size. Surfaced as a clear route/amount error rather than a generic gateway
// failure.
const STABLEFX_AMOUNT_BELOW_MINIMUM_CODE = 3005;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * StableFX reference quote provider for WizPay user/app-wallet swaps.
 *
 * Quote-only: this provider calls Circle StableFX
 * `POST /v1/exchange/stablefx/quotes` with `type=reference, tenor=instant`,
 * maps the indicative result into the existing public quote shape, and never
 * creates trades, funds Permit2, or settles. It fails closed when the API key
 * is missing or the upstream route/amount is unavailable.
 */
@Injectable()
export class StablefxQuoteProviderService {
  private readonly logger = new Logger(StablefxQuoteProviderService.name);

  async quote(
    request: StablefxQuoteProviderRequest,
  ): Promise<UserSwapNormalizedQuote> {
    this.assertSupportedPair(request.tokenIn, request.tokenOut);

    const apiKey = this.getApiKey();

    if (!apiKey) {
      // Fail closed: provider is selected but not configured.
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_API_KEY_MISSING,
        message:
          'StableFX quote provider is selected but CIRCLE_STABLEFX_API_KEY is not configured.',
      });
    }

    const fromAmountDecimal = this.baseUnitsToDecimalString(
      request.amountIn,
      STABLEFX_TOKEN_DECIMALS,
    );
    const body = {
      type: STABLEFX_QUOTE_TYPE,
      tenor: STABLEFX_QUOTE_TENOR,
      from: {
        currency: request.tokenIn,
        amount: fromAmountDecimal,
      },
      to: {
        currency: request.tokenOut,
      },
    };

    const raw = await this.callStablefxQuote(apiKey, body);
    const quote = this.extractQuoteObject(raw);

    const toAmountDecimal = this.readAmount(quote.to);

    if (toAmountDecimal === undefined) {
      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_UNEXPECTED_RESPONSE,
        message:
          'StableFX quote response did not include a destination amount.',
      });
    }

    const expectedOutputBaseUnits = this.decimalToBaseUnits(
      toAmountDecimal,
      STABLEFX_TOKEN_DECIMALS,
    );
    const minimumOutputBaseUnits = this.deriveMinimumOutput(
      expectedOutputBaseUnits,
      request.slippageBps,
    );

    return {
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amountIn,
      fromAddress: request.fromAddress,
      toAddress: request.toAddress,
      chain: request.chain,
      provider: 'stablefx',
      expectedOutput: expectedOutputBaseUnits,
      ...(minimumOutputBaseUnits !== undefined
        ? { minimumOutput: minimumOutputBaseUnits }
        : {}),
      fees: this.readFirst(quote, ['fee', 'fees']),
      expiresAt: this.readFirst(quote, ['expiresAt', 'expiration']),
      quoteId: this.readFirst(quote, ['id', 'quoteId']),
      raw: this.sanitizeQuote(quote),
    };
  }

  private assertSupportedPair(
    tokenIn: UserSwapToken,
    tokenOut: UserSwapToken,
  ): void {
    if (!STABLEFX_SUPPORTED_PAIRS.has(`${tokenIn}->${tokenOut}`)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_UNSUPPORTED_PAIR,
        message:
          'StableFX quote provider supports only USDC->EURC and EURC->USDC.',
      });
    }
  }

  private async callStablefxQuote(
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    let response: Response;

    try {
      response = await fetch(USER_SWAP_STABLEFX_QUOTE_URL, {
        method: 'POST',
        headers: {
          // Never logged. Authorization carries the StableFX API key only.
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error(
        `[user-swap-stablefx] Upstream request failed: ` +
          `method=POST path=${USER_SWAP_STABLEFX_QUOTE_PATH} provider=stablefx ` +
          `error=${this.getErrorMessage(error)}`,
      );

      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_API_FAILED,
        message: `StableFX quote request failed: ${this.getErrorMessage(error)}`,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const rawText = await response.text();
    const raw = this.parseJsonOrText(rawText);

    if (response.ok) {
      return raw;
    }

    return this.handleUpstreamError(response.status, raw);
  }

  private handleUpstreamError(status: number, raw: unknown): never {
    const upstreamCode = this.readErrorCode(raw);
    const sanitizedError = this.sanitizeUpstreamError(raw);

    // Safe diagnostic log: method, path, provider, status, and sanitized
    // upstream error only. Never includes the API key.
    this.logger.warn(
      `[user-swap-stablefx] Upstream non-OK response: ` +
        `method=POST path=${USER_SWAP_STABLEFX_QUOTE_PATH} provider=stablefx ` +
        `status=${status} upstreamCode=${upstreamCode ?? 'none'} ` +
        `error=${JSON.stringify(sanitizedError)}`,
    );

    // Amount below the minimum tradable size: return a clear route/amount
    // error instead of a generic Bad Gateway.
    if (upstreamCode === STABLEFX_AMOUNT_BELOW_MINIMUM_CODE) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_AMOUNT_BELOW_MINIMUM,
        message:
          'StableFX rejected the quote: the amount is below the minimum tradable size for this pair.',
        details: sanitizedError,
      });
    }

    // Authentication / entitlement failure: surface as an explicit auth blocker
    // rather than a legacy fallback.
    if (status === 401 || status === 403) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_AUTH_BLOCKED,
        message:
          'StableFX authentication or entitlement is missing. Quote provider is blocked.',
        details: sanitizedError,
      });
    }

    throw new BadGatewayException({
      code: USER_SWAP_ERROR_CODES.STABLEFX_API_FAILED,
      message: `StableFX quote API returned ${status}.`,
      details: sanitizedError,
    });
  }

  // ───────────────────────────── Amount helpers ─────────────────────────────

  /**
   * Converts WizPay base units (integer string) to a human-decimal string.
   * Example: ("2000000", 6) -> "2"; ("1788428", 6) -> "1.788428".
   */
  baseUnitsToDecimalString(value: string, decimals: number): string {
    const trimmed = value?.trim();

    if (!trimmed || !/^\d+$/.test(trimmed)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'amountIn must be a positive integer base-unit string.',
      });
    }

    const amount = BigInt(trimmed);

    if (amount <= 0n) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'amountIn must be greater than zero.',
      });
    }

    const scale = 10n ** BigInt(decimals);
    const whole = amount / scale;
    const fraction = amount % scale;

    if (fraction === 0n) {
      return whole.toString();
    }

    const fractionStr = fraction
      .toString()
      .padStart(decimals, '0')
      .replace(/0+$/, '');

    return `${whole.toString()}.${fractionStr}`;
  }

  /**
   * Converts a human-decimal string to WizPay base units (integer string).
   * Fractional digits beyond `decimals` are truncated (conservative, never
   * overstates output). Example: ("1.788428", 6) -> "1788428".
   */
  decimalToBaseUnits(value: string, decimals: number): string {
    const trimmed = value?.trim();

    if (!trimmed || !/^\d+(?:\.\d+)?$/.test(trimmed)) {
      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_UNEXPECTED_RESPONSE,
        message: `StableFX returned a non-decimal amount: "${value}".`,
      });
    }

    const [wholePart, fractionPart = ''] = trimmed.split('.');
    const truncatedFraction = fractionPart.slice(0, decimals);
    const paddedFraction = truncatedFraction.padEnd(decimals, '0');
    const scale = 10n ** BigInt(decimals);

    return (BigInt(wholePart) * scale + BigInt(paddedFraction || '0')).toString();
  }

  /**
   * Derives a minimum output (base units) by applying the requested slippage
   * to the expected output. Returns undefined when no slippage is requested.
   */
  private deriveMinimumOutput(
    expectedOutputBaseUnits: string,
    slippageBps?: number,
  ): string | undefined {
    if (
      slippageBps === undefined ||
      !Number.isInteger(slippageBps) ||
      slippageBps <= 0 ||
      slippageBps >= 10_000
    ) {
      return undefined;
    }

    const expected = BigInt(expectedOutputBaseUnits);
    const numerator = BigInt(10_000 - slippageBps);

    return ((expected * numerator) / 10_000n).toString();
  }

  // ───────────────────────────── Response helpers ───────────────────────────

  private extractQuoteObject(raw: unknown): Record<string, unknown> {
    if (this.isRecord(raw) && this.isRecord(raw.data)) {
      return raw.data;
    }

    if (this.isRecord(raw)) {
      return raw;
    }

    throw new BadGatewayException({
      code: USER_SWAP_ERROR_CODES.STABLEFX_UNEXPECTED_RESPONSE,
      message: 'StableFX quote API returned a non-object response.',
    });
  }

  private readAmount(value: unknown): string | undefined {
    if (this.isRecord(value)) {
      const amount = value.amount;

      if (typeof amount === 'string' && amount.trim()) {
        return amount.trim();
      }

      if (typeof amount === 'number' && Number.isFinite(amount)) {
        return String(amount);
      }
    }

    return undefined;
  }

  private readFirst(
    record: Record<string, unknown>,
    keys: string[],
  ): unknown {
    for (const key of keys) {
      const value = record[key];

      if (value !== undefined && value !== null) {
        return value;
      }
    }

    return undefined;
  }

  private readErrorCode(raw: unknown): number | undefined {
    if (!this.isRecord(raw)) {
      return undefined;
    }

    const directCode = this.coerceCode(raw.code);

    if (directCode !== undefined) {
      return directCode;
    }

    if (this.isRecord(raw.error)) {
      return this.coerceCode(raw.error.code);
    }

    return undefined;
  }

  private coerceCode(code: unknown): number | undefined {
    if (typeof code === 'number') {
      return code;
    }

    if (typeof code === 'string' && /^\d+$/.test(code)) {
      return Number(code);
    }

    return undefined;
  }

  /**
   * Returns a minimal, safe view of the quote for persistence/response. Only
   * known, non-sensitive fields are retained.
   */
  private sanitizeQuote(quote: Record<string, unknown>): Record<string, unknown> {
    const allowedKeys = [
      'id',
      'quoteId',
      'rate',
      'from',
      'to',
      'fee',
      'collateral',
      'createdAt',
      'expiresAt',
      'tenor',
      'type',
    ];

    return allowedKeys.reduce<Record<string, unknown>>((acc, key) => {
      if (quote[key] !== undefined) {
        acc[key] = quote[key];
      }

      return acc;
    }, {});
  }

  /**
   * Returns a sanitized upstream error for logging/response: only the upstream
   * code and message are surfaced. Never includes credentials.
   */
  private sanitizeUpstreamError(raw: unknown): Record<string, unknown> {
    if (!this.isRecord(raw)) {
      return {};
    }

    const source = this.isRecord(raw.error) ? raw.error : raw;
    const sanitized: Record<string, unknown> = {};
    const code = this.coerceCode(source.code);

    if (code !== undefined) {
      sanitized.code = code;
    }

    if (typeof source.message === 'string') {
      sanitized.message = source.message;
    }

    return sanitized;
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

  private getApiKey(): string {
    return process.env.CIRCLE_STABLEFX_API_KEY?.trim() ?? '';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
