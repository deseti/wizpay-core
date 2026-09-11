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
    expect(mainnet).toContain('CIRCLE_MAINNET_WALLET_SET_ID');
    expect(mainnet).not.toContain('ARC_TESTNET_');
    expect(mainnet).not.toContain('CIRCLE_TESTNET_');
  });

  it('keeps the Mainnet manifest empty of addresses and receipts', () => {
    const manifest: unknown = JSON.parse(
      read('packages/contracts/deployments/arc-mainnet-wizpay-v2.json'),
    );
    expect(manifest).toEqual({
      network: 'arc-mainnet',
      status: 'unavailable',
      contracts: {},
      receipts: [],
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
