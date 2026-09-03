import { Injectable } from '@nestjs/common';
import { getAddress, isAddress } from 'viem';
import { PrismaService } from '../database/prisma.service';
import { ActivityService } from './activity.service';

export type ActivityBackfillReport = {
  canonicalWalletsScanned: number;
  ownersProjected: number;
  malformedWalletsSkipped: number;
  ambiguousWalletsSkipped: number;
  safeCategories: string[];
  unsupportedCategories: string[];
};

/**
 * Explicit, restart-safe local backfill. It is intentionally not scheduled or
 * exposed over HTTP. Callers must invoke it from an approved local maintenance
 * harness; every projection is idempotent and only canonical UserWallet owners
 * are considered.
 */
@Injectable()
export class ActivityBackfillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async run(): Promise<ActivityBackfillReport> {
    const wallets = await this.prisma.userWallet.findMany({
      where: { blockchain: 'ARC-TESTNET' },
      orderBy: { id: 'asc' },
    });
    const byAddress = new Map<string, typeof wallets>();
    let malformedWalletsSkipped = 0;
    for (const wallet of wallets) {
      if (!isAddress(wallet.address)) {
        malformedWalletsSkipped += 1;
        continue;
      }
      const key = getAddress(wallet.address).toLowerCase();
      byAddress.set(key, [...(byAddress.get(key) ?? []), wallet]);
    }
    let ownersProjected = 0;
    let ambiguousWalletsSkipped = 0;
    for (const matches of byAddress.values()) {
      const owners = new Set(matches.map((wallet) => wallet.userId));
      if (owners.size !== 1 || matches.length !== 1) {
        ambiguousWalletsSkipped += matches.length;
        continue;
      }
      const wallet = matches[0];
      await this.activity.projectPersisted({
        merchantUserId: wallet.userId,
        merchantWalletAddress: getAddress(wallet.address),
      });
      ownersProjected += 1;
    }
    return {
      canonicalWalletsScanned: wallets.length,
      ownersProjected,
      malformedWalletsSkipped,
      ambiguousWalletsSkipped,
      safeCategories: [
        'xylonet_swap',
        'verified_invoice_payment',
        'verified_cctp_bridge',
      ],
      unsupportedCategories: [
        'circle_transfer_without_provider_sync',
        'payroll_without_authenticated_circle_sync',
        'legacy_swap',
        'unverified_liquidity_report',
        'ownerless_or_recipient_only_task',
      ],
    };
  }
}
