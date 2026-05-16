import { BadRequestException } from '@nestjs/common';
import { AppWalletSwapService } from './app-wallet-swap.service';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_MODE,
} from './app-wallet-swap.types';
import { UserSwapService } from '../user-swap/user-swap.service';

const TREASURY_ADDRESS = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b';
const USER_ADDRESS = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';

const baseRequest = {
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  amountIn: '1000000',
  fromAddress: USER_ADDRESS,
  chain: APP_WALLET_SWAP_CHAIN,
};
const depositTxHash =
  '0xdd019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';

describe('AppWalletSwapService', () => {
  const originalEnv = process.env;
  const userSwapService = {
    quote: jest.fn(),
  } as unknown as jest.Mocked<Pick<UserSwapService, 'quote'>>;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...originalEnv,
      CIRCLE_WALLET_ADDRESS_ARC: TREASURY_ADDRESS,
    };
    userSwapService.quote.mockResolvedValue({
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: baseRequest.amountIn,
      fromAddress: TREASURY_ADDRESS,
      toAddress: USER_ADDRESS,
      chain: APP_WALLET_SWAP_CHAIN,
      quoteId: 'quote-1',
      expectedOutput: '990000',
      minimumOutput: '970000',
      expiresAt: '2026-05-16T12:00:00.000Z',
      raw: { quoteId: 'quote-1' },
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function createService() {
    return new AppWalletSwapService(userSwapService as UserSwapService);
  }

  it('returns a treasury-mediated quote', async () => {
    const result = await createService().quote(baseRequest);

    expect(userSwapService.quote).toHaveBeenCalledWith({
      amountIn: baseRequest.amountIn,
      chain: APP_WALLET_SWAP_CHAIN,
      fromAddress: TREASURY_ADDRESS,
      toAddress: USER_ADDRESS,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
    });
    expect(result).toMatchObject({
      operationMode: APP_WALLET_SWAP_MODE,
      sourceChain: APP_WALLET_SWAP_CHAIN,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: baseRequest.amountIn,
      treasuryDepositAddress: TREASURY_ADDRESS,
      expectedOutput: '990000',
      minimumOutput: '970000',
      status: 'quoted',
    });
  });

  it('creates an awaiting_user_deposit operation without a txHash', async () => {
    const result = await createService().createOperation(baseRequest);

    expect(result).toMatchObject({
      operationMode: APP_WALLET_SWAP_MODE,
      sourceChain: APP_WALLET_SWAP_CHAIN,
      status: 'awaiting_user_deposit',
      userWalletAddress: USER_ADDRESS,
      treasuryDepositAddress: TREASURY_ADDRESS,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: baseRequest.amountIn,
      executionEnabled: false,
    });
    expect(result.operationId).toEqual(expect.any(String));
    expect(result).not.toHaveProperty('txHash');
    expect(result).not.toHaveProperty('transactionHash');
    expect(result).not.toHaveProperty('payoutTxHash');
  });

  it('rejects invalid chains', async () => {
    await expect(
      createService().createOperation({ ...baseRequest, chain: 'BASE' }),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_UNSUPPORTED_CHAIN',
      },
    });
    expect(userSwapService.quote).not.toHaveBeenCalled();
  });

  it('rejects same-token operations', async () => {
    await expect(
      createService().createOperation({ ...baseRequest, tokenOut: 'USDC' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userSwapService.quote).not.toHaveBeenCalled();
  });

  it('transitions awaiting_user_deposit to deposit_submitted', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    const result = service.submitDeposit(operation.operationId, {
      depositTxHash,
    });

    expect(result).toMatchObject({
      operationId: operation.operationId,
      status: 'deposit_submitted',
      depositTxHash,
    });
    expect(result.depositSubmittedAt).toEqual(expect.any(String));
  });

  it('stores Circle transaction and reference diagnostics', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    const result = service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleTransactionId: 'transaction-1',
    });

    expect(result).toMatchObject({
      operationId: operation.operationId,
      status: 'deposit_submitted',
      circleReferenceId: 'challenge-1',
      circleTransactionId: 'transaction-1',
    });
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });

  it('rejects deposit submission without tx hash or Circle reference', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    await expect(async () =>
      service.submitDeposit(operation.operationId, {}),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
      },
    });
  });

  it('rejects invalid deposit tx hash', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    await expect(async () =>
      service.submitDeposit(operation.operationId, {
        depositTxHash: '0x1234',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
      },
    });
  });

  it('rejects deposit submission for a missing operation', () => {
    expect(() =>
      createService().submitDeposit('missing-operation', {
        depositTxHash,
      }),
    ).toThrow('App Wallet swap operation was not found.');
  });

  it('does not add payout, treasury swap, refund, or settled fields', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    const result = service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
    });

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('refundTxHash');
    expect(result).not.toHaveProperty('settledAt');
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });
});
