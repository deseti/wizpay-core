import { BadGatewayException, BadRequestException } from '@nestjs/common';
import {
  buildSwapkitRouteUnavailableDiagnostics,
  isCircleRouteUnavailableError,
  readSwapkitBaseUnitAmount,
  toSwapkitRouteUnavailableError,
} from './app-wallet-swap-swapkit-quote';

describe('app-wallet-swap swapkit quote helpers', () => {
  describe('isCircleRouteUnavailableError', () => {
    it('matches the structured reason', () => {
      expect(
        isCircleRouteUnavailableError(
          new BadGatewayException({ reason: 'CIRCLE_ROUTE_UNAVAILABLE' }),
        ),
      ).toBe(true);
    });

    it.each([
      ['numeric details code', { details: { code: 331001 } }],
      ['string details code', { details: { code: '331001' } }],
      ['top-level upstream code', { upstreamCode: 331001 }],
    ])('matches on %s without the reason field', (_label, body) => {
      expect(
        isCircleRouteUnavailableError(new BadGatewayException(body)),
      ).toBe(true);
    });

    it.each([
      ['a different upstream code', { details: { code: 400123 } }],
      ['no details at all', { message: 'boom' }],
      ['a non-numeric code', { details: { code: 'not-a-code' } }],
    ])('does not match %s', (_label, body) => {
      expect(
        isCircleRouteUnavailableError(new BadGatewayException(body)),
      ).toBe(false);
    });

    it('never classifies on the English message alone', () => {
      expect(
        isCircleRouteUnavailableError(
          new BadGatewayException({
            message: 'Circle Stablecoin Kits route unavailable.',
          }),
        ),
      ).toBe(false);
    });

    it('ignores non-HTTP errors', () => {
      expect(isCircleRouteUnavailableError(new Error('nope'))).toBe(false);
      expect(isCircleRouteUnavailableError(undefined)).toBe(false);
      expect(isCircleRouteUnavailableError(new BadRequestException())).toBe(
        false,
      );
    });
  });

  describe('toSwapkitRouteUnavailableError', () => {
    it('keeps a 502 status and carries actionable, bounded diagnostics', () => {
      const error = toSwapkitRouteUnavailableError({
        error: new BadGatewayException({
          reason: 'CIRCLE_ROUTE_UNAVAILABLE',
          upstreamStatus: 404,
          traceId: 'req-1',
          details: { code: 331001 },
        }),
        tokenIn: 'USDC',
        tokenOut: 'EURC',
        amountIn: '30000000',
      });

      expect(error.getStatus()).toBe(502);
      expect(error.getResponse()).toMatchObject({
        code: 'SWAPKIT_ROUTE_UNAVAILABLE',
        provider: 'swapkit',
        direction: 'USDC->EURC',
        amountIn: '30000000',
        upstreamStatus: 404,
        upstreamCode: 331001,
        traceId: 'req-1',
      });
      expect(String((error.getResponse() as { message: string }).message)).toContain(
        'Try a smaller amount or select StableFX.',
      );
    });

    it('omits diagnostics that the upstream did not provide', () => {
      const response = buildSwapkitRouteUnavailableDiagnostics({
        error: new BadGatewayException({ reason: 'CIRCLE_ROUTE_UNAVAILABLE' }),
        tokenIn: 'EURC',
        tokenOut: 'USDC',
        amountIn: '30000000',
      });

      expect(response).not.toHaveProperty('traceId');
      expect(response).not.toHaveProperty('upstreamStatus');
      expect(response.direction).toBe('EURC->USDC');
    });

    it('does not copy the upstream payload into the domain error', () => {
      const error = toSwapkitRouteUnavailableError({
        error: new BadGatewayException({
          reason: 'CIRCLE_ROUTE_UNAVAILABLE',
          details: { code: 331001, apiKey: 'KIT_KEY:secret' },
        }),
        tokenIn: 'USDC',
        tokenOut: 'EURC',
        amountIn: '30000000',
      });

      expect(JSON.stringify(error.getResponse())).not.toContain('KIT_KEY');
      expect(error.getResponse()).not.toHaveProperty('details');
    });
  });

  describe('readSwapkitBaseUnitAmount', () => {
    it.each([
      ['string', '34260000', '34260000'],
      ['padded string', '  34260000  ', '34260000'],
      ['integer number', 34260000, '34260000'],
      ['bigint', 34260000n, '34260000'],
      ['wrapped object', { amount: '34260000' }, '34260000'],
    ])('accepts a positive %s', (_label, value, expected) => {
      expect(readSwapkitBaseUnitAmount(value)).toBe(expected);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty string', ''],
      ['zero', '0'],
      ['negative', '-1'],
      ['decimal string', '34.26'],
      ['non-numeric', 'unavailable'],
      ['float number', 34.26],
      ['boolean', true],
      ['array', ['34260000']],
    ])('rejects %s', (_label, value) => {
      expect(readSwapkitBaseUnitAmount(value)).toBeNull();
    });
  });
});
