import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PayrollFxExecutionLeaseRepository } from './payroll-fx-execution-lease.repository';
import { PayrollFxOperationRepository } from './payroll-fx-operation.repository';

const databaseUrl = process.env.PAYROLL_FX_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('Payroll FX execution lease PostgreSQL integration', () => {
  let prisma: PrismaClient;
  let operations: PayrollFxOperationRepository;
  let leases: PayrollFxExecutionLeaseRepository;
  let sequence = 0;

  beforeAll(() => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl! }),
    });
    operations = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );
    leases = new PayrollFxExecutionLeaseRepository(
      prisma as unknown as PrismaService,
    );
  });

  beforeEach(async () => {
    await prisma.payrollFxOperation.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createOperation() {
    sequence += 1;
    return operations.create({
      idempotencyKey: `lease-${sequence}`,
      walletMode: 'app',
      executionProvider: 'stablefx',
      sourceTokenAddress: '0x3600000000000000000000000000000000000000',
      destinationTokenAddress: '0x3600000000000000000000000000000000000001',
      sourceTokenSymbol: 'USDC',
      destinationTokenSymbol: 'EURC',
      network: 'ARC-TESTNET',
      sourceWalletAddress: '0x1111111111111111111111111111111111111111',
      treasuryWalletAddress: '0x2222222222222222222222222222222222222222',
      amountInBaseUnits: '30000000',
      requestedMinimumOutputBaseUnits: null,
    });
  }

  it('produces one winner under concurrent acquisition', async () => {
    const operation = await createOperation();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        leases.acquire(operation.operationId, 60_000),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      (await operations.findById(operation.operationId))?.executionAttemptCount,
    ).toBe(1);
  });

  it('reclaims an expired process-death lease and fences the stale owner', async () => {
    const operation = await createOperation();
    const stale = await leases.acquire(operation.operationId, 60_000, 'stale');
    await prisma.payrollFxOperation.update({
      where: { operationId: operation.operationId },
      data: { executionLeaseExpiresAt: new Date(Date.now() - 1) },
    });
    const current = await leases.acquire(
      operation.operationId,
      60_000,
      'current',
    );

    expect(current?.leaseId).toBe('current');
    await expect(leases.renew(stale!, 60_000)).resolves.toBeNull();
    await expect(leases.release(stale!)).resolves.toBe(false);
    await expect(
      operations.markQuotePending(operation.operationId, {
        leaseId: stale!.leaseId,
      }),
    ).rejects.toThrow();
    await expect(
      operations.markQuotePending(operation.operationId, {
        leaseId: current!.leaseId,
      }),
    ).resolves.toMatchObject({ status: 'quote_pending' });
  });
});
