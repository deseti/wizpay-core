/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { ConfigService } from '@nestjs/config';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem';
import { InvoicePaymentVerifierService } from './invoice-payment-verifier.service';

const PAYER = '0x56DE876C902AdA72CF8E7595715127cEA27d43E6';
const MERCHANT = '0x32F251fc36A1174901124589EAC2d4E391816F69';
const TOKEN = '0x3600000000000000000000000000000000000000';
const ENTRYPOINT = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const BUNDLER = '0xbb9e6a30d234f68b50c7d4128e9453e3822a6c94';
const MIRROR = '0xfffffffffffffffffffffffffffffffffffffffe';
const HASH = `0x${'a'.repeat(64)}` as const;
const EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

describe('InvoicePaymentVerifierService', () => {
  let service: InvoicePaymentVerifierService;
  let client: ReturnType<typeof validClient>;

  beforeEach(() => {
    service = new InvoicePaymentVerifierService({
      get: jest.fn((key: string) =>
        key === 'INVOICE_PAYMENT_CONFIRMATIONS' ? '2' : undefined,
      ),
    } as unknown as ConfigService);
    client = validClient();
    (service as unknown as { publicClient: unknown }).publicClient = client;
  });

  it('accepts only an exact successful transfer with the canonical matching event and confirmations', async () => {
    await expect(service.verify(input())).resolves.toMatchObject({
      payerAddress: PAYER,
      confirmations: 2,
      transactionHash: HASH,
    });
  });

  it('accepts an ERC-4337 EntryPoint envelope and derives payer only from the canonical token log', async () => {
    client.getTransaction.mockResolvedValue({
      ...validTransaction(),
      from: BUNDLER,
      to: ENTRYPOINT,
      input: '0x1234',
    });
    await expect(service.verify(input())).resolves.toMatchObject({
      payerAddress: PAYER,
    });
  });

  it('keeps a direct EOA token transfer valid', async () => {
    await expect(service.verify(input())).resolves.toMatchObject({
      payerAddress: PAYER,
    });
    expect(validTransaction().to).toBe(TOKEN);
  });

  it.each([
    [
      'wrong transaction chain',
      (c: any) => {
        c.getTransaction.mockResolvedValue({
          ...validTransaction(),
          chainId: 1,
        });
      },
      'INVOICE_WRONG_CHAIN',
    ],
    [
      'wrong log emitter',
      (c: any) => {
        c.getTransactionReceipt.mockResolvedValue({
          ...validReceipt(),
          logs: [
            {
              ...transferLog(),
              address: '0x1111111111111111111111111111111111111111',
            },
          ],
        });
      },
      'INVOICE_WRONG_TOKEN',
    ],
    [
      'native value',
      (c: any) => {
        c.getTransaction.mockResolvedValue({
          ...validTransaction(),
          value: 1n,
        });
      },
      'INVOICE_NATIVE_VALUE_NOT_ZERO',
    ],
    [
      'failed receipt',
      (c: any) => {
        c.getTransactionReceipt.mockResolvedValue({
          ...validReceipt(),
          status: 'reverted',
        });
      },
      'INVOICE_FAILED_RECEIPT',
    ],
    [
      'missing Transfer event',
      (c: any) => {
        c.getTransactionReceipt.mockResolvedValue({
          ...validReceipt(),
          logs: [],
        });
      },
      'INVOICE_TRANSFER_EVENT_MISSING',
    ],
    [
      'event from wrong contract',
      (c: any) => {
        c.getTransactionReceipt.mockResolvedValue({
          ...validReceipt(),
          logs: [
            {
              ...validReceipt().logs[0],
              address: '0x1111111111111111111111111111111111111111',
            },
          ],
        });
      },
      'INVOICE_WRONG_TOKEN',
    ],
    [
      'event to wrong recipient',
      (c: any) => {
        c.getTransactionReceipt.mockResolvedValue({
          ...validReceipt(),
          logs: [
            transferLog({
              to: '0x1111111111111111111111111111111111111111',
            }),
          ],
        });
      },
      'INVOICE_WRONG_RECIPIENT',
    ],
    [
      'event with wrong amount',
      (c: any) => {
        c.getTransactionReceipt.mockResolvedValue({
          ...validReceipt(),
          logs: [transferLog({ value: 999_999n })],
        });
      },
      'INVOICE_WRONG_AMOUNT',
    ],
  ])('rejects %s', async (_label, mutate, code) => {
    mutate(client);
    await expect(service.verify(input())).rejects.toMatchObject({
      code,
      retryable: false,
    });
  });

  it('rejects self-payment from the Transfer topic even when receipt.from is a bundler', async () => {
    client.getTransaction.mockResolvedValue({
      ...validTransaction(),
      from: BUNDLER,
      to: ENTRYPOINT,
    });
    client.getTransactionReceipt.mockResolvedValue({
      ...validReceipt(),
      logs: [transferLog({ from: MERCHANT })],
    });
    await expect(service.verify(input())).rejects.toMatchObject({
      code: 'INVOICE_SELF_PAYMENT',
      retryable: false,
    });
  });

  it('ignores the Arc native accounting mirror emitter', async () => {
    client.getTransactionReceipt.mockResolvedValue({
      ...validReceipt(),
      logs: [
        { ...transferLog({ from: MERCHANT }), address: MIRROR },
        transferLog(),
      ],
    });
    await expect(service.verify(input())).resolves.toMatchObject({
      payerAddress: PAYER,
    });
  });

  it('rejects a log with a non-Transfer topic even when its fields resemble payment evidence', async () => {
    client.getTransactionReceipt.mockResolvedValue({
      ...validReceipt(),
      logs: [
        {
          ...transferLog(),
          topics: [`0x${'1'.repeat(64)}`],
        },
      ],
    });
    await expect(service.verify(input())).rejects.toMatchObject({
      code: 'INVOICE_TRANSFER_EVENT_MISSING',
      retryable: false,
    });
  });

  it('keeps pending receipts, insufficient confirmations, and RPC errors retryable', async () => {
    const pending = Object.assign(new Error('not found'), {
      name: 'TransactionReceiptNotFoundError',
    });
    client.getTransactionReceipt.mockRejectedValueOnce(pending);
    await expect(service.verify(input())).rejects.toMatchObject({
      code: 'INVOICE_RECEIPT_PENDING',
      retryable: true,
    });

    client = validClient();
    client.getBlockNumber.mockResolvedValue(100n);
    (service as unknown as { publicClient: unknown }).publicClient = client;
    await expect(service.verify(input())).rejects.toMatchObject({
      code: 'INVOICE_CONFIRMATIONS_PENDING',
      retryable: true,
    });

    client.getChainId.mockRejectedValueOnce(
      new Error('private provider details'),
    );
    await expect(service.verify(input())).rejects.toMatchObject({
      code: 'INVOICE_RPC_UNAVAILABLE',
      retryable: true,
      message: expect.not.stringContaining('private provider details'),
    });
  });
});

