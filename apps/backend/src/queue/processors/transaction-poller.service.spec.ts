import { ConfigService } from '@nestjs/config';
import { CircleReceiptVerificationError } from '../../adapters/circle/circle-receipt-verifier.service';
import { TransactionPollerService } from './transaction-poller.service';

const TX_HASH = `0x${'a'.repeat(64)}`;
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const SENDER = '0x1111111111111111111111111111111111111111';

describe('TransactionPollerService Circle receipt boundary', () => {
  const circle = { getTransactionStatus: jest.fn() };
  const tasks = {
    getTaskTransactions: jest.fn(),
    updateTransaction: jest.fn(),
    logStep: jest.fn(),
    hasLogStep: jest.fn().mockResolvedValue(false),
    getTransactionAggregation: jest.fn(),
    updateStatus: jest.fn(),
  };
  const queue = { enqueueTransactionPoll: jest.fn() };
  const verifier = { verifyTransfer: jest.fn() };
  const arcNetwork = {
    tokens: {
      USDC: {
        address: '0x3600000000000000000000000000000000000000',
        decimals: 6,
      },
    },
  };
  const config = {
    getOrThrow: jest.fn().mockReturnValue(arcNetwork),
  } as unknown as ConfigService;
  let service: TransactionPollerService;

  beforeEach(() => {
    jest.clearAllMocks();
    tasks.hasLogStep.mockResolvedValue(false);
    tasks.getTaskTransactions.mockResolvedValue([
      {
        txId: 'circle-tx',
        recipient: RECIPIENT,
        amount: '1.25',
        currency: 'USDC',
      },
    ]);
    circle.getTransactionStatus.mockResolvedValue({
      status: 'COMPLETE',
      txHash: TX_HASH,
      blockchain: 'ARC-TESTNET',
      sourceAddress: SENDER,
    });
    verifier.verifyTransfer.mockResolvedValue(undefined);
    service = new TransactionPollerService(
      circle as never,
      tasks as never,
      queue as never,
      verifier as never,
      config,
    );
  });

  it('does not complete Circle COMPLETE without a transaction hash', async () => {
    circle.getTransactionStatus.mockResolvedValue({
      status: 'COMPLETE',
      txHash: null,
      blockchain: 'ARC-TESTNET',
      sourceAddress: SENDER,
    });

    await service.poll({
      network: 'arc-testnet',
      taskId: 'task',
      txId: 'circle-tx',
      attempt: 3,
    });

    expect(verifier.verifyTransfer).not.toHaveBeenCalled();
    expect(tasks.updateTransaction).toHaveBeenCalledWith('circle-tx', {
      status: 'pending',
      pollAttempts: 4,
    });
    expect(tasks.updateTransaction).not.toHaveBeenCalledWith(
      'circle-tx',
      expect.objectContaining({ status: 'completed' }),
    );
    expect(queue.enqueueTransactionPoll).toHaveBeenCalled();
  });

  it('does not complete while the selected-chain receipt is unavailable', async () => {
    verifier.verifyTransfer.mockRejectedValue(
      new CircleReceiptVerificationError('Receipt unavailable.', true),
    );

    await service.poll({
      network: 'arc-testnet',
      taskId: 'task',
      txId: 'circle-tx',
      attempt: 0,
    });

    expect(tasks.updateTransaction).not.toHaveBeenCalledWith(
      'circle-tx',
      expect.objectContaining({ status: 'completed' }),
    );
    expect(queue.enqueueTransactionPoll).toHaveBeenCalledWith(
      {
        network: 'arc-testnet',
        taskId: 'task',
        txId: 'circle-tx',
        attempt: 1,
      },
      2000,
    );
  });

  it('fails permanently invalid receipts without completing', async () => {
    verifier.verifyTransfer.mockRejectedValue(
      new CircleReceiptVerificationError('Wrong recipient.', false),
    );

    await service.poll({
      network: 'arc-testnet',
      taskId: 'task',
      txId: 'circle-tx',
      attempt: 0,
    });

    expect(tasks.updateTransaction).toHaveBeenCalledWith(
      'circle-tx',
      expect.objectContaining({
        status: 'failed',
        errorReason: 'Circle transaction receipt verification failed.',
      }),
    );
    expect(tasks.updateTransaction).not.toHaveBeenCalledWith(
      'circle-tx',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('completes only after exact receipt verification', async () => {
    await service.poll({
      network: 'arc-testnet',
      taskId: 'task',
      txId: 'circle-tx',
      attempt: 1,
    });

    expect(verifier.verifyTransfer).toHaveBeenCalledWith({
      transactionHash: TX_HASH,
      senderAddress: SENDER,
      recipientAddress: RECIPIENT,
      tokenAddress: '0x3600000000000000000000000000000000000000',
      amountUnits: 1_250_000n,
      circleBlockchain: 'ARC-TESTNET',
    });
    expect(tasks.updateTransaction).toHaveBeenCalledWith('circle-tx', {
      status: 'completed',
      txHash: TX_HASH,
      pollAttempts: 2,
    });
  });
});
