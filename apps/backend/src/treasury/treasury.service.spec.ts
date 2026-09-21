import { TreasuryService, TreasuryOperationPayload } from './treasury.service';

describe('TreasuryService (Mainnet fail-closed)', () => {
  let service: TreasuryService;

  const payload: TreasuryOperationPayload = {
    sourceToken: 'USDC',
    destinationToken: 'USDC',
    amount: '5000',
    minOutput: '5000',
    recipient: '0xRecipient',
    taskId: 'task-001',
  };

  beforeEach(() => {
    service = new TreasuryService();

    // Suppress logger output in tests
    jest.spyOn((service as any).logger, 'log').mockImplementation();
    jest.spyOn((service as any).logger, 'error').mockImplementation();
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    jest.spyOn((service as any).logger, 'debug').mockImplementation();
  });

  describe('executeTreasuryOperation()', () => {
    it('refuses same-token operations without moving funds', async () => {
      await expect(service.executeTreasuryOperation(payload)).rejects.toMatchObject(
        {
          response: { code: 'TREASURY_OPERATION_UNAVAILABLE' },
        },
      );
    });

    it('refuses cross-currency operations without moving funds', async () => {
      await expect(
        service.executeTreasuryOperation({
          ...payload,
          destinationToken: 'EURC',
          taskId: 'task-010',
        }),
      ).rejects.toMatchObject({
        response: { code: 'TREASURY_OPERATION_UNAVAILABLE' },
      });
    });
  });

  describe('initializeTreasury()', () => {
    it('refuses backend wallet provisioning', async () => {
      await expect(service.initializeTreasury()).rejects.toMatchObject({
        response: { code: 'TREASURY_INITIALIZATION_UNAVAILABLE' },
      });
    });
  });

  describe('getTreasuryWallet()', () => {
    it('tracks no backend treasury wallet', async () => {
      await expect(service.getTreasuryWallet('arc-mainnet')).resolves.toBeNull();
    });
  });
});
