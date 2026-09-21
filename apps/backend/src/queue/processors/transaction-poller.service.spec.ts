import { TransactionPollerService } from './transaction-poller.service';

const TX_HASH = `0x${'a'.repeat(64)}`;

describe('TransactionPollerService Mainnet receipt boundary', () => {
  const blockchain = { getTransactionReceiptOnChain: jest.fn() };
  const tasks = {
    getTaskTransactions: jest.fn(),
    updateTransaction: jest.fn(),
    logStep: jest.fn(),
    hasLogStep: jest.fn().mockResolvedValue(false),
    getTransactionAggregation: jest.fn(),
    updateStatus: jest.fn(),
  };
  const queue = { enqueueTransactionPoll: jest.fn() };
  let service: TransactionPollerService;

  beforeEach(() => {
    jest.clearAllMocks();
    tasks.hasLogStep.mockResolvedValue(false);
    blockchain.getTransactionReceiptOnChain.mockResolvedValue(null);
    service = new TransactionPollerService(
      blockchain as never,
      tasks as never,
      queue as never,
    );
  });

  it('re-enqueues while no Mainnet receipt is available', async () => {
    blockchain.getTransactionReceiptOnChain.mockResolvedValue(null);

    await service.poll({
      network: 'arc-mainnet',
      taskId: 'task',
      txId: TX_HASH,
      attempt: 3,
    });

    expect(blockchain.getTransactionReceiptOnChain).toHaveBeenCalledWith(
      TX_HASH,
      'ARC-MAINNET',
    );
    expect(tasks.updateTransaction).toHaveBeenCalledWith(TX_HASH, {
      status: 'pending',
      pollAttempts: 4,
    });
    expect(tasks.updateTransaction).not.toHaveBeenCalledWith(
      TX_HASH,
      expect.objectContaining({ status: 'completed' }),
    );
    expect(queue.enqueueTransactionPoll).toHaveBeenCalledWith(
      {
        network: 'arc-mainnet',
        taskId: 'task',
        txId: TX_HASH,
        attempt: 4,
      },
      2000,
    );
  });

  it('completes on a successful Mainnet receipt', async () => {
    blockchain.getTransactionReceiptOnChain.mockResolvedValue({
      transactionHash: TX_HASH,
      blockNumber: '0x1234',
      status: '0x1',
      logs: [],
    });

    await service.poll({
      network: 'arc-mainnet',
      taskId: 'task',
      txId: TX_HASH,
      attempt: 1,
    });

    expect(tasks.updateTransaction).toHaveBeenCalledWith(TX_HASH, {
      status: 'completed',
      txHash: TX_HASH,
      pollAttempts: 2,
    });
    expect(tasks.logStep).toHaveBeenCalledWith(
      'task',
      'tx.completed',
      expect.anything(),
      expect.anything(),
    );
  });

  it('fails on a reverted Mainnet receipt', async () => {
    blockchain.getTransactionReceiptOnChain.mockResolvedValue({
      transactionHash: TX_HASH,
      blockNumber: '0x1234',
      status: '0x0',
      logs: [],
    });

    await service.poll({
      network: 'arc-mainnet',
      taskId: 'task',
      txId: TX_HASH,
      attempt: 1,
    });

    expect(tasks.updateTransaction).toHaveBeenCalledWith(
      TX_HASH,
      expect.objectContaining({ status: 'failed' }),
    );
    expect(tasks.updateTransaction).not.toHaveBeenCalledWith(
      TX_HASH,
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('re-enqueues on transient read errors', async () => {
    blockchain.getTransactionReceiptOnChain.mockRejectedValue(
      new Error('RPC timeout'),
    );

    await service.poll({
      network: 'arc-mainnet',
      taskId: 'task',
      txId: TX_HASH,
      attempt: 0,
    });

    expect(tasks.updateTransaction).toHaveBeenCalledWith(TX_HASH, {
      status: 'pending',
      pollAttempts: 1,
    });
    expect(queue.enqueueTransactionPoll).toHaveBeenCalled();
  });

  it('fails closed for non-Mainnet job networks', async () => {
    await service.poll({
      network: 'arc-legacy' as never,
      taskId: 'task',
      txId: TX_HASH,
      attempt: 0,
    });

    expect(blockchain.getTransactionReceiptOnChain).not.toHaveBeenCalled();
    expect(tasks.updateTransaction).toHaveBeenCalledWith(
      TX_HASH,
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('marks timeout after max attempts without a receipt', async () => {
    blockchain.getTransactionReceiptOnChain.mockResolvedValue(null);

    await service.poll({
      network: 'arc-mainnet',
      taskId: 'task',
      txId: TX_HASH,
      attempt: 180,
    });

    expect(tasks.updateTransaction).toHaveBeenCalledWith(
      TX_HASH,
      expect.objectContaining({ status: 'failed' }),
    );
    expect(queue.enqueueTransactionPoll).not.toHaveBeenCalled();
  });
});
