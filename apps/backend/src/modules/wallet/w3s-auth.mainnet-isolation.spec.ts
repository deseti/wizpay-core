import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { W3sAuthController } from './w3s-auth.controller';
import { W3sAuthService } from './w3s-auth.service';
import { CIRCLE_CONFIGURATION_ERROR_CODES } from '../../config/circle-execution.config';

function mainnetConfig(): ConfigService {
  // Intentionally empty: Mainnet rejection must not require any Circle
  // Mainnet credentials to be configured.
  const values: Record<string, unknown> = {
    'arcNetwork.key': 'arc-mainnet',
  };
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`Missing ${key}`);
      return values[key];
    }),
  } as unknown as ConfigService;
}

function mainnetCapabilities() {
  return {
    network: 'arc-mainnet',
    assertW3sAction: jest.fn(),
  };
}

describe('W3S Arc Mainnet isolation', () => {
  const originalFetch = global.fetch;
  const prisma = { userWallet: { findUnique: jest.fn() } };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('rejects dispatch on Mainnet before any Circle interaction', async () => {
    const service = new W3sAuthService(
      mainnetConfig(),
      prisma as never,
      mainnetCapabilities() as never,
    );

    await expect(
      service.dispatch('createTransferChallenge', {
        userToken: 'token',
        walletId: 'wallet',
      }),
    ).rejects.toMatchObject({
      code: CIRCLE_CONFIGURATION_ERROR_CODES.BLOCKCHAIN_UNSUPPORTED,
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
  });

  it('rejects direct challenge creation on Mainnet without credentials', async () => {
    const service = new W3sAuthService(
      mainnetConfig(),
      prisma as never,
      mainnetCapabilities() as never,
    );

    await expect(
      service.createUserContractExecutionChallenge({
        callData: '0x',
        contractAddress: '0x0000000000000000000000000000000000000001',
        idempotencyKey: 'key',
        refId: 'ref',
        userToken: 'token',
        walletId: 'wallet',
      }),
    ).rejects.toMatchObject({
      code: CIRCLE_CONFIGURATION_ERROR_CODES.BLOCKCHAIN_UNSUPPORTED,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects read paths on Mainnet without Circle HTTP', async () => {
    const service = new W3sAuthService(
      mainnetConfig(),
      prisma as never,
      mainnetCapabilities() as never,
    );

    await expect(service.getTransaction('tx')).rejects.toMatchObject({
      code: CIRCLE_CONFIGURATION_ERROR_CODES.BLOCKCHAIN_UNSUPPORTED,
    });
    await expect(
      service.getUserTransaction('tx', 'token'),
    ).rejects.toMatchObject({
      code: CIRCLE_CONFIGURATION_ERROR_CODES.BLOCKCHAIN_UNSUPPORTED,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects at the controller before reaching the service', async () => {
    const dispatch = jest.fn();
    const assertW3sAction = jest.fn();
    const controller = new W3sAuthController(
      { dispatch } as unknown as W3sAuthService,
      {
        network: 'arc-mainnet',
        assertW3sAction,
      } as never,
    );

    let thrown: unknown = null;
    try {
      await controller.dispatchAction({ action: 'createDeviceToken' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect((thrown as ServiceUnavailableException).getResponse()).toMatchObject(
      {
        code: CIRCLE_CONFIGURATION_ERROR_CODES.BLOCKCHAIN_UNSUPPORTED,
      },
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(assertW3sAction).not.toHaveBeenCalled();
  });

  it('does not apply the Mainnet guard on Arc Testnet', async () => {
    const service = new W3sAuthService(
      mainnetConfig(),
      prisma as never,
      {
        network: 'arc-testnet',
        assertW3sAction: jest.fn(),
      } as never,
    );

    // Unknown action passes the network guard and falls through to the
    // regular unknown-action error, proving the guard is Mainnet-scoped.
    await expect(service.dispatch('nope', {})).rejects.toThrow(
      'Unknown W3S action: nope',
    );
  });
});