function input() {
  return {
    amountUnits: '1000000',
    merchantWalletAddress: MERCHANT as `0x${string}`,
    tokenAddress: TOKEN as `0x${string}`,
    transactionHash: HASH,
  };
}
function validTransaction() {
  return {
    chainId: 5_042_002,
    from: PAYER,
    to: TOKEN,
    value: 0n,
    input: '0xa9059cbb',
  };
}
function validReceipt() {
  return {
    status: 'success' as const,
    blockNumber: 100n,
    logs: [transferLog()],
  };
}
function transferLog(
  overrides: {
    from?: `0x${string}`;
    to?: `0x${string}`;
    value?: bigint;
  } = {},
) {
  return {
    address: TOKEN,
    topics: encodeEventTopics({
      abi: [EVENT],
      eventName: 'Transfer',
      args: {
        from: overrides.from ?? PAYER,
        to: overrides.to ?? MERCHANT,
      },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint256' }],
      [overrides.value ?? 1_000_000n],
    ),
  };
}
function validClient() {
  return {
    getChainId: jest.fn().mockResolvedValue(5_042_002),
    getTransaction: jest.fn().mockResolvedValue(validTransaction()),
    getTransactionReceipt: jest.fn().mockResolvedValue(validReceipt()),
    getBlockNumber: jest.fn().mockResolvedValue(101n),
  };
}
