import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FxRoutingGuard } from './fx-routing-guard.service';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_WINDOW,
} from './fx.constants';

describe('FxRoutingGuard (Mainnet-only)', () => {
  let service: FxRoutingGuard;

  function createService(fxRoutingMode?: string) {
    const module = Test.createTestingModule({
      providers: [
        FxRoutingGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'FX_ROUTING_MODE') return fxRoutingMode;
              return undefined;
            }),
          },
        },
      ],
    });

    return module.compile();
  }

  describe('getActiveMode()', () => {
    it('returns "new" when config is unset (Mainnet default)', async () => {
      const module = await createService(undefined);
      service = module.get(FxRoutingGuard);

      expect(service.getActiveMode()).toBe('new');
    });

    it('returns "new" when config is set to "new"', async () => {
      const module = await createService('new');
      service = module.get(FxRoutingGuard);

      expect(service.getActiveMode()).toBe('new');
    });

    it('fails closed when config is set to "legacy"', async () => {
      const module = await createService('legacy');
      service = module.get(FxRoutingGuard);

      expect(() => service.getActiveMode()).toThrow();
    });

    it('fails closed for unknown routing modes', async () => {
      const module = await createService('provider-x');
      service = module.get(FxRoutingGuard);

      expect(() => service.getActiveMode()).toThrow();
    });
  });

  describe('setMode()', () => {
    it('accepts "new" and resets the circuit breaker', async () => {
      const module = await createService('new');
      service = module.get(FxRoutingGuard);

      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
        service.recordOutcome('new', false);
      }
      expect(service.isCircuitOpen()).toBe(true);

      service.setMode('new', 'operator-1');
      expect(service.isCircuitOpen()).toBe(false);
      expect(service.getActiveMode()).toBe('new');
    });

    it('rejects "legacy" mode on Mainnet', async () => {
      const module = await createService('new');
      service = module.get(FxRoutingGuard);

      expect(() => service.setMode('legacy', 'operator-1')).toThrow();
    });
  });

  describe('circuit breaker', () => {
    it('opens after the failure threshold within the window', async () => {
      const module = await createService('new');
      service = module.get(FxRoutingGuard);

      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
        service.recordOutcome('new', false);
      }

      expect(service.isCircuitOpen()).toBe(true);
      expect(service.getOutcomes()).toHaveLength(CIRCUIT_BREAKER_THRESHOLD);
    });

    it('stays closed on success', async () => {
      const module = await createService('new');
      service = module.get(FxRoutingGuard);

      for (let i = 0; i < CIRCUIT_BREAKER_WINDOW; i++) {
        service.recordOutcome('new', true);
      }

      expect(service.isCircuitOpen()).toBe(false);
    });

    it('caps the rolling window', async () => {
      const module = await createService('new');
      service = module.get(FxRoutingGuard);

      for (let i = 0; i < CIRCUIT_BREAKER_WINDOW + 5; i++) {
        service.recordOutcome('new', true);
      }

      expect(service.getOutcomes()).toHaveLength(CIRCUIT_BREAKER_WINDOW);
    });
  });
});
