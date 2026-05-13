import {
  LpWindDownService,
  DepositorInfo,
  PoolLedgerEntry,
  TransferFn,
  WIND_DOWN_WINDOW_MS,
} from './lp-wind-down.service';

describe('LpWindDownService', () => {
  let service: LpWindDownService;
  let mockTransferFn: jest.Mock<ReturnType<TransferFn>, Parameters<TransferFn>>;
  let mockNotifyFn: jest.Mock;

  beforeEach(() => {
    service = new LpWindDownService();
    mockTransferFn = jest.fn().mockResolvedValue(true);
    mockNotifyFn = jest.fn().mockResolvedValue(undefined);
    service.setTransferFn(mockTransferFn);
    service.setNotifyFn(mockNotifyFn);
  });

  describe('initiateWindDown()', () => {
    it('calculates pro-rata shares correctly for single depositor', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];

      await service.initiateWindDown(depositors, poolLedger, '100');

      const status = await service.getWindDownStatus();
      expect(status.initiated).toBe(true);
      expect(status.depositors[0].proRataAmount).toBe('1000');
      expect(status.depositors[0].address).toBe('0xAlice');
      expect(status.depositors[0].token).toBe('USDC');
    });

    it('calculates pro-rata shares correctly for multiple depositors', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '50' },
        { address: '0xBob', token: 'USDC', shares: '30' },
        { address: '0xCharlie', token: 'USDC', shares: '20' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];

      await service.initiateWindDown(depositors, poolLedger, '100');

      const status = await service.getWindDownStatus();
      // Alice: 50/100 * 1000 = 500
      expect(status.depositors[0].proRataAmount).toBe('500');
      // Bob: 30/100 * 1000 = 300
      expect(status.depositors[1].proRataAmount).toBe('300');
      // Charlie: 20/100 * 1000 = 200
      expect(status.depositors[2].proRataAmount).toBe('200');
    });

    it('calculates pro-rata shares for multiple tokens', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '60' },
        { address: '0xBob', token: 'EURC', shares: '40' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '2000' },
        { token: 'EURC', balance: '500' },
      ];

      await service.initiateWindDown(depositors, poolLedger, '100');

      const status = await service.getWindDownStatus();
      // Alice: 60/100 * 2000 = 1200
      expect(status.depositors[0].proRataAmount).toBe('1200');
      // Bob: 40/100 * 500 = 200
      expect(status.depositors[1].proRataAmount).toBe('200');
    });

    it('sets withdrawal window to at least 7 days from initiation', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];

      const before = Date.now();
      await service.initiateWindDown(depositors, poolLedger, '100');
      const after = Date.now();

      const status = await service.getWindDownStatus();
      const windowEnd = new Date(status.withdrawalWindowEnd!).getTime();
      const initiatedAt = new Date(status.initiatedAt!).getTime();

      // Window must be at least 7 days
      expect(windowEnd - initiatedAt).toBe(WIND_DOWN_WINDOW_MS);
      // initiatedAt should be between before and after
      expect(initiatedAt).toBeGreaterThanOrEqual(before);
      expect(initiatedAt).toBeLessThanOrEqual(after);
    });

    it('notifies all depositors', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '50' },
        { address: '0xBob', token: 'EURC', shares: '50' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
        { token: 'EURC', balance: '800' },
      ];

      await service.initiateWindDown(depositors, poolLedger, '100');

      expect(mockNotifyFn).toHaveBeenCalledTimes(2);
      expect(mockNotifyFn).toHaveBeenCalledWith(
        '0xAlice',
        'USDC',
        '500',
        expect.any(String),
      );
      expect(mockNotifyFn).toHaveBeenCalledWith(
        '0xBob',
        'EURC',
        '400',
        expect.any(String),
      );
    });

    it('throws if wind-down already initiated', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];

      await service.initiateWindDown(depositors, poolLedger, '100');

      await expect(
        service.initiateWindDown(depositors, poolLedger, '100'),
      ).rejects.toThrow('Wind-down already initiated');
    });

    it('throws if totalSupply is zero', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];

      await expect(
        service.initiateWindDown(depositors, poolLedger, '0'),
      ).rejects.toThrow('Invalid totalSupply');
    });

    it('throws if totalSupply is negative', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];

      await expect(
        service.initiateWindDown(depositors, poolLedger, '-10'),
      ).rejects.toThrow('Invalid totalSupply');
    });

    it('stores totalSupplyAtStart and currentTotalSupply', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];

      await service.initiateWindDown(depositors, poolLedger, '250');

      const status = await service.getWindDownStatus();
      expect(status.totalSupplyAtStart).toBe('250');
      expect(status.currentTotalSupply).toBe('250');
    });
  });

  describe('executeWithdrawal()', () => {
    beforeEach(async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '60' },
        { address: '0xBob', token: 'USDC', shares: '40' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];
      await service.initiateWindDown(depositors, poolLedger, '100');
    });

    it('transfers pro-rata amount and reduces totalSupply', async () => {
      await service.executeWithdrawal('0xAlice', 'USDC');

      expect(mockTransferFn).toHaveBeenCalledWith('0xAlice', 'USDC', '600');

      const status = await service.getWindDownStatus();
      expect(status.currentTotalSupply).toBe('40');
      expect(status.depositors[0].withdrawn).toBe(true);
    });

    it('marks wind-down complete when all depositors withdraw', async () => {
      await service.executeWithdrawal('0xAlice', 'USDC');
      expect(service.isWindDownComplete()).toBe(false);

      await service.executeWithdrawal('0xBob', 'USDC');
      expect(service.isWindDownComplete()).toBe(true);

      const status = await service.getWindDownStatus();
      expect(status.complete).toBe(true);
      expect(status.currentTotalSupply).toBe('0');
    });

    it('throws if wind-down not initiated', async () => {
      const freshService = new LpWindDownService();
      freshService.setTransferFn(mockTransferFn);

      await expect(
        freshService.executeWithdrawal('0xAlice', 'USDC'),
      ).rejects.toThrow('Wind-down has not been initiated');
    });

    it('throws if depositor not found', async () => {
      await expect(
        service.executeWithdrawal('0xUnknown', 'USDC'),
      ).rejects.toThrow('not found in wind-down state');
    });

    it('throws if depositor already withdrawn', async () => {
      await service.executeWithdrawal('0xAlice', 'USDC');

      await expect(
        service.executeWithdrawal('0xAlice', 'USDC'),
      ).rejects.toThrow('already withdrawn');
    });
  });

  describe('individual withdrawal failure halts sequence', () => {
    beforeEach(async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '50' },
        { address: '0xBob', token: 'USDC', shares: '50' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];
      await service.initiateWindDown(depositors, poolLedger, '100');
    });

    it('halts entire sequence on transfer failure', async () => {
      mockTransferFn.mockRejectedValueOnce(new Error('Insufficient balance'));

      await expect(
        service.executeWithdrawal('0xAlice', 'USDC'),
      ).rejects.toThrow('Wind-down halted');

      expect(service.isHalted()).toBe(true);
    });

    it('emits diagnostic event on failure', async () => {
      mockTransferFn.mockRejectedValueOnce(new Error('Transfer reverted'));

      await expect(
        service.executeWithdrawal('0xAlice', 'USDC'),
      ).rejects.toThrow();

      const events = service.getDiagnosticEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('withdrawal_failure');
      expect(events[0].depositor).toBe('0xAlice');
      expect(events[0].token).toBe('USDC');
      expect(events[0].reason).toContain('Transfer reverted');
    });

    it('blocks subsequent withdrawals after failure', async () => {
      mockTransferFn.mockRejectedValueOnce(new Error('Transfer failed'));

      await expect(
        service.executeWithdrawal('0xAlice', 'USDC'),
      ).rejects.toThrow();

      // Bob's withdrawal should be blocked
      await expect(
        service.executeWithdrawal('0xBob', 'USDC'),
      ).rejects.toThrow('halted due to a previous withdrawal failure');
    });

    it('halts when transfer returns false', async () => {
      mockTransferFn.mockResolvedValueOnce(false);

      await expect(
        service.executeWithdrawal('0xAlice', 'USDC'),
      ).rejects.toThrow('Wind-down halted');

      expect(service.isHalted()).toBe(true);
    });

    it('records failure reason on the depositor entry', async () => {
      mockTransferFn.mockRejectedValueOnce(
        new Error('ERC20: transfer amount exceeds balance'),
      );

      await expect(
        service.executeWithdrawal('0xAlice', 'USDC'),
      ).rejects.toThrow();

      const status = await service.getWindDownStatus();
      const alice = status.depositors.find((d) => d.address === '0xAlice');
      expect(alice?.failureReason).toContain(
        'ERC20: transfer amount exceeds balance',
      );
    });
  });

  describe('deprecation blocked when residual deposits exist', () => {
    it('blocks deprecation when currentTotalSupply > 0', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '50' },
        { address: '0xBob', token: 'USDC', shares: '50' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];
      await service.initiateWindDown(depositors, poolLedger, '100');

      // Only Alice withdraws
      await service.executeWithdrawal('0xAlice', 'USDC');

      expect(service.canDeprecateContract()).toBe(false);
    });

    it('blocks deprecation when wind-down is halted', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];
      await service.initiateWindDown(depositors, poolLedger, '100');

      mockTransferFn.mockRejectedValueOnce(new Error('Transfer failed'));
      await expect(
        service.executeWithdrawal('0xAlice', 'USDC'),
      ).rejects.toThrow();

      expect(service.canDeprecateContract()).toBe(false);
    });

    it('allows deprecation when all deposits withdrawn (totalSupply == 0)', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];
      await service.initiateWindDown(depositors, poolLedger, '100');

      await service.executeWithdrawal('0xAlice', 'USDC');

      expect(service.canDeprecateContract()).toBe(true);
    });

    it('blocks deprecation when wind-down not initiated', () => {
      const freshService = new LpWindDownService();
      expect(freshService.canDeprecateContract()).toBe(false);
    });
  });

  describe('isWindDownComplete()', () => {
    it('returns false when wind-down not initiated', () => {
      expect(service.isWindDownComplete()).toBe(false);
    });

    it('returns false when currentTotalSupply > 0', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];
      await service.initiateWindDown(depositors, poolLedger, '100');

      expect(service.isWindDownComplete()).toBe(false);
    });

    it('returns true when currentTotalSupply == 0', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '1000' },
      ];
      await service.initiateWindDown(depositors, poolLedger, '100');
      await service.executeWithdrawal('0xAlice', 'USDC');

      expect(service.isWindDownComplete()).toBe(true);
    });
  });

  describe('getWindDownStatus()', () => {
    it('returns initial state before initiation', async () => {
      const status = await service.getWindDownStatus();

      expect(status.initiated).toBe(false);
      expect(status.depositors).toEqual([]);
      expect(status.totalSupplyAtStart).toBe('0');
      expect(status.currentTotalSupply).toBe('0');
      expect(status.complete).toBe(false);
    });

    it('returns full state after initiation', async () => {
      const depositors: DepositorInfo[] = [
        { address: '0xAlice', token: 'USDC', shares: '100' },
      ];
      const poolLedger: PoolLedgerEntry[] = [
        { token: 'USDC', balance: '500' },
      ];
      await service.initiateWindDown(depositors, poolLedger, '100');

      const status = await service.getWindDownStatus();

      expect(status.initiated).toBe(true);
      expect(status.initiatedAt).toBeDefined();
      expect(status.withdrawalWindowEnd).toBeDefined();
      expect(status.depositors).toHaveLength(1);
      expect(status.totalSupplyAtStart).toBe('100');
      expect(status.currentTotalSupply).toBe('100');
      expect(status.complete).toBe(false);
    });
  });
});
