import { ConfigService } from '@nestjs/config';
import { BlockchainService } from '../adapters/blockchain.service';
import { CircleService } from '../adapters/circle.service';
import { StablefxExecutionService } from '../user-swap/stablefx-execution.service';
import { PayrollFxStablefxLifecycleService } from './payroll-fx-stablefx-lifecycle.service';
import { PayrollFxStablefxOperationService } from './payroll-fx-stablefx-operation.service';

describe('PayrollFxStablefxLifecycleService', () => {
  const operationId = '8d00c7ac-d036-4448-94ea-2f38a51e64d8';
  const treasury = '0x2222222222222222222222222222222222222222';
  const wallet = '0x1111111111111111111111111111111111111111';
  const permit2 = '0x3333333333333333333333333333333333333333';
  const settlementHash = `0x${'b'.repeat(64)}`;
  const request = {
    sourceToken: 'USDC',
    targetToken: 'EURC',
    sourceAmount: '900719925474099312345678',
    referenceId: 'phase-2-stablefx-lifecycle',
    walletAddress: wallet,
  };

  let events: string[];
  let stablefx: {
    createTradableQuote: jest.Mock;
    createTrade: jest.Mock;
    getTrade: jest.Mock;
    createFundingPresign: jest.Mock;
    fund: jest.Mock;
  };
  let circle: {
    signTypedData: jest.Mock;
    executeContract: jest.Mock;
    waitForTransactionComplete: jest.Mock;
  };
  let blockchain: {
    getAllowance: jest.Mock;
    buildERC20ApproveData: jest.Mock;
  };
  let operations: {
    begin: jest.Mock;
    recordQuote: jest.Mock;
    recordApproval: jest.Mock;
    recordSubmission: jest.Mock;
    recordFunding: jest.Mock;
    recordSettlement: jest.Mock;
    recordPayoutSubmission: jest.Mock;
    recordPayoutCompletion: jest.Mock;
    recordFailureSafely: jest.Mock;
  };

  function createService() {
    return new PayrollFxStablefxLifecycleService(
      stablefx as unknown as StablefxExecutionService,
      circle as unknown as CircleService,
      {
        get: jest.fn((key: string) =>
          key === 'CIRCLE_WALLET_ID_ARC' ? 'treasury-wallet-id' : undefined,
        ),
      } as unknown as ConfigService,
      blockchain as unknown as BlockchainService,
      operations as unknown as PayrollFxStablefxOperationService,
    );
  }

  beforeEach(() => {
    events = [];
    stablefx = {
      createTradableQuote: jest.fn(() => {
        events.push('quote');
        return {
          id: 'quote-id',
          status: 'open',
          expiresAt: '2026-07-27T09:00:00.000Z',
          typedData: {
            domain: { verifyingContract: permit2 },
            message: { permitted: { amount: request.sourceAmount } },
          },
          to: { amount: '900719925474.123456' },
        };
      }),
      createTrade: jest.fn(() => {
        events.push('trade');
        return {
          id: 'trade-id',
          contractTradeId: 'contract-trade-id',
          status: 'pending',
        };
      }),
      createFundingPresign: jest.fn(() => {
        events.push('funding_presign');
        return {
          typedData: {
            domain: { verifyingContract: permit2 },
            message: { tradeId: 'contract-trade-id' },
          },
        };
      }),
      fund: jest.fn(() => {
        events.push('fund');
        return {
          transactionId: 'funding-transaction-id',
          txHash: `0x${'a'.repeat(64)}`,
          status: 'submitted',
        };
      }),
      getTrade: jest.fn(() => {
        events.push('get_trade');
        return {
          id: 'trade-id',
          transactionId: 'settlement-transaction-id',
          status: 'pending',
          to: { amount: '900719925474.123456' },
          contractTransactions: {
            takerDeliver: { txHash: settlementHash },
          },
        };
      }),
    };
    circle = {
      signTypedData: jest
        .fn()
        .mockImplementationOnce(() => {
          events.push('sign_quote');
          return { signature: '0xquote-signature' };
        })
        .mockImplementationOnce(() => {
          events.push('sign_funding');
          return { signature: '0xfunding-signature' };
        }),
      executeContract: jest.fn(() => {
        events.push('approve');
        return { txId: 'approval-transaction-id', txHash: null };
      }),
      waitForTransactionComplete: jest.fn(() => {
        events.push('confirm_approval');
        return { txHash: `0x${'c'.repeat(64)}`, status: 'COMPLETE' };
      }),
    };
    blockchain = {
      getAllowance: jest.fn(() => {
        events.push('allowance');
        return { allowance: request.sourceAmount };
      }),
      buildERC20ApproveData: jest.fn(() => '0xapprove'),
    };
    operations = {
      begin: jest.fn(() => {
        events.push('operation_begin');
        return { operationId, status: 'quote_pending' };
      }),
      recordQuote: jest.fn(() => events.push('record_quote')),
      recordApproval: jest.fn(() => events.push('record_approval')),
      recordSubmission: jest.fn(() => events.push('record_submission')),
      recordFunding: jest.fn(() => events.push('record_funding')),
      recordSettlement: jest.fn(() => events.push('record_settlement')),
      recordPayoutSubmission: jest.fn(),
      recordPayoutCompletion: jest.fn(),
      recordFailureSafely: jest.fn(),
    };
  });

  it('creates the durable operation before the first provider call and persists exact evidence in current order', async () => {
    const result = await createService().settle(request, treasury);

    expect(events).toEqual([
      'operation_begin',
      'quote',
      'record_quote',
      'allowance',
      'sign_quote',
      'trade',
      'record_submission',
      'funding_presign',
      'sign_funding',
      'fund',
      'record_funding',
      'get_trade',
      'record_settlement',
    ]);
    expect(operations.begin).toHaveBeenCalledWith(
      request,
      treasury,
      expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
      expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
    );
    expect(stablefx.createTradableQuote).toHaveBeenCalledWith(
      expect.objectContaining({ amountIn: request.sourceAmount }),
    );
    expect(operations.recordQuote).toHaveBeenCalledWith(
      operationId,
      expect.objectContaining({
        quoteId: 'quote-id',
        expectedOutputBaseUnits: '900719925474123456',
      }),
    );
    expect(operations.recordApproval).not.toHaveBeenCalled();
    expect(operations.recordSubmission).toHaveBeenCalledWith(
      operationId,
      'quote_ready',
      expect.objectContaining({
        providerOperationId: 'trade-id',
        lastProviderStatus: 'pending',
      }),
    );
    expect(operations.recordFunding).toHaveBeenCalledWith(
      operationId,
      expect.objectContaining({
        fundingTransactionId: 'funding-transaction-id',
        fundingTransactionHash: `0x${'a'.repeat(64)}`,
      }),
    );
    expect(operations.recordSettlement).toHaveBeenCalledWith(
      operationId,
      expect.objectContaining({
        actualOutputBaseUnits: '900719925474123456',
        settlementTransactionId: 'settlement-transaction-id',
        settlementTransactionHash: settlementHash,
        diagnosticSnapshot: {
          stage: 'settled',
          settlementEvidence: 'taker_deliver',
        },
      }),
    );
    expect(result).toEqual({
      sourceToken: 'USDC',
      targetToken: 'EURC',
      sourceAmount: request.sourceAmount,
      targetAmount: '900719925474123456',
      txHash: settlementHash,
      status: 'settled',
      operationId,
    });
  });

  it('records approval only after the existing approval confirmation boundary', async () => {
    blockchain.getAllowance
      .mockImplementationOnce(() => {
        events.push('allowance');
        return { allowance: '0' };
      })
      .mockImplementationOnce(() => {
        events.push('allowance');
        return { allowance: request.sourceAmount };
      });

    await createService().settle(request, treasury);

    expect(events.indexOf('approve')).toBeLessThan(
      events.indexOf('confirm_approval'),
    );
    expect(events.indexOf('confirm_approval')).toBeLessThan(
      events.indexOf('record_approval'),
    );
    expect(events.indexOf('record_approval')).toBeLessThan(
      events.indexOf('trade'),
    );
    expect(operations.recordApproval).toHaveBeenCalledWith(operationId, {
      approvalTransactionId: 'approval-transaction-id',
      approvalTransactionHash: `0x${'c'.repeat(64)}`,
      diagnosticSnapshot: { stage: 'approval_confirmed' },
    });
    expect(operations.recordSubmission).toHaveBeenCalledWith(
      operationId,
      'approval_pending',
      expect.any(Object),
    );
  });

  it('preserves quote errors, records a clean failure, and performs no later stage', async () => {
    const error = new Error('StableFX authentication failed');
    stablefx.createTradableQuote.mockRejectedValue(error);

    await expect(createService().settle(request, treasury)).rejects.toBe(error);
    expect(operations.recordFailureSafely).toHaveBeenCalledWith(
      operationId,
      error,
      'tradable_quote',
      false,
    );
    expect(circle.signTypedData).not.toHaveBeenCalled();
    expect(stablefx.createTrade).not.toHaveBeenCalled();
    expect(stablefx.fund).not.toHaveBeenCalled();
    expect(operations.recordSettlement).not.toHaveBeenCalled();
  });

  it('preserves approval errors and marks possible side effects without submitting a trade', async () => {
    const error = new Error('approval submission uncertain');
    blockchain.getAllowance.mockResolvedValue({ allowance: '0' });
    circle.executeContract.mockRejectedValue(error);

    await expect(createService().settle(request, treasury)).rejects.toBe(error);
    expect(operations.recordFailureSafely).toHaveBeenCalledWith(
      operationId,
      error,
      'allowance_check',
      true,
    );
    expect(stablefx.createTrade).not.toHaveBeenCalled();
    expect(stablefx.fund).not.toHaveBeenCalled();
  });

  it('does not record funding or settlement when trade submission fails', async () => {
    const error = new Error('trade submission uncertain');
    stablefx.createTrade.mockRejectedValue(error);

    await expect(createService().settle(request, treasury)).rejects.toBe(error);
    expect(operations.recordFailureSafely).toHaveBeenCalledWith(
      operationId,
      error,
      'create_trade',
      true,
    );
    expect(operations.recordSubmission).not.toHaveBeenCalled();
    expect(stablefx.fund).not.toHaveBeenCalled();
    expect(operations.recordFunding).not.toHaveBeenCalled();
    expect(operations.recordSettlement).not.toHaveBeenCalled();
  });

  it('does not record false funding or settlement when funding fails', async () => {
    const error = new Error('funding submission uncertain');
    stablefx.fund.mockRejectedValue(error);

    await expect(createService().settle(request, treasury)).rejects.toBe(error);
    expect(operations.recordSubmission).toHaveBeenCalled();
    expect(operations.recordFailureSafely).toHaveBeenCalledWith(
      operationId,
      error,
      'fund',
      true,
    );
    expect(operations.recordFunding).not.toHaveBeenCalled();
    expect(operations.recordSettlement).not.toHaveBeenCalled();
  });

  it('records a settlement failure without manufacturing settlement evidence', async () => {
    stablefx.getTrade.mockResolvedValue({
      id: 'trade-id',
      status: 'failed',
    });

    await expect(
      createService().settle(request, treasury),
    ).rejects.toMatchObject({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      response: expect.objectContaining({
        code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
      }),
    });
    expect(operations.recordFailureSafely).toHaveBeenCalledWith(
      operationId,
      expect.anything(),
      'settlement',
      true,
    );
    expect(operations.recordSettlement).not.toHaveBeenCalled();
  });
});
