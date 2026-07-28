import { ConfigService } from '@nestjs/config';
import { BlockchainService } from '../adapters/blockchain.service';
import { CircleService } from '../adapters/circle.service';
import { StablefxExecutionService } from '../user-swap/stablefx-execution.service';
import { UserSwapService } from '../user-swap/user-swap.service';
import { PayrollFxSettlementService } from '../agents/payroll/payroll-fx-settlement.service';

describe('PayrollFxSettlementService StableFX path (characterization)', () => {
  const treasuryAddress = '0x1111111111111111111111111111111111111111';
  const permit2Address = '0x2222222222222222222222222222222222222222';
  const settlementTxHash = `0x${'b'.repeat(64)}`;
  const request = {
    sourceToken: 'USDC',
    targetToken: 'EURC',
    sourceAmount: '30000000',
    referenceId: 'payroll-stablefx-characterization',
  };

  let calls: string[];
  let userSwapService: { prepare: jest.Mock };
  let circleService: {
    signTypedData: jest.Mock;
    executeContract: jest.Mock;
    waitForTransactionComplete: jest.Mock;
  };
  let stablefx: {
    createTradableQuote: jest.Mock;
    createTrade: jest.Mock;
    getTrade: jest.Mock;
    createFundingPresign: jest.Mock;
    fund: jest.Mock;
  };
  let blockchain: {
    getAllowance: jest.Mock;
    buildERC20ApproveData: jest.Mock;
  };

  const createService = () =>
    new PayrollFxSettlementService(
      userSwapService as unknown as UserSwapService,
      circleService as unknown as CircleService,
      {
        get: jest.fn((key: string) => {
          const values: Record<string, string> = {
            WIZPAY_USER_SWAP_ENABLED: 'true',
            WIZPAY_USER_SWAP_ALLOW_TESTNET: 'true',
            APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED: 'true',
            CIRCLE_WALLET_ID_ARC: 'treasury-wallet-id',
            CIRCLE_WALLET_ADDRESS_ARC: treasuryAddress,
            WIZPAY_SWAP_PROVIDER: 'stablefx',
          };
          return values[key];
        }),
      } as unknown as ConfigService,
      stablefx as unknown as StablefxExecutionService,
      blockchain as unknown as BlockchainService,
    );

  beforeEach(() => {
    calls = [];
    userSwapService = { prepare: jest.fn() };
    circleService = {
      signTypedData: jest
        .fn()
        .mockImplementationOnce(() => {
          calls.push('sign_quote');
          return { signature: '0xquote-signature' };
        })
        .mockImplementationOnce(() => {
          calls.push('sign_funding');
          return { signature: '0xfunding-signature' };
        }),
      executeContract: jest.fn(),
      waitForTransactionComplete: jest.fn(),
    };
    stablefx = {
      createTradableQuote: jest.fn(() => {
        calls.push('quote');
        return {
          id: 'quote-id',
          typedData: {
            domain: { verifyingContract: permit2Address },
            message: { permitted: { amount: '30000000' } },
          },
          to: { amount: '29.750001' },
        };
      }),
      createTrade: jest.fn(() => {
        calls.push('create_trade');
        return {
          id: 'trade-id',
          contractTradeId: 'contract-trade-id',
        };
      }),
      getTrade: jest.fn(() => {
        calls.push('get_trade');
        return {
          id: 'trade-id',
          status: 'settled',
          to: { amount: '29.750001' },
          contractTransactions: {
            makerDeliver: { txHash: settlementTxHash },
          },
        };
      }),
      createFundingPresign: jest.fn(() => {
        calls.push('funding_presign');
        return {
          typedData: {
            domain: { verifyingContract: permit2Address },
            message: { tradeId: 'contract-trade-id' },
          },
        };
      }),
      fund: jest.fn(() => {
        calls.push('fund');
        return {};
      }),
    };
    blockchain = {
      getAllowance: jest.fn(() => {
        calls.push('allowance');
        return { allowance: '30000000' };
      }),
      buildERC20ApproveData: jest.fn(),
    };
  });

  it('preserves the current quote, allowance, signing, trade, funding, and polling order', async () => {
    const result = await createService().settle(request);

    expect(calls).toEqual([
      'quote',
      'allowance',
      'sign_quote',
      'create_trade',
      'funding_presign',
      'sign_funding',
      'fund',
      'get_trade',
    ]);
    expect(stablefx.createTradableQuote).toHaveBeenCalledWith({
      amountIn: '30000000',
      chain: 'ARC-TESTNET',
      fromAddress: treasuryAddress,
      recipientAddress: treasuryAddress,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
    });
    expect(stablefx.createTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteId: 'quote-id',
        address: treasuryAddress,
        selectedAddress: treasuryAddress,
        tokenIn: 'USDC',
        tokenOut: 'EURC',
        walletMode: 'app',
        signature: '0xquote-signature',
      }),
    );
    expect(stablefx.createFundingPresign).toHaveBeenCalledWith({
      contractTradeId: 'contract-trade-id',
    });
    expect(stablefx.fund).toHaveBeenCalledWith({
      permit2: { tradeId: 'contract-trade-id' },
      signature: '0xfunding-signature',
    });
    expect(userSwapService.prepare).not.toHaveBeenCalled();
    expect(result).toEqual({
      sourceToken: 'USDC',
      targetToken: 'EURC',
      sourceAmount: '30000000',
      targetAmount: '29750001',
      txHash: settlementTxHash,
      status: 'settled',
    });
  });

  it('approves the exact base-unit input when allowance is insufficient', async () => {
    blockchain.getAllowance
      .mockResolvedValueOnce({ allowance: '0' })
      .mockResolvedValueOnce({ allowance: '30000000' });
    blockchain.buildERC20ApproveData.mockReturnValue('0xapprove');
    circleService.executeContract.mockResolvedValue({
      txId: 'approval-tx-id',
      txHash: null,
    });
    circleService.waitForTransactionComplete.mockResolvedValue({
      txHash: `0x${'c'.repeat(64)}`,
      status: 'COMPLETE',
    });

    await createService().settle(request);

    expect(blockchain.buildERC20ApproveData).toHaveBeenCalledWith(
      permit2Address,
      30000000n,
    );
    expect(circleService.executeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'treasury-wallet-id',
        callData: '0xapprove',
        network: 'ARC-TESTNET',
      }),
    );
  });

  it('temporarily treats a takerDeliver hash as sufficient settlement evidence', async () => {
    stablefx.getTrade.mockResolvedValue({
      id: 'trade-id',
      status: 'pending',
      to: { amount: '29.750001' },
      contractTransactions: {
        takerDeliver: { txHash: settlementTxHash },
      },
    });

    await expect(createService().settle(request)).resolves.toMatchObject({
      txHash: settlementTxHash,
      status: 'settled',
    });
    expect(stablefx.getTrade).toHaveBeenCalledTimes(1);
  });

  it('propagates provider errors without retrying the quote boundary', async () => {
    const providerError = new Error('StableFX authentication failed');
    stablefx.createTradableQuote.mockRejectedValue(providerError);

    await expect(createService().settle(request)).rejects.toBe(providerError);
    expect(stablefx.createTradableQuote).toHaveBeenCalledTimes(1);
    expect(stablefx.createTrade).not.toHaveBeenCalled();
  });
});
