import { MainnetUniswapV4Controller } from '../user-swap/mainnet-uniswap-v4.controller';
import { MainnetUniswapV4Service } from '../user-swap/mainnet-uniswap-v4.service';
import { InvoiceAuthService } from '../invoice/invoice-auth.service';
import { PrismaService } from '../database/prisma.service';
import { PostgresDeliveryService } from './postgres-delivery.service';

const wallet = '0x1000000000000000000000000000000000000001';
const hash = `0x${'a'.repeat(64)}`;
function fixture() {
  const swaps = {
    confirmTransaction: jest
      .fn()
      .mockRejectedValue(new Error('receipt pending')),
  };
  const auth = {
    authenticate: jest
      .fn()
      .mockResolvedValue({ merchantWalletAddress: wallet }),
  };
  const delivery = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const controller = new MainnetUniswapV4Controller(
    swaps as unknown as MainnetUniswapV4Service,
    auth as unknown as InvoiceAuthService,
    {} as PrismaService,
    delivery as unknown as PostgresDeliveryService,
  );
  return { controller, swaps, auth, delivery };
}

describe('authenticated swap evidence delivery', () => {
  it('persists the validated wallet-bound hash before receipt observation can fail', async () => {
    const { controller, swaps, delivery } = fixture();
    await expect(
      controller.confirm('Bearer test', { transactionHash: hash }),
    ).rejects.toThrow('receipt pending');
    expect(delivery.enqueue).toHaveBeenCalledWith('SWAP', wallet, hash);
    expect(delivery.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      swaps.confirmTransaction.mock.invocationCallOrder[0],
    );
    expect(swaps.confirmTransaction).toHaveBeenCalledWith(hash, wallet);
  });
  it('never queues evidence before authentication succeeds', async () => {
    const { controller, auth, delivery, swaps } = fixture();
    auth.authenticate.mockRejectedValue(new Error('unauthorized'));
    await expect(
      controller.confirm('invalid', { transactionHash: hash }),
    ).rejects.toThrow('unauthorized');
    expect(delivery.enqueue).not.toHaveBeenCalled();
    expect(swaps.confirmTransaction).not.toHaveBeenCalled();
  });
  it('rejects missing or invalid transaction hashes without inventing a hash', async () => {
    const { controller, delivery, swaps } = fixture();
    await expect(controller.confirm('Bearer test', {})).rejects.toThrow();
    await expect(
      controller.confirm('Bearer test', { transactionHash: 'unknown' }),
    ).rejects.toThrow();
    expect(delivery.enqueue).not.toHaveBeenCalled();
    expect(swaps.confirmTransaction).not.toHaveBeenCalled();
  });
});
