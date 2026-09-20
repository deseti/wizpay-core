import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Arc deployment isolation files', () => {
  const testnet = read('deploy/arc-testnet/compose.yml');
  const mainnet = read('deploy/arc-mainnet/compose.yml');
  const packageJson = read('apps/backend/package.json');
  const prismaConfig = read('apps/backend/prisma.config.ts');

  it('uses distinct project, network, PostgreSQL, and Redis volume identities', () => {
    for (const identity of [
      'wizpay-arc-testnet',
      'wizpay-arc-testnet-postgres',
      'wizpay-arc-testnet-redis',
    ]) {
      expect(testnet).toContain(identity);
      expect(mainnet).not.toContain(identity);
    }
    for (const identity of [
      'wizpay-arc-mainnet',
      'wizpay-arc-mainnet-postgres',
      'wizpay-arc-mainnet-redis',
    ]) {
      expect(mainnet).toContain(identity);
      expect(testnet).not.toContain(identity);
    }
    expect(testnet).not.toContain('container_name:');
    expect(mainnet).not.toContain('container_name:');
  });

  it('never mixes scoped runtime or Circle configuration variables', () => {
    expect(testnet).toContain('ARC_TESTNET_DATABASE_URL');
    expect(testnet).toContain('CIRCLE_TESTNET_WALLET_SET_ID');
    expect(testnet).not.toContain('ARC_MAINNET_');
    expect(testnet).not.toContain('CIRCLE_MAINNET_');
    expect(mainnet).toContain('ARC_MAINNET_DATABASE_URL');
    // Arc Mainnet is external-wallet-only: no Circle Mainnet configuration
    // may be required or referenced by the Mainnet deployment.
    expect(mainnet).not.toContain('CIRCLE_MAINNET_');
    expect(mainnet).not.toContain('ARC_TESTNET_');
    expect(mainnet).not.toContain('CIRCLE_TESTNET_');
  });

  it('documents Mainnet Circle unavailability in the env template', () => {
    const mainnetTemplate = read('deploy/arc-mainnet/environment.template');
    const testnetTemplate = read('deploy/arc-testnet/environment.template');
    // No CIRCLE_MAINNET_* variable definitions may remain; the explanatory
    // comment below names the family only in prose.
    expect(mainnetTemplate).not.toMatch(/^CIRCLE_MAINNET_/m);
    expect(mainnetTemplate).toContain('external-wallet-only');
    expect(testnetTemplate).toContain('CIRCLE_TESTNET_WALLET_SET_ID');
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

  it('requires explicit matching networks for migration commands', () => {
    expect(packageJson).toContain('prisma:migrate:arc-testnet');
    expect(packageJson).toContain('prisma:migrate:arc-mainnet');
    expect(prismaConfig).toContain('migrationNetwork !== selectedNetwork');
    expect(prismaConfig).toContain('process.env.DATABASE_URL !== undefined');
  });
});
