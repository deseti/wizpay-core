import { MODULE_METADATA } from '@nestjs/common/constants';
import { BlockchainService } from '../adapters/blockchain.service';
import { CircleService } from '../adapters/circle.service';
import { W3sAuthService } from '../modules/wallet/w3s-auth.service';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import { AppWalletSwapModule } from './app-wallet-swap.module';

const createCircleWalletsAdapterMock = jest.fn();
const adapterContract = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const arcTestnet = {
  id: 5042002,
  kitContracts: { adapter: adapterContract },
};

jest.mock('@circle-fin/adapter-circle-wallets', () => ({
  createCircleWalletsAdapter: (...args: unknown[]) =>
    createCircleWalletsAdapterMock(...args),
}));

jest.mock('@circle-fin/bridge-kit/chains', () => ({
  ArcTestnet: arcTestnet,
}));

describe('AppWalletSwapCircleExecutorService', () => {
  const circleService = {
    executeContract: jest.fn(),
    getTransactionStatus: jest.fn(),
    getWalletBalance: jest.fn(),
    signTypedData: jest.fn(),
    transfer: jest.fn(),
    waitForTransactionComplete: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<
      CircleService,
      | 'executeContract'
      | 'getTransactionStatus'
      | 'getWalletBalance'
      | 'signTypedData'
      | 'transfer'
      | 'waitForTransactionComplete'
    >
  >;
  const w3sAuthService = {
    getTransaction: jest.fn(),
    listTransactions: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<W3sAuthService, 'getTransaction' | 'listTransactions'>
  >;
  const blockchainService = {
    buildERC20ApproveData: jest.fn(),
    getAllowance: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<BlockchainService, 'buildERC20ApproveData' | 'getAllowance'>
  >;
  let executor: AppWalletSwapCircleExecutorService;

  beforeEach(() => {
    jest.resetAllMocks();
    executor = new AppWalletSwapCircleExecutorService(
      circleService as unknown as CircleService,
      w3sAuthService as unknown as W3sAuthService,
      blockchainService as unknown as BlockchainService,
    );
  });

  it('is registered only as an App Wallet swap module provider', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppWalletSwapModule,
    );

    expect(providers).toContain(AppWalletSwapCircleExecutorService);
  });

  it('passes the exact transfer payload through without mutation', async () => {
    const input = Object.freeze({
      walletId: 'wallet-1',
      network: 'ARC-TESTNET',
      token: 'EURC',
      toAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      amount: '12.345678',
      idempotencyKey: 'payout-key',
    });
    const result = { txId: 'tx-1', status: 'INITIATED', txHash: null } as const;
    circleService.transfer.mockResolvedValue(result);

    await expect(executor.submitTransfer(input)).resolves.toBe(result);
    expect(circleService.transfer).toHaveBeenCalledTimes(1);
    expect(circleService.transfer).toHaveBeenCalledWith(input);
    expect(input).toEqual({
      walletId: 'wallet-1',
      network: 'ARC-TESTNET',
      token: 'EURC',
      toAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      amount: '12.345678',
      idempotencyKey: 'payout-key',
    });
  });

  it('passes the exact contract execution payload through', async () => {
    const input = Object.freeze({
      walletId: 'wallet-1',
      contractAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      callData: '0x1234' as const,
      network: 'ARC-TESTNET',
      amount: '0',
      refId: 'APP-WALLET-SWAP-operation-TREASURY-SWAP',
      idempotencyKey: 'treasury-key',
    });
    const result = {
      txId: 'tx-2',
      status: 'INITIATED',
      txHash: null,
      raw: { id: 'tx-2' },
    } as const;
    circleService.executeContract.mockResolvedValue(result);

    await expect(executor.submitContractExecution(input)).resolves.toBe(result);
    expect(circleService.executeContract).toHaveBeenCalledWith(input);
  });

  it('passes the exact typed-data signing payload through', async () => {
    const input = Object.freeze({
      walletId: 'wallet-1',
      typedData: Object.freeze({ domain: { chainId: 5042002 } }),
      memo: 'synthetic memo',
    });
    const result = { signature: '0x1234', raw: { id: 'signature-1' } };
    circleService.signTypedData.mockResolvedValue(result);

    await expect(executor.signTypedData(input)).resolves.toBe(result);
    expect(circleService.signTypedData).toHaveBeenCalledWith(input);
  });

  it('delegates Circle status and balance retrieval with exact arguments', async () => {
    const status = {
      txId: 'tx-1',
      status: 'SENT',
      txHash: null,
      blockNumber: null,
      errorReason: null,
    } as const;
    circleService.getTransactionStatus.mockResolvedValue(status);
    circleService.getWalletBalance.mockResolvedValue([]);

    await expect(executor.getTransactionStatus('tx-1')).resolves.toBe(status);
    await expect(
      executor.getWalletBalance(
        'wallet-1',
        '0xdddddddddddddddddddddddddddddddddddddddd',
      ),
    ).resolves.toEqual([]);
    expect(circleService.getTransactionStatus).toHaveBeenCalledWith('tx-1');
    expect(circleService.getWalletBalance).toHaveBeenCalledWith(
      'wallet-1',
      '0xdddddddddddddddddddddddddddddddddddddddd',
    );
  });

  it('preserves direct W3S lookup then list call order and query parameters', async () => {
    w3sAuthService.getTransaction.mockResolvedValue({ transaction: {} });
    w3sAuthService.listTransactions.mockResolvedValue({ transactions: [] });
    const query = Object.freeze({
      blockchain: 'ARC-TESTNET',
      destinationAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    await executor.getW3sTransaction('provider-transaction-1');
    await executor.listW3sTransactions(query);

    expect(w3sAuthService.getTransaction).toHaveBeenCalledWith(
      'provider-transaction-1',
    );
    expect(w3sAuthService.listTransactions).toHaveBeenCalledWith(query);
    expect(
      w3sAuthService.getTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(w3sAuthService.listTransactions.mock.invocationCallOrder[0]);
  });

  it('propagates provider lookup and submission errors unchanged', async () => {
    const lookupError = new Error('synthetic lookup failure');
    const submissionError = new Error('synthetic submission failure');
    w3sAuthService.getTransaction.mockRejectedValue(lookupError);
    circleService.transfer.mockRejectedValue(submissionError);

    await expect(executor.getW3sTransaction('tx-1')).rejects.toBe(lookupError);
    await expect(
      executor.submitTransfer({
        toAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        amount: '1',
        token: 'USDC',
      }),
    ).rejects.toBe(submissionError);
  });

  it('recognizes only complete direct contract execution inputs', () => {
    expect(
      executor.buildDirectContractExecution({
        transaction: {
          to: '0xcccccccccccccccccccccccccccccccccccccccc',
          data: '0x1234',
        },
      }),
    ).toEqual({
      contractAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      callData: '0x1234',
    });
    expect(
      executor.buildDirectContractExecution({
        transaction: { to: 'invalid', data: '0x1234' },
      }),
    ).toBeNull();
    expect(
      executor.buildDirectContractExecution({
        transaction: {
          to: '0xcccccccccccccccccccccccccccccccccccccccc',
          data: '0x123',
        },
      }),
    ).toBeNull();
  });

  it.each([
    ['0', 6, '0'],
    ['1000000', 6, '1'],
    ['1234567', 6, '1.234567'],
    ['1200000', 6, '1.2'],
    ['1', 6, '0.000001'],
  ])(
    'formats %s base units at %s decimals as %s',
    (value, decimals, expected) => {
      expect(executor.formatBaseUnits(value, decimals)).toBe(expected);
    },
  );

  it('skips approval when the existing allowance is sufficient', async () => {
    blockchainService.getAllowance.mockResolvedValue({
      owner: 'treasury',
      spender: 'permit2',
      tokenAddress: 'token',
      allowance: '1000000',
    });

    await expect(
      executor.ensureTokenAllowance({
        approvalTarget: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        contractAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        idempotencyKey: 'approval-key',
        network: 'ARC-TESTNET',
        refId: 'APP-WALLET-SWAP-operation-STABLEFX-USDC-APPROVAL',
        requiredAllowance: 1000000n,
        treasuryAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        walletId: 'wallet-1',
      }),
    ).resolves.toEqual({
      allowanceBefore: '1000000',
      allowanceAfter: '1000000',
    });
    expect(circleService.executeContract).not.toHaveBeenCalled();
  });

  it('submits approval with the exact token, spender, amount, key, and refId', async () => {
    blockchainService.getAllowance
      .mockResolvedValueOnce({
        owner: 'treasury',
        spender: 'permit2',
        tokenAddress: 'token',
        allowance: '0',
      })
      .mockResolvedValueOnce({
        owner: 'treasury',
        spender: 'permit2',
        tokenAddress: 'token',
        allowance: '17000000',
      });
    blockchainService.buildERC20ApproveData.mockReturnValue('0x095ea7b3');
    circleService.executeContract.mockResolvedValue({
      txId: 'approval-1',
      status: 'INITIATED',
      txHash: null,
      raw: {},
    });
    circleService.waitForTransactionComplete.mockResolvedValue({
      txId: 'approval-1',
      status: 'COMPLETE',
      txHash:
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      blockNumber: '1',
      errorReason: null,
    });
    const input = Object.freeze({
      approvalTarget: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contractAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      idempotencyKey: 'deterministic-approval-key',
      network: 'ARC-TESTNET',
      refId: 'APP-WALLET-SWAP-operation-STABLEFX-EURC-APPROVAL',
      requiredAllowance: 17000000n,
      treasuryAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      walletId: 'wallet-1',
    });

    await expect(executor.ensureTokenAllowance(input)).resolves.toEqual({
      allowanceBefore: '0',
      allowanceAfter: '17000000',
      approvalTxHash:
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    expect(blockchainService.buildERC20ApproveData).toHaveBeenCalledWith(
      input.approvalTarget,
      17000000n,
    );
    expect(circleService.executeContract).toHaveBeenCalledWith({
      walletId: 'wallet-1',
      contractAddress: input.contractAddress,
      callData: '0x095ea7b3',
      network: 'ARC-TESTNET',
      idempotencyKey: 'deterministic-approval-key',
      refId: 'APP-WALLET-SWAP-operation-STABLEFX-EURC-APPROVAL',
    });
    expect(circleService.waitForTransactionComplete).toHaveBeenCalledWith(
      'approval-1',
    );
    expect(input.requiredAllowance).toBe(17000000n);
  });

  it('fails closed when approval completes without sufficient allowance', async () => {
    blockchainService.getAllowance
      .mockResolvedValueOnce({ allowance: '0' } as never)
      .mockResolvedValueOnce({ allowance: '1' } as never);
    blockchainService.buildERC20ApproveData.mockReturnValue('0x095ea7b3');
    circleService.executeContract.mockResolvedValue({
      txId: 'approval-1',
      status: 'INITIATED',
      txHash: null,
      raw: {},
    });
    circleService.waitForTransactionComplete.mockResolvedValue({
      txId: 'approval-1',
      status: 'COMPLETE',
      txHash: null,
      blockNumber: null,
      errorReason: null,
    });

    await expect(
      executor.ensureTokenAllowance({
        approvalTarget: adapterContract,
        contractAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        idempotencyKey: 'key',
        network: 'ARC-TESTNET',
        refId: 'ref',
        requiredAllowance: 2n,
        treasuryAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        walletId: 'wallet-1',
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('fails closed when blockchain allowance support is unavailable', async () => {
    const executorWithoutBlockchain = new AppWalletSwapCircleExecutorService(
      circleService as unknown as CircleService,
      w3sAuthService as unknown as W3sAuthService,
    );

    await expect(
      executorWithoutBlockchain.ensureTokenAllowance({
        approvalTarget: adapterContract,
        contractAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        idempotencyKey: 'key',
        network: 'ARC-TESTNET',
        refId: 'ref',
        requiredAllowance: 1n,
        treasuryAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        walletId: 'wallet-1',
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('executes adapter approval before swap with unchanged prepared values', async () => {
    const approvalExecute = jest
      .fn()
      .mockResolvedValue(
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      );
    const swapExecute = jest
      .fn()
      .mockResolvedValue(
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      );
    const waitForTransaction = jest.fn().mockResolvedValue(undefined);
    const prepareAction = jest
      .fn()
      .mockResolvedValueOnce({ execute: approvalExecute })
      .mockResolvedValueOnce({ execute: swapExecute });
    const adapter = {
      prepareAction,
      waitForTransaction,
    };
    jest
      .spyOn(executor as never, 'createCircleWalletsAdapter' as never)
      .mockResolvedValue(adapter as never);
    jest
      .spyOn(executor as never, 'getArcTestnet' as never)
      .mockResolvedValue(arcTestnet as never);
    const tokenInAddress =
      '0xcccccccccccccccccccccccccccccccccccccccc' as const;
    const treasuryAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const preparedRaw = Object.freeze({ amount: '17000000' });
    const preparedTransaction = Object.freeze({
      signature: '0x1234',
      executionParams: Object.freeze({
        instructions: [
          {
            target: '0xdddddddddddddddddddddddddddddddddddddddd',
            data: '0x5678',
            value: '0',
            tokenIn: tokenInAddress,
            amountToApprove: '17000000',
            tokenOut: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            minTokenOut: '16000000',
          },
        ],
        tokens: [
          {
            token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            beneficiary: treasuryAddress,
          },
        ],
        execId: '1',
        deadline: '2',
        metadata: '0x',
      }),
    });

    await expect(
      executor.executeTreasurySwapWithCircleWalletAdapter({
        amountIn: '16000000',
        preparedRaw,
        preparedTransaction,
        tokenInAddress,
        treasuryAddress,
      }),
    ).resolves.toEqual({
      txId: null,
      txHash:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      raw: {
        adapter: 'circle-wallets',
        adapterContract,
        approvalTxHash:
          '0x1111111111111111111111111111111111111111111111111111111111111111',
        swapTxHash:
          '0x2222222222222222222222222222222222222222222222222222222222222222',
      },
    });
    expect(prepareAction.mock.calls.map(([action]) => action)).toEqual([
      'token.approve',
      'swap.execute',
    ]);
    expect(prepareAction.mock.calls[0][1]).toEqual({
      tokenAddress: tokenInAddress,
      delegate: adapterContract,
      amount: 17000000n,
    });
    expect(waitForTransaction).toHaveBeenCalledWith(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      undefined,
      arcTestnet,
    );
    expect(approvalExecute.mock.invocationCallOrder[0]).toBeLessThan(
      swapExecute.mock.invocationCallOrder[0],
    );
    expect(preparedRaw).toEqual({ amount: '17000000' });
  });

  it('rejects a non-executable adapter response without invoking providers', async () => {
    await expect(
      executor.executeTreasurySwapWithCircleWalletAdapter({
        amountIn: '1',
        preparedRaw: { quoteId: 'synthetic-quote' },
        preparedTransaction: { raw: { unexpected: true } },
        tokenInAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        treasuryAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(createCircleWalletsAdapterMock).not.toHaveBeenCalled();
  });
});
