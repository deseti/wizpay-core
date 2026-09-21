import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress, isAddress } from 'viem';
import { PrismaService } from '../../database/prisma.service';
import { ARC_MAINNET_CHAIN_ID } from '../../config/arc-network.config';

export const EXTERNAL_WALLET_BLOCKCHAIN = 'ARC-MAINNET' as const;
export const EXTERNAL_WALLET_CHAIN = 'EVM' as const;

export type WalletProvisionChain = 'EVM' | 'SOLANA';
export type SupportedUserWalletBlockchain = typeof EXTERNAL_WALLET_BLOCKCHAIN;

type WalletSessionInput = {
  email?: string | null;
  userId?: string | null;
  userToken: string;
};

type EnsureWalletInput = WalletSessionInput & {
  chain: WalletProvisionChain;
};

export type PersistedUserWallet = {
  address: string;
  blockchain: SupportedUserWalletBlockchain;
  chain: WalletProvisionChain;
  chainId: number;
  createdAt: string;
  updatedAt: string;
  userEmail: string | null;
  userId: string;
  walletId: string;
  walletSetId: string | null;
};

export type InitializeWalletsResult = {
  challengeId: string | null;
  userId: string;
};

export type SyncWalletsResult = {
  userId: string;
  wallets: PersistedUserWallet[];
};

export type EnsureWalletResult = {
  challengeId: string | null;
  requiresUserApproval: boolean;
  userId: string;
  wallet: PersistedUserWallet | null;
};

export class WalletProvisionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string | number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WalletProvisionError';
  }
}

const PROVIDER_RETIRED_CODE = 'WALLET_PROVISIONING_RETIRED';
const PROVIDER_RETIRED_MESSAGE =
  'Hosted wallet provisioning is retired. Register an external Arc Mainnet wallet instead.';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    void this.configService;
  }

  /**
   * External wallet registry (Arc Mainnet only).
   *
   * Records a caller-provided external wallet address for chain 5042.
   * The backend never holds keys and never proxies a wallet provider:
   * registration is an address binding used for ownership scoping.
   */
  async registerExternalWallet(input: {
    userId: string;
    address: string;
    userEmail?: string | null;
  }): Promise<PersistedUserWallet> {
    const userId = this.requireUserId(input.userId);
    const address = this.requireAddress(input.address);
    const userEmail = this.normalizeOptionalEmail(input.userEmail ?? null);
    const walletId = `external:arc-mainnet:${address.toLowerCase()}`;

    const existingByWalletId = await this.prisma.userWallet.findUnique({
      where: { walletId },
    });
    if (existingByWalletId && existingByWalletId.userId !== userId) {
      throw new WalletProvisionError(
        'This external wallet is already registered to another user.',
        409,
        'WALLET_ALREADY_EXISTS',
        { walletId },
      );
    }

    const stored = existingByWalletId
      ? await this.prisma.userWallet.update({
          where: { walletId },
          data: {
            address,
            blockchain: EXTERNAL_WALLET_BLOCKCHAIN,
            chain: EXTERNAL_WALLET_CHAIN,
            userEmail,
            userId,
            walletSetId: null,
          },
        })
      : await this.prisma.userWallet.upsert({
          where: {
            userId_blockchain: {
              userId,
              blockchain: EXTERNAL_WALLET_BLOCKCHAIN,
            },
          },
          create: {
            address,
            blockchain: EXTERNAL_WALLET_BLOCKCHAIN,
            chain: EXTERNAL_WALLET_CHAIN,
            userEmail,
            userId,
            walletId,
            walletSetId: null,
          },
          update: {
            address,
            userEmail,
            walletId,
            walletSetId: null,
          },
        });

    this.logger.log(
      `External wallet registered — userId=${userId} address=${address} chainId=${ARC_MAINNET_CHAIN_ID}.`,
    );
    return this.toPersistedWallet(stored);
  }

  async getExternalWalletByUser(
    userId: string,
  ): Promise<PersistedUserWallet | null> {
    const normalizedUserId = this.normalizeOptionalValue(userId);
    if (!normalizedUserId) return null;
    const wallet = await this.prisma.userWallet.findUnique({
      where: {
        userId_blockchain: {
          userId: normalizedUserId,
          blockchain: EXTERNAL_WALLET_BLOCKCHAIN,
        },
      },
    });
    return wallet ? this.toPersistedWallet(wallet) : null;
  }

  async findExternalWalletsByAddress(
    address: string,
  ): Promise<PersistedUserWallet[]> {
    if (!isAddress(address.trim())) return [];
    const canonical = getAddress(address.trim()).toLowerCase();
    const wallets = await this.prisma.userWallet.findMany({
      where: { blockchain: EXTERNAL_WALLET_BLOCKCHAIN },
    });
    return wallets
      .filter((wallet) => wallet.address.toLowerCase() === canonical)
      .map((wallet) => this.toPersistedWallet(wallet));
  }

  async initializeWallets(_input: WalletSessionInput): Promise<never> {
    throw this.retired();
  }

  async syncWallets(_input: WalletSessionInput): Promise<never> {
    throw this.retired();
  }

  async getOrCreateWallet(_input: EnsureWalletInput): Promise<never> {
    throw this.retired();
  }

  async getStoredWalletByBlockchain(
    userId: string,
    blockchain: SupportedUserWalletBlockchain,
  ) {
    if (blockchain !== EXTERNAL_WALLET_BLOCKCHAIN) return null;
    return this.getExternalWalletByUser(userId);
  }

  async getStoredWalletForSelectedArc(
    _userId: string,
    _walletId: string,
  ): Promise<never> {
    throw this.retired();
  }

  private retired(): WalletProvisionError {
    return new WalletProvisionError(
      PROVIDER_RETIRED_MESSAGE,
      503,
      PROVIDER_RETIRED_CODE,
    );
  }

  private requireUserId(userId: string) {
    const normalized = this.normalizeOptionalValue(userId);
    if (!normalized) {
      throw new BadRequestException('Wallet registration requires a userId.');
    }
    return normalized;
  }

  private requireAddress(address: string) {
    const candidate = typeof address === 'string' ? address.trim() : '';
    if (!isAddress(candidate)) {
      throw new BadRequestException(
        'Wallet registration requires a valid EVM address.',
      );
    }
    return getAddress(candidate);
  }

  private normalizeOptionalEmail(value: string | null | undefined) {
    const normalized = this.normalizeOptionalValue(value)?.toLowerCase();
    return normalized ?? null;
  }

  private normalizeOptionalValue(value: string | null | undefined) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private toPersistedWallet(wallet: {
    address: string;
    blockchain: string;
    chain: string;
    createdAt: Date;
    updatedAt: Date;
    userEmail: string | null;
    userId: string;
    walletId: string;
    walletSetId: string | null;
  }): PersistedUserWallet {
    return {
      address: wallet.address,
      blockchain: EXTERNAL_WALLET_BLOCKCHAIN,
      chain: EXTERNAL_WALLET_CHAIN,
      chainId: ARC_MAINNET_CHAIN_ID,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
      userEmail: wallet.userEmail,
      userId: wallet.userId,
      walletId: wallet.walletId,
      walletSetId: wallet.walletSetId,
    };
  }
}
