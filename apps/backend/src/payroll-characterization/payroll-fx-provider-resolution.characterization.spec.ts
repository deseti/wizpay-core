import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockchainService } from '../adapters/blockchain.service';
import { CircleService } from '../adapters/circle.service';
import { StablefxExecutionService } from '../user-swap/stablefx-execution.service';
import { UserSwapService } from '../user-swap/user-swap.service';
import { PayrollFxSettlementService } from '../agents/payroll/payroll-fx-settlement.service';

describe('PayrollFxSettlementService provider resolution (characterization)', () => {
  const treasuryAddress = '0x1111111111111111111111111111111111111111';
  const transactionTarget = '0x2222222222222222222222222222222222222222';
  const txHash = `0x${'a'.repeat(64)}`;
  const request = {
    sourceToken: 'USDC',
    targetToken: 'EURC',
    sourceAmount: '30000000',
    referenceId: 'payroll-provider-characterization',
  };

  let config: Record<string, string | undefined>;
  let userSwapService: { prepare: jest.Mock };
  let circleService: {
    executeContract: jest.Mock;
    waitForTransactionComplete: jest.Mock;
  };
  let stablefxExecutionService: { createTradableQuote: jest.Mock };

  const createService = () =>
    new PayrollFxSettlementService(
      userSwapService as unknown as UserSwapService,
      circleService as unknown as CircleService,
      {
        get: jest.fn((key: string) => config[key]),
      } as unknown as ConfigService,
      stablefxExecutionService as unknown as StablefxExecutionService,
      {} as BlockchainService,
    );

  beforeEach(() => {
    config = {
      WIZPAY_USER_SWAP_ENABLED: 'true',
      WIZPAY_USER_SWAP_ALLOW_TESTNET: 'true',
      WIZPAY_USER_SWAP_KIT_KEY: 'kit-key-for-test',
      APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED: 'true',
      CIRCLE_WALLET_ID_ARC: 'treasury-wallet-id',
      CIRCLE_WALLET_ADDRESS_ARC: treasuryAddress,
    };
    userSwapService = {
      prepare: jest.fn().mockResolvedValue({
        tokenIn: 'USDC',
        tokenOut: 'EURC',
        amountIn: '30000000',
        fromAddress: treasuryAddress,
        toAddress: treasuryAddress,
        chain: 'ARC-TESTNET',
        expectedOutput: '29700000',
        minimumOutput: '29400000',
        transaction: {
          to: transactionTarget,
          data: '0x1234',
          raw: {},
        },
        raw: {},
      }),
    };
    circleService = {
      executeContract: jest.fn().mockResolvedValue({
        txId: 'circle-tx-id',
        status: 'INITIATED',
        txHash: null,
      }),
      waitForTransactionComplete: jest.fn().mockResolvedValue({
        txHash,
        status: 'COMPLETE',
      }),
    };
    stablefxExecutionService = {
      createTradableQuote: jest.fn(),
    };
  });

  it('uses the current SwapKit prepare path when no StableFX flag is selected', async () => {
    const result = await createService().settle(request);

    expect(userSwapService.prepare).toHaveBeenCalledWith({
      amountIn: '30000000',
      chain: 'ARC-TESTNET',
      fromAddress: treasuryAddress,
      toAddress: treasuryAddress,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
    });
    expect(circleService.executeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'treasury-wallet-id',
        contractAddress: transactionTarget,
        callData: '0x1234',
        network: 'ARC-TESTNET',
        refId: 'PAYROLL-FX-payroll-provider-characterization',
      }),
    );
    expect(stablefxExecutionService.createTradableQuote).not.toHaveBeenCalled();
    expect(result).toEqual({
      sourceToken: 'USDC',
      targetToken: 'EURC',
      sourceAmount: '30000000',
      targetAmount: '29700000',
      txHash,
      status: 'settled',
    });
  });

  it.each([
    ['WIZPAY_SWAP_PROVIDER', 'stablefx'],
    ['USE_REAL_STABLEFX', 'true'],
    ['NEXT_PUBLIC_USE_REAL_STABLEFX', 'true'],
  ])('selects StableFX when %s=%s', async (key, value) => {
    config[key] = value;
    stablefxExecutionService.createTradableQuote.mockRejectedValue(
      new Error('stablefx boundary reached'),
    );

    await expect(createService().settle(request)).rejects.toThrow(
      'stablefx boundary reached',
    );
    expect(stablefxExecutionService.createTradableQuote).toHaveBeenCalled();
    expect(userSwapService.prepare).not.toHaveBeenCalled();
  });

  it('re-resolves provider configuration on every settle call', async () => {
    const service = createService();
    await service.settle(request);

    config.WIZPAY_SWAP_PROVIDER = 'stablefx';
    stablefxExecutionService.createTradableQuote.mockRejectedValue(
      new Error('second attempt selected stablefx'),
    );

    await expect(service.settle(request)).rejects.toThrow(
      'second attempt selected stablefx',
    );
    expect(userSwapService.prepare).toHaveBeenCalledTimes(1);
    expect(stablefxExecutionService.createTradableQuote).toHaveBeenCalledTimes(
      1,
    );
  });

  it('passes an unsupported configured provider to the current SwapKit boundary', async () => {
    config.WIZPAY_SWAP_PROVIDER = 'unsupported-provider';
    const providerError = new BadGatewayException({
      code: 'USER_SWAP_PROVIDER_UNSUPPORTED',
      message: 'Unsupported swap provider.',
    });
    userSwapService.prepare.mockRejectedValue(providerError);

    await expect(createService().settle(request)).rejects.toBe(providerError);
    expect(stablefxExecutionService.createTradableQuote).not.toHaveBeenCalled();
  });

  it('fails closed before provider calls when required configuration is missing', async () => {
    delete config.WIZPAY_USER_SWAP_KIT_KEY;

    await expect(createService().settle(request)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(userSwapService.prepare).not.toHaveBeenCalled();
    expect(stablefxExecutionService.createTradableQuote).not.toHaveBeenCalled();
  });

  it('surfaces a dynamic 331001 route failure and allows a later identical request to succeed', async () => {
    const routeUnavailable = new BadGatewayException({
      code: 'CIRCLE_STABLECOIN_API_FAILED',
      message: 'Circle route unavailable.',
      details: { code: 331001 },
    });
    userSwapService.prepare
      .mockRejectedValueOnce(routeUnavailable)
      .mockResolvedValueOnce({
        tokenIn: 'USDC',
        tokenOut: 'EURC',
        amountIn: '30000000',
        fromAddress: treasuryAddress,
        toAddress: treasuryAddress,
        chain: 'ARC-TESTNET',
        expectedOutput: '29700000',
        minimumOutput: '29400000',
        transaction: {
          to: transactionTarget,
          data: '0x1234',
          raw: {},
        },
        raw: {},
      });
    const service = createService();

    await expect(service.settle(request)).rejects.toBe(routeUnavailable);
    await expect(service.settle(request)).resolves.toMatchObject({
      status: 'settled',
      targetAmount: '29700000',
    });
    expect(userSwapService.prepare).toHaveBeenCalledTimes(2);
    expect(stablefxExecutionService.createTradableQuote).not.toHaveBeenCalled();
  });
});
