import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Hex,
} from 'viem';
import { ARC_MAINNET_CHAIN_ID, type BackendArcNetworkConfiguration } from '../../config/arc-network.config';
import { PrismaService } from '../../database/prisma.service';
import { EXTERNAL_WALLET_BLOCKCHAIN, EXTERNAL_WALLET_CHAIN } from './wallet.service';

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;

export type WalletSessionPrincipal = Readonly<{
  merchantUserId: string;
  merchantWalletAddress: `0x${string}`;
  merchantDisplayLabel: null;
}>;

@Injectable()
export class WalletAuthService {
  private readonly publicClient;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const network = config.getOrThrow<BackendArcNetworkConfiguration>('arcNetwork');
    this.publicClient = createPublicClient({
      chain: {
        id: network.chainId,
        name: network.key,
        nativeCurrency: { decimals: 18, name: 'USDC', symbol: 'USDC' },
        rpcUrls: { default: { http: [network.rpcUrl] } },
      },
      transport: http(network.rpcUrl, { retryCount: 1, timeout: 10_000 }),
    });
  }

  async createChallenge(rawAddress: string, chainId: number) {
    if (chainId !== ARC_MAINNET_CHAIN_ID || !isAddress(rawAddress)) {
      throw new UnauthorizedException({
        code: 'WALLET_AUTH_ARC_MAINNET_REQUIRED',
        message: 'Wallet authentication requires Arc Mainnet (chain 5042).',
      });
    }
    const walletAddress = getAddress(rawAddress).toLowerCase();
    const nonce = randomBytes(32).toString('base64url');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
    const message = [
      'WizPay wallet authentication',
      '',
      'Sign this message to prove control of your wallet. This does not send a transaction or spend funds.',
      `Wallet: ${getAddress(rawAddress)}`,
      `Chain ID: ${ARC_MAINNET_CHAIN_ID}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expiration Time: ${expiresAt.toISOString()}`,
    ].join('\n');
    const challenge = await this.prisma.walletAuthChallenge.create({
      data: {
        nonceHash: this.hash('wizpay.wallet.challenge.v1', nonce),
        walletAddress,
        chainId,
        message,
        expiresAt,
      },
    });
    return {
      challengeId: challenge.id,
      address: getAddress(rawAddress),
      chainId,
      message,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verifyChallenge(challengeId: string, signature: string) {
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) this.invalidSignature();
    const challenge = await this.prisma.walletAuthChallenge.findUnique({
      where: { id: challengeId },
    });
    const now = new Date();
    if (!challenge || challenge.usedAt || challenge.expiresAt <= now) {
      throw new UnauthorizedException({
        code: challenge?.usedAt
          ? 'WALLET_AUTH_CHALLENGE_USED'
          : 'WALLET_AUTH_CHALLENGE_EXPIRED',
        message: 'The wallet authentication challenge is invalid or expired.',
      });
    }
    const address = getAddress(challenge.walletAddress);
    let valid = false;
    try {
      valid = await this.publicClient.verifyMessage({
        address,
        message: challenge.message,
        signature: signature as Hex,
      });
    } catch {
      valid = false;
    }
    if (!valid) this.invalidSignature();

    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const principal = await this.prisma.$transaction(
      async (tx) => {
        const consumed = await tx.walletAuthChallenge.updateMany({
          where: { id: challenge.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) {
          throw new ConflictException({
            code: 'WALLET_AUTH_CHALLENGE_USED',
            message: 'The wallet authentication challenge was already used.',
          });
        }
        const ownerUserId = await this.resolveOwner(tx, address);
        await tx.activityAuthSession.updateMany({
          where: { ownerUserId, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.activityAuthSession.create({
          data: {
            sessionHash: this.sessionHash(sessionToken),
            ownerUserId,
            walletAddress: address.toLowerCase(),
            expiresAt,
          },
        });
        return { ownerUserId };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return {
      sessionToken,
      expiresAt: expiresAt.toISOString(),
      address,
      chainId: ARC_MAINNET_CHAIN_ID,
      userId: principal.ownerUserId,
    };
  }

  async authenticate(authorization?: string): Promise<WalletSessionPrincipal> {
    const token = this.bearerToken(authorization);
    const now = new Date();
    const session = await this.prisma.activityAuthSession.findFirst({
      where: {
        sessionHash: this.sessionHash(token),
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (!session || !isAddress(session.walletAddress)) {
      throw new UnauthorizedException({
        code: 'WALLET_AUTH_SESSION_REQUIRED',
        message: 'A valid wallet authentication session is required.',
      });
    }
    await this.prisma.activityAuthSession.updateMany({
      where: { id: session.id, revokedAt: null, expiresAt: { gt: now } },
      data: { lastUsedAt: now },
    });
    return {
      merchantUserId: session.ownerUserId,
      merchantWalletAddress: getAddress(session.walletAddress),
      merchantDisplayLabel: null,
    };
  }

  async revoke(authorization?: string) {
    const token = this.bearerToken(authorization);
    await this.prisma.activityAuthSession.updateMany({
      where: { sessionHash: this.sessionHash(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: true as const };
  }

  private async resolveOwner(tx: Prisma.TransactionClient, address: `0x${string}`) {
    const canonical = address.toLowerCase();
    const rows = await tx.userWallet.findMany({
      where: { blockchain: EXTERNAL_WALLET_BLOCKCHAIN },
    });
    const matches = rows.filter((row) => row.address.toLowerCase() === canonical);
    const owners = new Set(matches.map((row) => row.userId));
    if (owners.size > 1) {
      throw new ConflictException({
        code: 'WALLET_AUTH_OWNER_CONFLICT',
        message: 'The verified wallet has conflicting canonical owners.',
      });
    }
    if (matches[0]) return matches[0].userId;
    const ownerUserId = randomUUID();
    const walletId = `external:arc-mainnet:${canonical}`;
    const created = await tx.userWallet.upsert({
      where: { walletId },
      create: {
        userId: ownerUserId,
        userEmail: null,
        chain: EXTERNAL_WALLET_CHAIN,
        blockchain: EXTERNAL_WALLET_BLOCKCHAIN,
        walletId,
        address: getAddress(address),
        walletSetId: null,
      },
      update: {},
    });
    return created.userId;
  }

  private bearerToken(authorization?: string) {
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) {
      throw new UnauthorizedException({
        code: 'WALLET_AUTH_SESSION_REQUIRED',
        message: 'A valid wallet authentication session is required.',
      });
    }
    return match[1];
  }

  private invalidSignature(): never {
    throw new UnauthorizedException({
      code: 'WALLET_AUTH_INVALID_SIGNATURE',
      message: 'The wallet signature does not match the requested address.',
    });
  }

  private sessionHash(token: string) {
    return this.hash('wizpay.wallet.session.v1', token);
  }

  private hash(domain: string, value: string) {
    return createHash('sha256').update(domain).update('\0').update(value).digest('hex');
  }
}
