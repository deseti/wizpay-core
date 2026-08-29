/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { InvoiceService } from './invoice.service';
import { InvoiceVerificationError } from './invoice.types';

const MERCHANT_A = {
  merchantUserId: 'circle:user:a',
  merchantWalletAddress: '0x32F251fc36A1174901124589EAC2d4E391816F69' as const,
  merchantDisplayLabel: null,
};
const MERCHANT_B = {
  merchantUserId: 'circle:user:b',
  merchantWalletAddress: '0x1111111111111111111111111111111111111111' as const,
  merchantDisplayLabel: null,
};
const HASH = `0x${'a'.repeat(64)}`;

describe('InvoiceService', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let verifier: { verify: jest.Mock };
  let service: InvoiceService;

  beforeEach(() => {
    prisma = prismaMock();
    verifier = { verify: jest.fn() };
    service = new InvoiceService(prisma as never, verifier as never);
  });

  it('creates immutable payment terms from the canonical registry and authenticated principal', async () => {
    prisma.invoice.create.mockImplementation(async ({ data }: any) =>
      invoice({ ...data, id: '3fcbcc73-3471-4e64-8dda-63c12ebf6c3c' }),
    );
    const result = await service.create(MERCHANT_A, {
      token: 'USDC',
      amount: '0.1',
      title: '  Consulting  ',
    });
    expect(prisma.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          merchantUserId: MERCHANT_A.merchantUserId,
          merchantWalletAddress: MERCHANT_A.merchantWalletAddress,
          chainId: 5_042_002,
          tokenAddress: '0x3600000000000000000000000000000000000000',
          tokenDecimals: 6,
          amountUnits: '100000',
          title: 'Consulting',
        }),
      }),
    );
    expect(result.publicId).toHaveLength(22);
    expect(result).not.toHaveProperty('merchantUserId');
  });

  it.each([
    [
      'USDC',
      '12.345678',
      '12345678',
      '0x3600000000000000000000000000000000000000',
    ],
    [
      'EURC',
      '98.765432',
      '98765432',
      '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    ],
  ] as const)(
    'converts an arbitrary valid %s amount into exact canonical base units',
    async (token, amount, amountUnits, tokenAddress) => {
      prisma.invoice.create.mockImplementation(async ({ data }: any) =>
        invoice({ ...data }),
      );

      await service.create(MERCHANT_A, {
        token,
        amount,
        title: `${token} invoice`,
      });

      expect(prisma.invoice.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tokenSymbol: token,
            tokenAddress,
            tokenDecimals: 6,
            amountUnits,
          }),
        }),
      );
    },
  );

  it('rejects zero, excessive, over-precision, and invalid expiry amounts', async () => {
    await expect(
      service.create(MERCHANT_A, { token: 'USDC', amount: '0', title: 'x' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create(MERCHANT_A, {
        token: 'USDC',
        amount: '1000000001',
        title: 'x',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create(MERCHANT_A, {
        token: 'USDC',
        amount: '0.0000001',
        title: 'x',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create(MERCHANT_A, {
        token: 'USDC',
        amount: '1',
        title: 'x',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('scopes listing, reads, and cancellation to the authenticated merchant', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.invoice.count.mockResolvedValue(0);
    await service.list(MERCHANT_A, { limit: 20, offset: 0 });
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { merchantUserId: MERCHANT_A.merchantUserId },
      }),
    );

    prisma.invoice.findFirst.mockResolvedValue(null);
    await expect(
      service.getOwned(MERCHANT_B, '3fcbcc73-3471-4e64-8dda-63c12ebf6c3c'),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          merchantUserId: MERCHANT_B.merchantUserId,
        }),
      }),
    );

    prisma.invoice.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.cancel(MERCHANT_B, '3fcbcc73-3471-4e64-8dda-63c12ebf6c3c'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('sanitizes the public response and exposes a hash only after verified payment', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoice({
        merchantUserId: 'secret',
        id: 'secret-id',
        payment: {
          status: 'VERIFYING',
          transactionHash: HASH,
          rejectionCode: null,
        },
      }),
    );
    const pending = await service.getPublic('abcdefghijklmnopqrstuv');
    expect(pending.transactionHash).toBeNull();
    expect(pending).not.toHaveProperty('id');
    expect(pending).not.toHaveProperty('merchantUserId');
    expect(JSON.stringify(pending)).not.toContain('secret');

    prisma.invoice.findUnique.mockResolvedValue(
      invoice({
        status: 'PAID',
        paidAt: new Date(),
        payment: {
          status: 'VERIFIED',
          transactionHash: HASH,
          verifiedAt: new Date(),
          payerAddress: MERCHANT_B.merchantWalletAddress,
          rejectionCode: null,
        },
      }),
    );
    await expect(
      service.getPublic('abcdefghijklmnopqrstuv'),
    ).resolves.toMatchObject({ transactionHash: HASH, status: 'PAID' });
  });

  it('rejects expired, cancelled, paid, different-hash, and cross-invoice hash submissions', async () => {
    for (const status of ['EXPIRED', 'CANCELLED'] as const) {
      prisma.invoice.findUnique.mockResolvedValueOnce(invoice({ status }));
      await expect(
        service.verifyPublicPayment('abcdefghijklmnopqrstuv', HASH),
      ).rejects.toBeDefined();
    }
    prisma.invoice.findUnique.mockResolvedValueOnce(
      invoice({
        status: 'PAID',
        payment: { status: 'VERIFIED', transactionHash: `0x${'b'.repeat(64)}` },
      }),
    );
    await expect(
      service.verifyPublicPayment('abcdefghijklmnopqrstuv', HASH),
    ).rejects.toMatchObject({ status: 409 });
    prisma.invoice.findUnique.mockResolvedValueOnce(
      invoice({
        status: 'VERIFYING',
        payment: {
          status: 'VERIFYING',
          transactionHash: `0x${'b'.repeat(64)}`,
        },
      }),
    );
    await expect(
      service.verifyPublicPayment('abcdefghijklmnopqrstuv', HASH),
    ).rejects.toMatchObject({ status: 409 });
    prisma.invoice.findUnique.mockResolvedValueOnce(invoice());
    prisma.invoicePayment.findUnique.mockResolvedValueOnce({
      invoiceId: 'another',
    });
    await expect(
      service.verifyPublicPayment('abcdefghijklmnopqrstuv', HASH),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('is idempotent for a repeated verified hash and concurrent verification calls', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoice({
        status: 'PAID',
        paidAt: new Date(),
        payment: {
          status: 'VERIFIED',
          transactionHash: HASH,
          verifiedAt: new Date(),
        },
      }),
    );
    await expect(
      service.verifyPublicPayment('abcdefghijklmnopqrstuv', HASH),
    ).resolves.toMatchObject({ status: 'PAID', transactionHash: HASH });
    expect(verifier.verify).not.toHaveBeenCalled();

    let paid = false;
    prisma.invoice.findUnique.mockImplementation(async () =>
      invoice({
        status: paid ? 'PAID' : 'VERIFYING',
        paidAt: paid ? new Date() : null,
        payment: {
          status: paid ? 'VERIFIED' : 'VERIFYING',
          transactionHash: HASH,
          verifiedAt: paid ? new Date() : null,
        },
      }),
    );
    verifier.verify.mockResolvedValue({
      payerAddress: MERCHANT_B.merchantWalletAddress,
      transactionHash: HASH,
      confirmations: 2,
      blockNumber: 100n,
    });
    prisma.invoice.updateMany.mockImplementation(async ({ data }: any) => {
      if (data.status === 'PAID') paid = true;
      return { count: 1 };
    });
    const [first, second] = await Promise.all([
      service.verifyPublicPayment('abcdefghijklmnopqrstuv', HASH),
      service.verifyPublicPayment('abcdefghijklmnopqrstuv', HASH),
    ]);
    expect(first.status).toBe('PAID');
    expect(second.status).toBe('PAID');
    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
  });

  it('atomically re-verifies an existing rejected payment with the same hash without creating another record', async () => {
    let paid = false;
    prisma.invoice.findUnique.mockImplementation(async () =>
      invoice({
        status: paid ? 'PAID' : 'VERIFYING',
        paidAt: paid ? new Date() : null,
        payment: {
          status: paid ? 'VERIFIED' : 'REJECTED',
          transactionHash: HASH,
          rejectionCode: paid ? null : 'INVOICE_WRONG_TOKEN',
          verifiedAt: paid ? new Date() : null,
          payerAddress: paid ? MERCHANT_B.merchantWalletAddress : null,
        },
      }),
    );
    verifier.verify.mockResolvedValue({
      payerAddress: MERCHANT_B.merchantWalletAddress,
      transactionHash: HASH,
      confirmations: 2,
      blockNumber: 100n,
    });
    prisma.invoice.updateMany.mockImplementation(async ({ data }: any) => {
      if (data.status === 'PAID') paid = true;
      return { count: 1 };
    });

    await expect(
      service.verifyPublicPayment('abcdefghijklmnopqrstuv', HASH),
    ).resolves.toMatchObject({
      status: 'PAID',
      transactionHash: HASH,
    });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          invoiceId: '3fcbcc73-3471-4e64-8dda-63c12ebf6c3c',
          transactionHash: HASH,
          status: { in: ['SUBMITTED', 'VERIFYING', 'REJECTED'] },
        }),
        data: expect.objectContaining({
          status: 'VERIFIED',
          rejectionCode: null,
        }),
      }),
    );
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: '3fcbcc73-3471-4e64-8dda-63c12ebf6c3c',
          status: 'VERIFYING',
        }),
        data: expect.objectContaining({ status: 'PAID' }),
      }),
    );
  });

  it('keeps provider failures retryable and records strict mismatches as rejected', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoice({
        status: 'VERIFYING',
        payment: { status: 'VERIFYING', transactionHash: HASH },
      }),
    );
    verifier.verify.mockRejectedValueOnce(
      new InvoiceVerificationError(
        'INVOICE_RPC_UNAVAILABLE',
        'temporary',
        true,
      ),
    );
    await expect(
      service.verifyPublicPayment('abcdefghijklmnopqrstuv', HASH),
    ).rejects.toMatchObject({ status: 503 });

    verifier.verify.mockRejectedValueOnce(
      new InvoiceVerificationError(
        'INVOICE_WRONG_AMOUNT',
        'wrong amount',
        false,
      ),
    );
    await expect(
      service.verifyPublicPayment('abcdefghijklmnopqrstuv', HASH),
    ).rejects.toMatchObject({ status: 422 });
    expect(prisma.invoicePayment.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REJECTED',
          rejectionCode: 'INVOICE_WRONG_AMOUNT',
        }),
      }),
    );
  });
});

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: '3fcbcc73-3471-4e64-8dda-63c12ebf6c3c',
    publicId: 'abcdefghijklmnopqrstuv',
    merchantUserId: MERCHANT_A.merchantUserId,
    merchantWalletAddress: MERCHANT_A.merchantWalletAddress,
    chainId: 5_042_002,
    tokenAddress: '0x3600000000000000000000000000000000000000',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    amountUnits: '100000',
    title: 'Invoice',
    description: null,
    invoiceNumber: null,
    status: 'OPEN',
    expiresAt: new Date(Date.now() + 86_400_000),
    paidAt: null,
    cancelledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    payment: null,
    ...overrides,
  };
}

function prismaMock() {
  const mock: any = {
    invoice: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoicePayment: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  mock.$transaction = jest.fn(async (value: any) =>
    typeof value === 'function' ? value(mock) : Promise.all(value),
  );
  return mock;
}
