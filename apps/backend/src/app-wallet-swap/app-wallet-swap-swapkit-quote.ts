import { BadGatewayException, HttpException } from '@nestjs/common';
import {
  CIRCLE_ROUTE_UNAVAILABLE_CODE,
  CIRCLE_ROUTE_UNAVAILABLE_REASON,
} from '../user-swap/user-swap.service';
import {
  APP_WALLET_SWAP_ERROR_CODES,
  AppWalletSwapToken,
} from './app-wallet-swap.types';

/**
 * SwapKit-specific quote parsing and error classification for App Wallet swap.
 *
 * Kept out of the orchestration service so provider-specific knowledge (Circle
 * Stablecoin Kits upstream codes and base-unit output fields) lives in one
 * place. StableFX and External Wallet swap do not use this module.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readExceptionResponse(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof HttpException)) {
    return null;
  }

  const response = error.getResponse();

  return isRecord(response) ? response : null;
}

/**
 * Detects Circle's deterministic route-unavailable answer structurally.
 *
 * Matches on the stable internal `reason` first, then falls back to the
 * upstream numeric code carried in `details`. The English message is never
 * used for classification.
 */
export function isCircleRouteUnavailableError(error: unknown): boolean {
  const response = readExceptionResponse(error);

  if (!response) {
    return false;
  }

  if (response.reason === CIRCLE_ROUTE_UNAVAILABLE_REASON) {
    return true;
  }

  if (response.upstreamCode === CIRCLE_ROUTE_UNAVAILABLE_CODE) {
    return true;
  }

  const details = response.details;

  if (!isRecord(details)) {
    return false;
  }

  const code = details.code;

  if (typeof code === 'number') {
    return code === CIRCLE_ROUTE_UNAVAILABLE_CODE;
  }

  return (
    typeof code === 'string' &&
    /^\d+$/.test(code) &&
    Number(code) === CIRCLE_ROUTE_UNAVAILABLE_CODE
  );
}

/**
 * Bounded, non-sensitive diagnostics carried alongside the domain error.
 * Never includes authorization headers, kit keys, cookies, wallet credentials,
 * or the full upstream payload.
 */
export interface SwapkitRouteUnavailableDiagnostics {
  provider: 'swapkit';
  direction: string;
  tokenIn: AppWalletSwapToken;
  tokenOut: AppWalletSwapToken;
  amountIn: string;
  upstreamStatus?: number;
  upstreamCode?: number;
  traceId?: string;
}

export function buildSwapkitRouteUnavailableDiagnostics(params: {
  error: unknown;
  tokenIn: AppWalletSwapToken;
  tokenOut: AppWalletSwapToken;
  amountIn: string;
}): SwapkitRouteUnavailableDiagnostics {
  const response = readExceptionResponse(params.error) ?? {};
  const upstreamStatus = response.upstreamStatus;
  const traceId = response.traceId;

  return {
    provider: 'swapkit',
    direction: `${params.tokenIn}->${params.tokenOut}`,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    ...(typeof upstreamStatus === 'number' ? { upstreamStatus } : {}),
    upstreamCode: CIRCLE_ROUTE_UNAVAILABLE_CODE,
    ...(typeof traceId === 'string' && traceId ? { traceId } : {}),
  };
}

/**
 * Maps Circle's route-unavailable answer onto a stable WizPay domain error.
 *
 * The HTTP status stays 502 (BadGateway), matching what this path already
 * returned, so existing consumers see no status change — only a more specific
 * `code` and actionable message.
 */
export function toSwapkitRouteUnavailableError(params: {
  error: unknown;
  tokenIn: AppWalletSwapToken;
  tokenOut: AppWalletSwapToken;
  amountIn: string;
}): BadGatewayException {
  const diagnostics = buildSwapkitRouteUnavailableDiagnostics(params);

  return new BadGatewayException({
    code: APP_WALLET_SWAP_ERROR_CODES.SWAPKIT_ROUTE_UNAVAILABLE,
    message:
      `SwapKit has no ${params.tokenIn} to ${params.tokenOut} route for this amount. ` +
      'Try a smaller amount or select StableFX.',
    // `provider: 'swapkit'` is carried by the diagnostics below.
    ...diagnostics,
  });
}

/**
 * Normalizes a SwapKit output amount to a positive base-unit string.
 *
 * Circle returns swap amounts as base-unit numeric strings (6 decimals for
 * both USDC and EURC on Arc), so anything that is not a positive integer is
 * treated as underivable rather than silently coerced.
 */
export function readSwapkitBaseUnitAmount(value: unknown): string | null {
  const candidate =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' && Number.isInteger(value)
        ? String(value)
        : typeof value === 'bigint'
          ? value.toString()
          : isRecord(value)
            ? readSwapkitBaseUnitAmount(
                value.amount ?? value.value ?? value.toAmount,
              )
            : null;

  if (!candidate || !/^\d+$/.test(candidate)) {
    return null;
  }

  return BigInt(candidate) > 0n ? candidate : null;
}
