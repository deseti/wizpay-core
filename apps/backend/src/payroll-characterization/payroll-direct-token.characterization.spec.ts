import { AnsService } from '../ans/ans.service';
import { BlockchainService } from '../adapters/blockchain.service';
import { getAddress } from 'viem';
import { PayrollBatchService } from '../agents/payroll/payroll-batch.service';
import { PayrollValidationService } from '../agents/payroll/payroll-validation.service';

describe('direct-token payroll characterization', () => {
  const alice = '0x1234567890abcdef1234567890abcdef12345678';
  const bob = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  let validationService: PayrollValidationService;
  let batchService: PayrollBatchService;

  beforeEach(() => {
    validationService = new PayrollValidationService(
      {} as BlockchainService,
      {
        resolveName: jest.fn(),
      } as unknown as AnsService,
    );
    batchService = new PayrollBatchService();
  });

  it('preserves exact six-decimal units, recipient order, and same-token amounts', async () => {
    const result = await validationService.validate({
      sourceToken: 'USDC',
      referenceId: 'direct-token-six-decimals',
      recipients: [
        { address: alice, amount: '1.000001', targetToken: 'USDC' },
        { address: bob, amount: '2.999999', targetToken: 'USDC' },
      ],
    });

    expect(result).toMatchObject({ valid: true, errors: [] });
    expect(result.recipients).toEqual([
      expect.objectContaining({
        address: getAddress(alice),
        originalAddress: alice,
        amount: '1.000001',
        amountUnits: 1000001n,
        targetToken: 'USDC',
      }),
      expect.objectContaining({
        address: getAddress(bob),
        originalAddress: bob,
        amount: '2.999999',
        amountUnits: 2999999n,
        targetToken: 'USDC',
      }),
    ]);

    const batches = batchService.splitIntoBatches(result.recipients);
    expect(batches).toHaveLength(1);
    expect(batches[0].recipients.map((recipient) => recipient.address)).toEqual(
      [getAddress(alice), getAddress(bob)],
    );
    expect(batches[0].totalAmount).toBe(4000000n);
    expect(batchService.calculateApprovalRequirement(batches[0], 'USDC')).toBe(
      0n,
    );
  });

  it('groups recipients deterministically by first-seen target token', async () => {
    const result = await validationService.validate({
      sourceToken: 'USDC',
      recipients: [
        { address: alice, amount: '1', targetToken: 'USDC' },
        { address: bob, amount: '2', targetToken: 'EURC' },
        { address: alice, amount: '3', targetToken: 'USDC' },
      ],
    });
    const batches = batchService.splitIntoBatches(result.recipients);

    expect(
      batches.map((batch) => batch.recipients.map((r) => r.targetToken)),
    ).toEqual([['USDC', 'USDC'], ['EURC']]);
    expect(batches.map((batch) => batch.totalAmount)).toEqual([
      4000000n,
      2000000n,
    ]);
    expect(batchService.calculateApprovalRequirement(batches[0], 'USDC')).toBe(
      0n,
    );
    expect(batchService.calculateApprovalRequirement(batches[1], 'USDC')).toBe(
      2000000n,
    );
  });

  it('temporarily truncates precision beyond six decimals', async () => {
    const result = await validationService.validate({
      sourceToken: 'USDC',
      recipients: [
        { address: alice, amount: '1.0000019', targetToken: 'USDC' },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.recipients[0].amountUnits).toBe(1000001n);
  });
});
