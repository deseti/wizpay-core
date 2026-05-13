import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ProductionModeGuardService } from './production-mode-guard.service';

describe('ProductionModeGuardService', () => {
  function createService(envVars: Record<string, string | undefined>) {
    return Test.createTestingModule({
      providers: [
        ProductionModeGuardService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => envVars[key]),
          },
        },
      ],
    }).compile();
  }

  describe('isProductionMode()', () => {
    it('returns true when NEXT_PUBLIC_USE_REAL_STABLEFX=true', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'true',
      });
      const service = module.get(ProductionModeGuardService);

      expect(service.isProductionMode()).toBe(true);
    });

    it('returns false when NEXT_PUBLIC_USE_REAL_STABLEFX=false', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'false',
      });
      const service = module.get(ProductionModeGuardService);

      expect(service.isProductionMode()).toBe(false);
    });

    it('returns false when NEXT_PUBLIC_USE_REAL_STABLEFX is undefined', async () => {
      const module = await createService({});
      const service = module.get(ProductionModeGuardService);

      expect(service.isProductionMode()).toBe(false);
    });

    it('returns false when NEXT_PUBLIC_USE_REAL_STABLEFX is empty string', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: '',
      });
      const service = module.get(ProductionModeGuardService);

      expect(service.isProductionMode()).toBe(false);
    });

    it('returns false for non-"true" values like "TRUE" or "1"', async () => {
      const module1 = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'TRUE',
      });
      expect(module1.get(ProductionModeGuardService).isProductionMode()).toBe(false);

      const module2 = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: '1',
      });
      expect(module2.get(ProductionModeGuardService).isProductionMode()).toBe(false);
    });
  });

  describe('validateFxModeForProduction()', () => {
    it('throws when fxMode is "legacy" in production mode', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'true',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.validateFxModeForProduction('legacy')).toThrow(
        /Production mode violation.*fxMode="legacy" is not permitted/,
      );
    });

    it('does not throw when fxMode is "stablefx" in production mode', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'true',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.validateFxModeForProduction('stablefx')).not.toThrow();
    });

    it('does not throw when fxMode is "new" in production mode', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'true',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.validateFxModeForProduction('new')).not.toThrow();
    });

    it('allows fxMode "legacy" in test mode (not production)', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'false',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.validateFxModeForProduction('legacy')).not.toThrow();
    });

    it('allows fxMode "legacy" when env var is unset', async () => {
      const module = await createService({});
      const service = module.get(ProductionModeGuardService);

      expect(() => service.validateFxModeForProduction('legacy')).not.toThrow();
    });
  });

  describe('isAutoUpdateRatesDisabled()', () => {
    it('returns true in production mode regardless of AUTO_UPDATE_RATES_ENABLED', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'true',
        AUTO_UPDATE_RATES_ENABLED: 'true',
      });
      const service = module.get(ProductionModeGuardService);

      expect(service.isAutoUpdateRatesDisabled()).toBe(true);
    });

    it('returns true when AUTO_UPDATE_RATES_ENABLED=false in non-production', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'false',
        AUTO_UPDATE_RATES_ENABLED: 'false',
      });
      const service = module.get(ProductionModeGuardService);

      expect(service.isAutoUpdateRatesDisabled()).toBe(true);
    });

    it('returns false in non-production when AUTO_UPDATE_RATES_ENABLED is not "false"', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'false',
        AUTO_UPDATE_RATES_ENABLED: 'true',
      });
      const service = module.get(ProductionModeGuardService);

      expect(service.isAutoUpdateRatesDisabled()).toBe(false);
    });

    it('returns false in non-production when AUTO_UPDATE_RATES_ENABLED is unset', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'false',
      });
      const service = module.get(ProductionModeGuardService);

      expect(service.isAutoUpdateRatesDisabled()).toBe(false);
    });
  });

  describe('guardGetExchangeRate()', () => {
    it('throws in production mode', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'true',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.guardGetExchangeRate()).toThrow(
        /Production mode rejection.*getExchangeRate.*decommissioned/,
      );
    });

    it('does not throw in non-production mode', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'false',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.guardGetExchangeRate()).not.toThrow();
    });

    it('does not throw when env var is unset (test environment)', async () => {
      const module = await createService({});
      const service = module.get(ProductionModeGuardService);

      expect(() => service.guardGetExchangeRate()).not.toThrow();
    });
  });

  describe('guardSetExchangeRate()', () => {
    it('throws in production mode', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'true',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.guardSetExchangeRate()).toThrow(
        /Production mode rejection.*setExchangeRate.*disabled in production/,
      );
    });

    it('does not throw in non-production mode', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'false',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.guardSetExchangeRate()).not.toThrow();
    });
  });

  describe('enforceProductionMode()', () => {
    it('throws when FX_ROUTING_MODE=legacy in production', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'true',
        FX_ROUTING_MODE: 'legacy',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.enforceProductionMode()).toThrow(
        /Production mode misconfiguration.*FX_ROUTING_MODE="legacy" is not permitted/,
      );
    });

    it('does not throw when FX_ROUTING_MODE=new in production', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'true',
        FX_ROUTING_MODE: 'new',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.enforceProductionMode()).not.toThrow();
    });

    it('does not throw in non-production mode even with legacy routing', async () => {
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'false',
        FX_ROUTING_MODE: 'legacy',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.enforceProductionMode()).not.toThrow();
    });

    it('does not throw in non-production mode when env is unset', async () => {
      const module = await createService({});
      const service = module.get(ProductionModeGuardService);

      expect(() => service.enforceProductionMode()).not.toThrow();
    });

    it('does not throw when FX_ROUTING_MODE is undefined in production (auto-update check passes)', async () => {
      // When FX_ROUTING_MODE is undefined, it's not "legacy" so the routing check passes.
      // auto-update-rates is always disabled in production mode.
      const module = await createService({
        NEXT_PUBLIC_USE_REAL_STABLEFX: 'true',
        FX_ROUTING_MODE: undefined,
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.enforceProductionMode()).not.toThrow();
    });
  });
});
