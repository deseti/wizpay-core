import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Arc Mainnet deployment isolation files', () => {
  const mainnet = read('deploy/arc-mainnet/compose.yml');
  const packageJson = read('apps/backend/package.json');
  const prismaConfig = read('apps/backend/prisma.config.ts');

  it('uses distinct Mainnet project, network, PostgreSQL, and Redis volume identities', () => {
    for (const identity of [
      'wizpay-arc-mainnet',
      'wizpay-arc-mainnet-postgres',
      'wizpay-arc-mainnet-redis',
    ]) {
      expect(mainnet).toContain(identity);
    }
    expect(mainnet).not.toContain('container_name:');
  });

  it('scopes Mainnet runtime configuration to Mainnet variables only', () => {
    expect(mainnet).toContain('WIZPAY_ARC_NETWORK: arc-mainnet');
    expect(mainnet).toContain('ARC_MAINNET_DATABASE_URL');
    expect(mainnet).toContain('ARC_MAINNET_REDIS_URL');
    expect(mainnet).toContain('ARC_MAINNET_QUEUE_PREFIX');
    expect(mainnet).not.toMatch(/testnet/i);
  });

  it('keeps the Mainnet deployment external-wallet-only', () => {
    expect(mainnet).not.toMatch(/circle_/i);
    const mainnetTemplate = read('deploy/arc-mainnet/environment.template');
    expect(mainnetTemplate).toContain('WIZPAY_ARC_NETWORK=arc-mainnet');
    expect(mainnetTemplate).toContain('external-wallet-only');
    expect(mainnetTemplate).toContain('ARC_MAINNET_QUEUE_PREFIX');
  });

  it('keeps the Mainnet manifest empty of addresses and receipts', () => {
    const manifest: unknown = JSON.parse(
      read('packages/contracts/deployments/arc-mainnet-wizpay-v2.json'),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      network: 'arc-mainnet',
      chainId: 5042,
      status: 'unavailable',
      contract: 'WizPayMainnetV2',
      resourceManifestDigest: null,
      deploymentPlanDigest: null,
      deploymentResult: {
        transactionHash: null,
        blockNumber: null,
        deployedAddress: null,
        runtimeBytecodeHash: null,
        verificationStatus: 'unavailable',
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/0x[0-9a-f]{40}/i);
  });

  it('requires an explicit matching Mainnet network for migration commands', () => {
    expect(packageJson).toContain('prisma:migrate:arc-mainnet');
    expect(prismaConfig).toContain('ARC_MAINNET_DATABASE_URL');
    expect(prismaConfig).not.toMatch(/testnet/i);
    expect(prismaConfig).toContain('migrationNetwork !== selectedNetwork');
    expect(prismaConfig).toContain('process.env.DATABASE_URL !== undefined');
  });
});
