import { BadRequestException } from '@nestjs/common';

export const ENABLE_LEGACY_FX_ENV = 'WIZPAY_ENABLE_LEGACY_FX';
export const ENABLE_LEGACY_LIQUIDITY_ENV = 'WIZPAY_ENABLE_LEGACY_LIQUIDITY';
export const OFFICIAL_STABLEFX_AUTH_REQUIRED =
  'OFFICIAL_STABLEFX_AUTH_REQUIRED';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isEnabledFlag(value: string | undefined): boolean {
  return ENABLED_VALUES.has((value ?? '').trim().toLowerCase());
}

export function isLegacyFxEnabled(): boolean {
  return isEnabledFlag(process.env[ENABLE_LEGACY_FX_ENV]);
}

export function isLegacyLiquidityEnabled(): boolean {
  return isEnabledFlag(process.env[ENABLE_LEGACY_LIQUIDITY_ENV]);
}

export function legacyFxDisabledMessage(): string {
  return (
    'Legacy FX routing is disabled by the official StableFX cutover. ' +
    `Set ${ENABLE_LEGACY_FX_ENV}=true only for isolated non-production testing.`
  );
}

export function legacyLiquidityDisabledMessage(): string {
  return (
    'Legacy LP liquidity operations are disabled during the official StableFX migration. ' +
    `Set ${ENABLE_LEGACY_LIQUIDITY_ENV}=true only for isolated non-production testing.`
  );
}

export function assertLegacyFxEnabled(): void {
  if (!isLegacyFxEnabled()) {
    throw new BadRequestException({
      code: 'LEGACY_FX_DISABLED',
      error: legacyFxDisabledMessage(),
    });
  }
}

export function assertLegacyLiquidityEnabled(): void {
  if (!isLegacyLiquidityEnabled()) {
    throw new BadRequestException({
      code: 'LEGACY_LIQUIDITY_DISABLED',
      error: legacyLiquidityDisabledMessage(),
    });
  }
}

export function officialStableFxAuthRequiredMessage(): string {
  return (
    'Cross-currency Send/Payroll uses official Circle StableFX RFQ only. ' +
    'StableFXAdapter, internal LP liquidity, synthetic pricing, and adapter balances are disabled for default routing. ' +
    'Circle StableFX API authentication and product entitlement are required before cross-currency execution can continue.'
  );
}

export function throwOfficialStableFxAuthRequired(): never {
  throw new BadRequestException({
    code: OFFICIAL_STABLEFX_AUTH_REQUIRED,
    error: 'Official StableFX RFQ authentication required',
    message: officialStableFxAuthRequiredMessage(),
  });
}
