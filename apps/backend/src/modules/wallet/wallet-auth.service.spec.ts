/* eslint-disable @typescript-eslint/no-explicit-any */
import { WalletAuthService } from './wallet-auth.service';

const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x2222222222222222222222222222222222222222';

describe('WalletAuthService', () => {
  let challenges: any[];
  let sessions: any[];
  let prisma: any;
  let service: WalletAuthService;

  beforeEach(() => {
    challenges = [];
    sessions = [];
    prisma = {
      walletAuthChallenge: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `challenge-${challenges.length + 1}`, usedAt: null, ...data };
          challenges.push(row);
          return row;
        }),
        findUnique: jest.fn(async ({ where }: any) => challenges.find((row) => row.id === where.id) ?? null),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = challenges.find((item) => item.id === where.id && !item.usedAt && item.expiresAt > where.expiresAt.gt);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      userWallet: {
        findMany: jest.fn(async () => [{ userId: 'owner-a', address: WALLET_A, blockchain: 'ARC-MAINNET' }]),
        upsert: jest.fn(),
      },
      activityAuthSession: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `session-${sessions.length + 1}`, revokedAt: null, ...data };
          sessions.push(row);
          return row;
        }),
        findFirst: jest.fn(async ({ where }: any) => sessions.find((row) => row.sessionHash === where.sessionHash && !row.revokedAt && row.expiresAt > where.expiresAt.gt) ?? null),
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const row of sessions) {
            if ((where.id && row.id !== where.id) || (where.ownerUserId && row.ownerUserId !== where.ownerUserId) || (where.sessionHash && row.sessionHash !== where.sessionHash) || row.revokedAt) continue;
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        }),
      },
      $transaction: jest.fn(async (callback: (tx: any) => unknown) => callback(prisma)),
    };
    service = new WalletAuthService(prisma, {
      getOrThrow: jest.fn(() => ({ key: 'arc-mainnet', chainId: 5042, rpcUrl: 'http://127.0.0.1:8545' })),
    } as never);
    (service as any).publicClient.verifyMessage = jest.fn(async () => true);
  });

  it('generates unpredictable short-lived nonce challenges and canonicalizes casing', async () => {
    const first = await service.createChallenge(WALLET_A.toUpperCase().replace('0X', '0x'), 5042);
    const second = await service.createChallenge(WALLET_A, 5042);
    expect(first.message).toContain('Chain ID: 5042');
    expect(first.message).not.toBe(second.message);
    expect(challenges[0].nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(challenges[0].walletAddress).toBe(WALLET_A);
    expect(challenges[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
  });

  it('rejects expired, reused, invalid, and wrong-wallet signatures', async () => {
    await service.createChallenge(WALLET_A, 5042);
    challenges[0].expiresAt = new Date(Date.now() - 1);
    await expect(service.verifyChallenge(challenges[0].id, `0x${'1'.repeat(130)}`)).rejects.toMatchObject({ status: 401 });

    const current = await service.createChallenge(WALLET_A, 5042);
    (service as any).publicClient.verifyMessage.mockResolvedValueOnce(false);
    await expect(service.verifyChallenge(current.challengeId, `0x${'2'.repeat(130)}`)).rejects.toMatchObject({ status: 401 });
    (service as any).publicClient.verifyMessage.mockResolvedValueOnce(false);
    await expect(service.verifyChallenge(current.challengeId, `0x${'3'.repeat(130)}`)).rejects.toMatchObject({ status: 401 });

    (service as any).publicClient.verifyMessage.mockResolvedValueOnce(true);
    await service.verifyChallenge(current.challengeId, `0x${'4'.repeat(130)}`);
    await expect(service.verifyChallenge(current.challengeId, `0x${'4'.repeat(130)}`)).rejects.toMatchObject({ status: 401 });
  });

  it('issues only an opaque token, stores its hash, and binds reads to one owner and wallet', async () => {
    const challenge = await service.createChallenge(WALLET_A, 5042);
    const verified = await service.verifyChallenge(challenge.challengeId, `0x${'5'.repeat(130)}`);
    expect(verified.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessions[0].sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sessions[0])).not.toContain(verified.sessionToken);
    await expect(service.authenticate(`Bearer ${verified.sessionToken}`)).resolves.toMatchObject({
      merchantUserId: 'owner-a',
      merchantWalletAddress: WALLET_A,
    });
    await expect(service.authenticate(`Bearer ${WALLET_B}`)).rejects.toMatchObject({ status: 401 });
  });

  it('creates a server-controlled owner for a newly verified wallet', async () => {
    prisma.userWallet.findMany.mockResolvedValue([]);
    prisma.userWallet.upsert.mockImplementation(async ({ create }: any) => create);
    const challenge = await service.createChallenge(WALLET_B, 5042);
    const verified = await service.verifyChallenge(challenge.challengeId, `0x${'6'.repeat(130)}`);
    expect(verified.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(prisma.userWallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ address: WALLET_B }),
      }),
    );
  });
});
