import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';

export type WalletProvisionChain = 'EVM' | 'SOLANA';
export type SupportedUserWalletBlockchain =
  | 'ARC-TESTNET'
  | 'ETH-SEPOLIA'
  | 'SOLANA-DEVNET';

type WalletSessionInput = {
  email?: string | null;
  userId?: string | null;
  userToken: string;
};

type EnsureWalletInput = WalletSessionInput & {
  chain: WalletProvisionChain;
};

type UpstreamWallet = {
  accountType?: string;
  address?: string;
  blockchain?: string;
  id?: string;
  walletSetId?: string | null;
};

type NormalizedUpstreamWallet = UpstreamWallet & {
  address: string;
  blockchain: SupportedUserWalletBlockchain;
  id: string;
  walletSetId: string | null;
};

type UpstreamWalletResponse = {
  wallets?: unknown[];
};

export type PersistedUserWallet = {
  address: string;
  blockchain: SupportedUserWalletBlockchain;
  chain: WalletProvisionChain;
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

const CIRCLE_INITIALIZE_BLOCKCHAINS = ['ARC-TESTNET', 'ETH-SEPOLIA'] as const;
const SUPPORTED_BLOCKCHAINS = new Set<SupportedUserWalletBlockchain>([
  'ARC-TESTNET',
  'ETH-SEPOLIA',
  'SOLANA-DEVNET',
]);
const WALLET_CHAIN_BY_BLOCKCHAIN: Record<
  SupportedUserWalletBlockchain,
  WalletProvisionChain
> = {
  'ARC-TESTNET': 'EVM',
  'ETH-SEPOLIA': 'EVM',
  'SOLANA-DEVNET': 'SOLANA',
};

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly circleBaseUrl: string;
  private readonly solanaRpcUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.circleBaseUrl = (
      this.configService.get<string>('CIRCLE_BASE_URL') ||
      this.configService.get<string>('NEXT_PUBLIC_CIRCLE_BASE_URL') ||
      'https://api.circle.com'
    ).replace(/\/+$/, '');

    this.solanaRpcUrl =
      this.configService.get<string>('SOLANA_DEVNET_RPC_URL') ||
      'https://api.devnet.solana.com';
  }

  async initializeWallets(
    input: WalletSessionInput,
  ): Promise<InitializeWalletsResult> {
    const userId = this.resolveUserId(input);
    const payload = await this.circleRequest<Record<string, unknown>>({
      body: {
        accountType: 'EOA',
        blockchains: [...CIRCLE_INITIALIZE_BLOCKCHAINS],
        idempotencyKey: randomUUID(),
      },
      method: 'POST',
      path: '/v1/w3s/user/initialize',
      userToken: input.userToken,
    });

    return {
      challengeId: this.readString(payload, 'challengeId'),
      userId,
    };
  }

  async syncWallets(input: WalletSessionInput): Promise<SyncWalletsResult> {
    const userId = this.resolveUserId(input);
    const userEmail = this.normalizeOptionalEmail(input.email);
    const upstreamWallets = await this.listUpstreamWallets(input.userToken);
    const wallets = await this.persistWallets({
      userEmail,
      userId,
      wallets: upstreamWallets,
    });

    return {
      userId,
      wallets,
    };
  }

  async getOrCreateWallet(
    input: EnsureWalletInput,
  ): Promise<EnsureWalletResult> {
    const syncedWallets = await this.syncWallets(input);
    const targetBlockchain = this.resolveTargetBlockchain(input.chain);
    const wallet = syncedWallets.wallets.find(
      (candidate) => candidate.blockchain === targetBlockchain,
    );

    if (wallet) {
      return {
        challengeId: null,
        requiresUserApproval: false,
        userId: syncedWallets.userId,
        wallet,
      };
    }

    const payload = await this.circleRequest<Record<string, unknown>>({
      body: {
        accountType: 'EOA',
        blockchains: [this.toCircleBlockchain(targetBlockchain)],
        idempotencyKey: randomUUID(),
      },
      method: 'POST',
      path: '/v1/w3s/user/wallets',
      userToken: input.userToken,
    });
    const challengeId = this.readString(payload, 'challengeId');

    if (!challengeId) {
      throw new Error('Circle did not return a wallet challenge identifier.');
    }

    return {
      challengeId,
      requiresUserApproval: true,
      userId: syncedWallets.userId,
      wallet: null,
    };
  }

  async getStoredWalletByBlockchain(
    userId: string,
    blockchain: SupportedUserWalletBlockchain,
  ) {
    const normalizedUserId = this.normalizeOptionalValue(userId);

    if (!normalizedUserId) {
      return null;
    }

    const wallet = await this.prisma.userWallet.findUnique({
      where: {
        userId_blockchain: {
          blockchain,
          userId: normalizedUserId,
        },
      },
    });

    return wallet ? this.toPersistedWallet(wallet) : null;
  }

  resolveUserId(input: {
    email?: string | null;
    userId?: string | null;
    userToken?: string | null;
  }) {
    const explicitUserId = this.normalizeOptionalValue(input.userId);

    if (explicitUserId) {
      return explicitUserId;
    }

    const tokenUserId = this.readStableUserIdFromToken(input.userToken);

    if (tokenUserId) {
      return tokenUserId;
    }

    const email = this.normalizeOptionalEmail(input.email);

    if (email) {
      return `circle:email:${email}`;
    }

    throw new BadRequestException(
      'Wallet provisioning requires the stable Circle userId returned by login.',
    );
  }

  private async listUpstreamWallets(
    userToken: string,
  ): Promise<NormalizedUpstreamWallet[]> {
    const payload = await this.circleRequest<UpstreamWalletResponse>({
      method: 'GET',
      path: '/v1/w3s/wallets',
      userToken,
    });
    const walletItems = Array.isArray(payload.wallets) ? payload.wallets : [];

    return walletItems
      .filter((wallet): wallet is UpstreamWallet =>
        Boolean(wallet && typeof wallet === 'object'),
      )
      .map((wallet) => this.normalizeUpstreamWallet(wallet))
      .filter((wallet): wallet is NormalizedUpstreamWallet => wallet !== null);
  }

  private normalizeUpstreamWallet(wallet: UpstreamWallet) {
    const walletId = this.normalizeOptionalValue(wallet.id);
    const address = this.normalizeOptionalValue(wallet.address);
    const blockchain = this.normalizeUpstreamBlockchain(wallet.blockchain);

    if (!walletId || !address || !blockchain) {
      return null;
    }

    return {
      ...wallet,
      address,
      blockchain,
      id: walletId,
      walletSetId: this.normalizeOptionalValue(wallet.walletSetId),
    };
  }

  private normalizeUpstreamBlockchain(
    blockchain: string | undefined,
  ): SupportedUserWalletBlockchain | null {
    const normalized = this.normalizeOptionalValue(blockchain)
      ?.toUpperCase()
      .replace(/_/g, '-');

    if (!normalized) {
      return null;
    }

    if (normalized === 'SOL-DEVNET') {
      return 'SOLANA-DEVNET';
    }

    return SUPPORTED_BLOCKCHAINS.has(normalized as SupportedUserWalletBlockchain)
      ? (normalized as SupportedUserWalletBlockchain)
      : null;
  }

  private async persistWallets(input: {
    userEmail: string | null;
    userId: string;
    wallets: NormalizedUpstreamWallet[];
  }) {
    const persistedWallets: PersistedUserWallet[] = [];

    for (const wallet of input.wallets) {
      try {
        const existingByWalletId = await this.prisma.userWallet.findUnique({
          where: {
            walletId: wallet.id,
          },
        });

        if (existingByWalletId) {
          const storedWallet = await this.prisma.userWallet.update({
            where: {
              walletId: wallet.id,
            },
            data: {
              address: wallet.address,
              blockchain: wallet.blockchain,
              chain: WALLET_CHAIN_BY_BLOCKCHAIN[wallet.blockchain],
              userEmail: input.userEmail,
              userId: input.userId,
              walletSetId: wallet.walletSetId,
            },
          });

          persistedWallets.push(this.toPersistedWallet(storedWallet));
          continue;
        }

        const existingByUserId = await this.prisma.userWallet.findUnique({
          where: {
            userId_blockchain: {
              userId: input.userId,
              blockchain: wallet.blockchain,
            },
          },
        });

        let storedWallet;
        if (existingByUserId) {
          storedWallet = await this.prisma.userWallet.update({
            where: {
              userId_blockchain: {
                userId: input.userId,
                blockchain: wallet.blockchain,
              },
            },
            data: {
              address: wallet.address,
              walletId: wallet.id,
              userEmail: input.userEmail,
              walletSetId: wallet.walletSetId,
            },
          });
        } else {
          storedWallet = await this.prisma.userWallet.create({
            data: {
              address: wallet.address,
              blockchain: wallet.blockchain,
              chain: WALLET_CHAIN_BY_BLOCKCHAIN[wallet.blockchain],
              userEmail: input.userEmail,
              userId: input.userId,
              walletId: wallet.id,
              walletSetId: wallet.walletSetId,
            },
          });

          if (wallet.blockchain === 'SOLANA-DEVNET') {
            void this.airdropSolanaDevnet(wallet.address);
          }
        }

        persistedWallets.push(this.toPersistedWallet(storedWallet));
      } catch (error) {
        this.handleWalletPersistenceError(error, wallet.id);
      }
    }

    return persistedWallets;
  }

  private async airdropSolanaDevnet(address: string) {
    const lamports = Number.parseInt(
      this.configService.get<string>('SOLANA_DEVNET_AIRDROP_LAMPORTS') ||
        '10000000',
      10,
    );

    if (!Number.isFinite(lamports) || lamports <= 0) {
      return;
    }

    try {
      const response = await fetch(this.solanaRpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: randomUUID(),
          jsonrpc: '2.0',
          method: 'requestAirdrop',
          params: [address, lamports],
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
        result?: string;
      };

      if (!response.ok || payload.error) {
        this.logger.warn(
          `Solana devnet airdrop failed for ${address}: ${payload.error?.message || response.statusText}`,
        );
        return;
      }

      if (payload.result) {
        this.logger.log(
          `Solana devnet airdrop requested for ${address} (signature=${payload.result}).`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Solana devnet airdrop request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async circleRequest<T extends Record<string, unknown>>(input: {
    body?: Record<string, unknown>;
    method: 'GET' | 'POST';
    path: string;
    userToken: string;
  }): Promise<T> {
    const response = await fetch(new URL(input.path, this.circleBaseUrl).toString(), {
      method: input.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.getCircleApiKey()}`,
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
        'X-User-Token': input.userToken,
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      code?: string | number;
      data?: T;
      details?: unknown;
      error?: string;
      message?: string;
    };

    if (!response.ok) {
      throw new WalletProvisionError(
        payload.error ||
          payload.message ||
          `Circle wallet request failed with status ${response.status}.`,
        response.status,
        payload.code,
        payload.details,
      );
    }

    return payload.data ?? (payload as T);
  }

  private getCircleApiKey() {
    const apiKey = this.configService.get<string>('CIRCLE_API_KEY');

    if (!apiKey) {
      throw new Error('CIRCLE_API_KEY is not configured on the backend.');
    }

    return apiKey;
  }

  private resolveTargetBlockchain(chain: WalletProvisionChain) {
    return chain === 'SOLANA' ? 'SOLANA-DEVNET' : 'ARC-TESTNET';
  }

  private toCircleBlockchain(blockchain: SupportedUserWalletBlockchain) {
    return blockchain === 'SOLANA-DEVNET' ? 'SOL-DEVNET' : blockchain;
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

  private readStableUserIdFromToken(userToken: string | null | undefined) {
    const token = this.normalizeOptionalValue(userToken);

    if (!token) {
      return null;
    }

    const [, encodedPayload] = token.split('.');

    if (!encodedPayload) {
      return null;
    }

    try {
      const payload = JSON.parse(
        Buffer.from(this.toBase64(encodedPayload), 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      const candidate =
        this.readString(payload, 'userID') ||
        this.readString(payload, 'userId') ||
        this.readString(payload, 'user_id') ||
        this.readString(payload, 'sub');

      return candidate ? `circle:user:${candidate}` : null;
    } catch {
      return null;
    }
  }

  private toBase64(value: string) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const paddingLength = (4 - (normalized.length % 4)) % 4;

    return normalized + '='.repeat(paddingLength);
  }

  private handleWalletPersistenceError(
    error: unknown,
    walletId: string,
  ): never {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'P2002'
    ) {
      throw new WalletProvisionError(
        'Circle wallet is already stored for another user session.',
        409,
        'WALLET_ALREADY_EXISTS',
        { walletId },
      );
    }

    throw error;
  }

  private readString(source: Record<string, unknown>, key: string) {
    const value = source[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
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
      blockchain: wallet.blockchain as SupportedUserWalletBlockchain,
      chain: wallet.chain as WalletProvisionChain,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
      userEmail: wallet.userEmail,
      userId: wallet.userId,
      walletId: wallet.walletId,
      walletSetId: wallet.walletSetId,
    };
  }
}
