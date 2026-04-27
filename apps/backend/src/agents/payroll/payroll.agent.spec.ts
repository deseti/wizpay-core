import { BadRequestException } from '@nestjs/common';
import { PayrollAgent } from './payroll.agent';
import { CircleService } from '../../adapters/circle.service';
import { TaskService } from '../../task/task.service';
import { TaskStatus } from '../../task/task-status.enum';
import { TaskType } from '../../task/task-type.enum';
import { TaskDetails } from '../../task/task.types';
import { PayrollValidationService } from './payroll-validation.service';
import { PayrollBatchService } from './payroll-batch.service';
import { QueueService } from '../../queue/queue.service';

describe('PayrollAgent', () => {
  const UUID_V4_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const taskFixture: TaskDetails = {
    id: 'c7e01b44-0569-466d-b521-b4302fdd49d0',
    type: TaskType.PAYROLL,
    status: TaskStatus.IN_PROGRESS,
    payload: {
      sourceToken: 'USDC',
      recipients: [
        {
          address: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '100',
          targetToken: 'USDC',
        },
        {
          address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          amount: '50',
          targetToken: 'USDC',
        },
      ],
    },
    result: null,
    createdAt: new Date('2026-04-26T00:00:00.000Z'),
    updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    logs: [],
    transactions: [],
  };

  const circleService = {
    transfer: jest.fn(),
    getTransactionStatus: jest.fn(),
    getQuote: jest.fn(),
    executeTrade: jest.fn(),
    getTradeStatus: jest.fn(),
  } as unknown as jest.Mocked<CircleService>;

  const taskService = {
    updateStatus: jest.fn(),
    logStep: jest.fn(),
    appendTransaction: jest.fn(),
    updateTransaction: jest.fn(),
    getTaskTransactions: jest.fn(),
    getTransactionAggregation: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<
      TaskService,
      | 'updateStatus'
      | 'logStep'
      | 'appendTransaction'
      | 'updateTransaction'
      | 'getTaskTransactions'
      | 'getTransactionAggregation'
    >
  >;

  const validationService = {
    validate: jest.fn(),
    checkBalance: jest.fn(),
  } as unknown as jest.Mocked<PayrollValidationService>;

  const batchService = {
    splitIntoBatches: jest.fn(),
    calculateTotals: jest.fn(),
    calculateApprovalRequirement: jest.fn(),
  } as unknown as jest.Mocked<PayrollBatchService>;

  const queueService = {
    enqueueTransactionPoll: jest.fn(),
  } as unknown as jest.Mocked<Pick<QueueService, 'enqueueTransactionPoll'>>;

  let payrollAgent: PayrollAgent;

  beforeEach(() => {
    payrollAgent = new PayrollAgent(
      circleService as unknown as CircleService,
      taskService as unknown as TaskService,
      validationService as unknown as PayrollValidationService,
      batchService as unknown as PayrollBatchService,
      queueService as unknown as QueueService,
    );
    jest.clearAllMocks();
  });

  it('submits transfers non-blocking and enqueues poll jobs', async () => {
    validationService.validate.mockResolvedValue({
      valid: true,
      recipients: [
        { address: '0x1234567890abcdef1234567890abcdef12345678', amount: '100', amountUnits: 100000000n, targetToken: 'USDC' },
        { address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', amount: '50', amountUnits: 50000000n, targetToken: 'USDC' },
      ],
      errors: [],
    });

    batchService.splitIntoBatches.mockReturnValue([
      {
        index: 0,
        recipients: [
          { address: '0x1234567890abcdef1234567890abcdef12345678', amount: '100', amountUnits: 100000000n, targetToken: 'USDC' },
          { address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', amount: '50', amountUnits: 50000000n, targetToken: 'USDC' },
        ],
        totalAmount: 150000000n,
      },
    ]);

    batchService.calculateTotals.mockReturnValue({
      totalAmount: 150000000n,
      totalRecipients: 2,
      totalBatches: 1,
      batchBreakdown: [{ index: 0, recipientCount: 2, amount: 150000000n }],
    });

    circleService.transfer
      .mockResolvedValueOnce({ txId: 'tx_1', status: 'INITIATED', txHash: null })
      .mockResolvedValueOnce({ txId: 'tx_2', status: 'INITIATED', txHash: null });

    taskService.appendTransaction.mockResolvedValue({
      id: 'mock-id',
      taskId: taskFixture.id,
      txId: 'tx_1',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      amount: '100',
      currency: 'USDC',
      status: 'pending',
      txHash: null,
      errorReason: null,
      batchIndex: 0,
      pollAttempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await payrollAgent.execute(taskFixture);

    // ── Non-blocking: agent does NOT call waitForTransactionComplete ──
    expect(result).toMatchObject({
      agent: 'payroll',
      sourceToken: 'USDC',
      totalBatches: 1,
      totalRecipients: 2,
      submitted: 2,
      submitFailed: 0,
      awaitingConfirmation: 2,
    });

    // ── Verify real CircleService.transfer() calls ──
    expect(circleService.transfer).toHaveBeenCalledTimes(2);
    expect(circleService.transfer.mock.calls[0][0].idempotencyKey).toMatch(
      UUID_V4_REGEX,
    );
    expect(circleService.transfer.mock.calls[1][0].idempotencyKey).toMatch(
      UUID_V4_REGEX,
    );
    expect(circleService.transfer.mock.calls[0][0].idempotencyKey).not.toBe(
      circleService.transfer.mock.calls[1][0].idempotencyKey,
    );

    // ── Verify transaction persistence ──
    expect(taskService.appendTransaction).toHaveBeenCalledTimes(2);

    // ── Verify poll jobs enqueued ──
    expect(queueService.enqueueTransactionPoll).toHaveBeenCalledTimes(2);
    expect(queueService.enqueueTransactionPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: taskFixture.id,
        txId: 'tx_1',
        attempt: 0,
      }),
      2000,
    );
    expect(queueService.enqueueTransactionPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: taskFixture.id,
        txId: 'tx_2',
        attempt: 0,
      }),
      2000,
    );

    // ── Agent does NOT call updateStatus ──
    expect(taskService.updateStatus).not.toHaveBeenCalled();
  });

  it('returns existing result for idempotent re-execution', async () => {
    const prevResult = {
      agent: 'payroll',
      sourceToken: 'USDC',
      totalBatches: 1,
      totalRecipients: 1,
      submitted: 1,
      submitFailed: 0,
      awaitingConfirmation: 1,
      submissions: [],
    };

    const idempotentTask: TaskDetails = {
      ...taskFixture,
      result: prevResult,
    };

    const result = await payrollAgent.execute(idempotentTask);

    expect(result).toEqual(prevResult);
    expect(circleService.transfer).not.toHaveBeenCalled();
    expect(validationService.validate).not.toHaveBeenCalled();
  });

  it('throws when validation fails', async () => {
    validationService.validate.mockResolvedValue({
      valid: false,
      recipients: [],
      errors: ['recipients must be a non-empty array'],
    });

    const badTask: TaskDetails = { ...taskFixture, payload: {} };

    await expect(payrollAgent.execute(badTask)).rejects.toThrow(
      'Payroll validation failed',
    );
  });

  it('handles submission failures gracefully', async () => {
    validationService.validate.mockResolvedValue({
      valid: true,
      recipients: [
        { address: '0x1234567890abcdef1234567890abcdef12345678', amount: '100', amountUnits: 100000000n, targetToken: 'USDC' },
        { address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', amount: '50', amountUnits: 50000000n, targetToken: 'USDC' },
      ],
      errors: [],
    });

    batchService.splitIntoBatches.mockReturnValue([
      {
        index: 0,
        recipients: [
          { address: '0x1234567890abcdef1234567890abcdef12345678', amount: '100', amountUnits: 100000000n, targetToken: 'USDC' },
          { address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', amount: '50', amountUnits: 50000000n, targetToken: 'USDC' },
        ],
        totalAmount: 150000000n,
      },
    ]);

    batchService.calculateTotals.mockReturnValue({
      totalAmount: 150000000n,
      totalRecipients: 2,
      totalBatches: 1,
      batchBreakdown: [{ index: 0, recipientCount: 2, amount: 150000000n }],
    });

    // First transfer succeeds, second fails at submission
    circleService.transfer
      .mockResolvedValueOnce({ txId: 'tx_1', status: 'INITIATED', txHash: null })
      .mockRejectedValueOnce(new Error('insufficient balance'));

    taskService.appendTransaction.mockResolvedValue({
      id: 'mock-id',
      taskId: taskFixture.id,
      txId: 'tx_1',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      amount: '100',
      currency: 'USDC',
      status: 'pending',
      txHash: null,
      errorReason: null,
      batchIndex: 0,
      pollAttempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await payrollAgent.execute(taskFixture);

    expect(result).toMatchObject({
      agent: 'payroll',
      submitted: 1,
      submitFailed: 1,
    });

    // Only 1 poll job enqueued (for the successful submission)
    expect(queueService.enqueueTransactionPoll).toHaveBeenCalledTimes(1);

    // Failed submission recorded in DB
    expect(taskService.updateTransaction).toHaveBeenCalledWith(
      expect.stringContaining('failed_'),
      expect.objectContaining({
        status: 'failed',
        errorReason: 'insufficient balance',
      }),
    );
  });

  it('throws when all submissions fail', async () => {
    validationService.validate.mockResolvedValue({
      valid: true,
      recipients: [
        { address: '0x1234567890abcdef1234567890abcdef12345678', amount: '100', amountUnits: 100000000n, targetToken: 'USDC' },
      ],
      errors: [],
    });

    batchService.splitIntoBatches.mockReturnValue([
      {
        index: 0,
        recipients: [
          { address: '0x1234567890abcdef1234567890abcdef12345678', amount: '100', amountUnits: 100000000n, targetToken: 'USDC' },
        ],
        totalAmount: 100000000n,
      },
    ]);

    batchService.calculateTotals.mockReturnValue({
      totalAmount: 100000000n,
      totalRecipients: 1,
      totalBatches: 1,
      batchBreakdown: [{ index: 0, recipientCount: 1, amount: 100000000n }],
    });

    circleService.transfer.mockRejectedValue(new Error('API error'));

    taskService.appendTransaction.mockResolvedValue({
      id: 'mock-id',
      taskId: taskFixture.id,
      txId: 'failed_key',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      amount: '100',
      currency: 'USDC',
      status: 'failed',
      txHash: null,
      errorReason: 'API error',
      batchIndex: 0,
      pollAttempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(payrollAgent.execute(taskFixture)).rejects.toThrow(
      'All 1 transfer submissions failed',
    );
  });

  it('passes the requested network through to Circle transfers', async () => {
    validationService.validate.mockResolvedValue({
      valid: true,
      recipients: [
        {
          address: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '100',
          amountUnits: 100000000n,
          targetToken: 'USDC',
        },
      ],
      errors: [],
    });

    batchService.splitIntoBatches.mockReturnValue([
      {
        index: 0,
        recipients: [
          {
            address: '0x1234567890abcdef1234567890abcdef12345678',
            amount: '100',
            amountUnits: 100000000n,
            targetToken: 'USDC',
          },
        ],
        totalAmount: 100000000n,
      },
    ]);

    batchService.calculateTotals.mockReturnValue({
      totalAmount: 100000000n,
      totalRecipients: 1,
      totalBatches: 1,
      batchBreakdown: [{ index: 0, recipientCount: 1, amount: 100000000n }],
    });

    circleService.transfer.mockResolvedValueOnce({
      txId: 'tx_1',
      status: 'INITIATED',
      txHash: null,
    });

    taskService.appendTransaction.mockResolvedValue({
      id: 'mock-id',
      taskId: taskFixture.id,
      txId: 'tx_1',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      amount: '100',
      currency: 'USDC',
      status: 'pending',
      txHash: null,
      errorReason: null,
      batchIndex: 0,
      pollAttempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await payrollAgent.execute({
      ...taskFixture,
      payload: {
        ...taskFixture.payload,
        network: 'arc-testnet',
      },
    });

    expect(circleService.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        network: 'arc-testnet',
      }),
    );
  });
});