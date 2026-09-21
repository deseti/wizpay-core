import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PayrollAgent } from './payroll.agent';
import { TaskService } from '../../task/task.service';
import { TaskStatus } from '../../task/task-status.enum';
import { TaskType } from '../../task/task-type.enum';
import { TaskDetails } from '../../task/task.types';
import { PayrollValidationService } from './payroll-validation.service';

describe('PayrollAgent', () => {
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
    totalUnits: 0,
    completedUnits: 0,
    failedUnits: 0,
    metadata: null,
    createdAt: new Date('2026-04-26T00:00:00.000Z'),
    updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    logs: [],
    units: [],
    transactions: [],
  };

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

  let payrollAgent: PayrollAgent;

  beforeEach(() => {
    payrollAgent = new PayrollAgent(
      taskService as unknown as TaskService,
      validationService as unknown as PayrollValidationService,
    );
    jest.clearAllMocks();
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
    expect(validationService.validate).not.toHaveBeenCalled();
  });

  it('throws when validation fails', async () => {
    (validationService.validate as jest.Mock).mockResolvedValue({
      valid: false,
      recipients: [],
      errors: ['recipients must be a non-empty array'],
    });

    const badTask: TaskDetails = { ...taskFixture, payload: {} };

    await expect(payrollAgent.execute(badTask)).rejects.toThrow(
      'Payroll validation failed',
    );
    await expect(payrollAgent.execute(badTask)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('fails closed for valid Mainnet direct payroll instead of submitting', async () => {
    (validationService.validate as jest.Mock).mockResolvedValue({
      valid: true,
      recipients: [
        { address: '0x1234567890abcdef1234567890abcdef12345678', amount: '100', amountUnits: 100000000n, targetToken: 'USDC', targetTokenAddress: '0x3600000000000000000000000000000000000000' },
      ],
      errors: [],
    });

    await expect(payrollAgent.execute(taskFixture)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'PAYROLL_BACKEND_SUBMISSION_UNAVAILABLE',
      }),
    });
    await expect(payrollAgent.execute(taskFixture)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(taskService.logStep).toHaveBeenCalledWith(
      taskFixture.id,
      'payroll.validated',
      TaskStatus.IN_PROGRESS,
      expect.stringContaining('Validated 1 recipients'),
    );
    expect(taskService.appendTransaction).not.toHaveBeenCalled();
  });
});
