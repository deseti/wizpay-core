import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  getArcCircleExecutionDefinition,
  requireArcCircleBlockchain,
  type ArcCircleExecutionDefinition,
  type ArcNetworkKey,
  type CircleBlockchain,
} from '@wizpay/arc-network';

export const CIRCLE_CONFIGURATION_ERROR_CODES = Object.freeze({
  MISSING: 'CIRCLE_CONFIGURATION_MISSING',
  BLOCKCHAIN_UNSUPPORTED: 'CIRCLE_BLOCKCHAIN_UNSUPPORTED',
  CREDENTIAL_ENVIRONMENT_MISMATCH: 'CIRCLE_CREDENTIAL_ENVIRONMENT_MISMATCH',
  AMBIGUOUS_CREDENTIAL: 'CIRCLE_AMBIGUOUS_CREDENTIAL',
  WALLET_SET_MISMATCH: 'CIRCLE_WALLET_SET_MISMATCH',
  WALLET_BLOCKCHAIN_MISMATCH: 'CIRCLE_WALLET_BLOCKCHAIN_MISMATCH',
  RECEIPT_VERIFICATION_FAILED: 'CIRCLE_RECEIPT_VERIFICATION_FAILED',
});

export class CircleConfigurationError extends ServiceUnavailableException {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super({ code, message });
    this.name = 'CircleConfigurationError';
  }
}

export type CircleConfigurationPurpose =
  | 'user-controlled'
  | 'developer-controlled';

export type CircleExecutionConfiguration = Readonly<{
  arcNetwork: ArcNetworkKey;
  environment: 'testnet' | 'mainnet';
  blockchain: CircleBlockchain;
  apiBaseUrl: string;
  apiKey: string;
  applicationId: string | null;
  entitySecret: string | null;
  walletSetId: string | null;
  walletId: string | null;
  walletAddress: string | null;
  receiptConfirmations: number;
  support: ArcCircleExecutionDefinition['support'];
  receiptVerification: ArcCircleExecutionDefinition['receiptVerification'];
}>;

const LEGACY_ARC_CIRCLE_KEYS = Object.freeze([
  'CIRCLE_API_KEY',
  'CIRCLE_ENTITY_SECRET',
  'CIRCLE_BASE_URL',
  'CIRCLE_WALLETS_BASE_URL',
  'CIRCLE_TRANSFER_BLOCKCHAIN',
  'CIRCLE_WALLET_ID',
  'CIRCLE_WALLET_ID_ARC',
  'CIRCLE_WALLET_SET_ID_ARC',
  'CIRCLE_WALLET_ADDRESS_ARC',
  'CIRCLE_STABLEFX_API_KEY',
]);

const ALL_SCOPED_KEYS = Object.freeze(
  ['arc-testnet', 'arc-mainnet'].flatMap((network) =>
    Object.values(
      getArcCircleExecutionDefinition(network as ArcNetworkKey),
    ).filter(
      (value): value is string =>
        typeof value === 'string' && value.startsWith('CIRCLE_'),
    ),
  ),
);

function readExactOptional(
  environment: Record<string, string | undefined>,
  key: string,
): string | null {
  const value = environment[key];
  if (value === undefined) return null;
  if (!value || value !== value.trim()) {
    throw new CircleConfigurationError(
      CIRCLE_CONFIGURATION_ERROR_CODES.MISSING,
      `Selected Circle configuration ${key} must be a non-empty exact value.`,
    );
  }
  return value;
}

function requireSelected(
  environment: Record<string, string | undefined>,
  selectedKey: string,
  oppositeKey: string,
): string {
  const selected = readExactOptional(environment, selectedKey);
  if (selected) return selected;
  if (readExactOptional(environment, oppositeKey)) {
    throw new CircleConfigurationError(
      CIRCLE_CONFIGURATION_ERROR_CODES.CREDENTIAL_ENVIRONMENT_MISMATCH,
      'Circle credentials are configured only for a different environment.',
    );
  }
  throw new CircleConfigurationError(
    CIRCLE_CONFIGURATION_ERROR_CODES.MISSING,
    `Selected Circle configuration ${selectedKey} is required.`,
  );
}

export function validateCircleEnvironmentIsolation(
  environment: Record<string, string | undefined>,
): true {
  for (const key of LEGACY_ARC_CIRCLE_KEYS) {
    if (environment[key] !== undefined) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.AMBIGUOUS_CREDENTIAL,
        `Legacy unscoped Circle configuration ${key} is not accepted.`,
      );
    }
  }
  const testnet = getArcCircleExecutionDefinition('arc-testnet');
  const mainnet = getArcCircleExecutionDefinition('arc-mainnet');
  for (const [testnetKey, mainnetKey] of [
    [testnet.apiCredentialEnvironmentKey, mainnet.apiCredentialEnvironmentKey],
    [testnet.applicationIdEnvironmentKey, mainnet.applicationIdEnvironmentKey],
    [testnet.entitySecretEnvironmentKey, mainnet.entitySecretEnvironmentKey],
    [testnet.walletIdEnvironmentKey, mainnet.walletIdEnvironmentKey],
  ] as const) {
    const testnetValue = readExactOptional(environment, testnetKey);
    const mainnetValue = readExactOptional(environment, mainnetKey);
    if (testnetValue && mainnetValue && testnetValue === mainnetValue) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.CREDENTIAL_ENVIRONMENT_MISMATCH,
        'Circle Testnet and Mainnet identity or credential references must be distinct.',
      );
    }
  }
  const testnetWalletSet = readExactOptional(
    environment,
    testnet.walletSetIdEnvironmentKey,
  );
  const mainnetWalletSet = readExactOptional(
    environment,
    mainnet.walletSetIdEnvironmentKey,
  );
  if (
    testnetWalletSet &&
    mainnetWalletSet &&
    testnetWalletSet === mainnetWalletSet
  ) {
    throw new CircleConfigurationError(
      CIRCLE_CONFIGURATION_ERROR_CODES.WALLET_SET_MISMATCH,
      'Circle Testnet and Mainnet wallet-set identifiers must be distinct.',
    );
  }
  return true;
}

export function resolveCircleExecutionConfiguration(
  arcNetwork: ArcNetworkKey,
  environment: Record<string, string | undefined>,
  purpose: CircleConfigurationPurpose,
): CircleExecutionConfiguration {
  validateCircleEnvironmentIsolation(environment);
  const definition = getArcCircleExecutionDefinition(arcNetwork);
  let blockchain: CircleBlockchain;
  try {
    blockchain = requireArcCircleBlockchain(arcNetwork);
  } catch {
    throw new CircleConfigurationError(
      CIRCLE_CONFIGURATION_ERROR_CODES.BLOCKCHAIN_UNSUPPORTED,
      'Circle Wallets support for the selected Arc network is unverified.',
    );
  }
  const opposite = getArcCircleExecutionDefinition(
    arcNetwork === 'arc-testnet' ? 'arc-mainnet' : 'arc-testnet',
  );
  const apiKey = requireSelected(
    environment,
    definition.apiCredentialEnvironmentKey,
    opposite.apiCredentialEnvironmentKey,
  );
  const apiBaseUrl = requireSelected(
    environment,
    definition.apiBaseUrlEnvironmentKey,
    opposite.apiBaseUrlEnvironmentKey,
  );
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(apiBaseUrl);
  } catch {
    throw new CircleConfigurationError(
      CIRCLE_CONFIGURATION_ERROR_CODES.MISSING,
      'Selected Circle API base URL is invalid.',
    );
  }
  if (
    parsedBaseUrl.protocol !== 'https:' ||
    parsedBaseUrl.username ||
    parsedBaseUrl.password ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash ||
    parsedBaseUrl.pathname !== '/'
  ) {
    throw new CircleConfigurationError(
      CIRCLE_CONFIGURATION_ERROR_CODES.MISSING,
      'Selected Circle API base URL must be an HTTPS origin without credentials.',
    );
  }
  const applicationId = readExactOptional(
    environment,
    definition.applicationIdEnvironmentKey,
  );
  const entitySecret = readExactOptional(
    environment,
    definition.entitySecretEnvironmentKey,
  );
  const walletSetId = readExactOptional(
    environment,
    definition.walletSetIdEnvironmentKey,
  );
  const walletId = readExactOptional(
    environment,
    definition.walletIdEnvironmentKey,
  );
  const walletAddress = readExactOptional(
    environment,
    definition.walletAddressEnvironmentKey,
  );
  const receiptConfirmationsRaw = requireSelected(
    environment,
    definition.receiptConfirmationsEnvironmentKey,
    opposite.receiptConfirmationsEnvironmentKey,
  );
  const receiptConfirmations = Number(receiptConfirmationsRaw);
  if (
    !/^\d+$/.test(receiptConfirmationsRaw) ||
    !Number.isInteger(receiptConfirmations) ||
    receiptConfirmations < 1 ||
    receiptConfirmations > 100
  ) {
    throw new CircleConfigurationError(
      CIRCLE_CONFIGURATION_ERROR_CODES.MISSING,
      'Selected Circle receipt confirmations must be an integer from 1 to 100.',
    );
  }
  if (purpose === 'user-controlled' && !applicationId) {
    throw new CircleConfigurationError(
      CIRCLE_CONFIGURATION_ERROR_CODES.MISSING,
      `Selected Circle configuration ${definition.applicationIdEnvironmentKey} is required.`,
    );
  }
  if (purpose === 'developer-controlled') {
    for (const [key, value] of [
      [definition.entitySecretEnvironmentKey, entitySecret],
      [definition.walletSetIdEnvironmentKey, walletSetId],
      [definition.walletIdEnvironmentKey, walletId],
      [definition.walletAddressEnvironmentKey, walletAddress],
    ] as const) {
      if (!value) {
        throw new CircleConfigurationError(
          CIRCLE_CONFIGURATION_ERROR_CODES.MISSING,
          `Selected Circle configuration ${key} is required.`,
        );
      }
    }
  }
  return Object.freeze({
    arcNetwork,
    environment: definition.environment,
    blockchain,
    apiBaseUrl: parsedBaseUrl.origin,
    apiKey,
    applicationId,
    entitySecret,
    walletSetId,
    walletId,
    walletAddress,
    receiptConfirmations,
    support: definition.support,
    receiptVerification: definition.receiptVerification,
  });
}

export function circleEnvironmentFromConfigService(
  config: ConfigService,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const key of [...LEGACY_ARC_CIRCLE_KEYS, ...ALL_SCOPED_KEYS]) {
    const value = config.get<string>(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function resolveCircleConfigurationFromService(
  config: ConfigService,
  purpose: CircleConfigurationPurpose,
): CircleExecutionConfiguration {
  const arcNetwork = config.getOrThrow<ArcNetworkKey>('arcNetwork.key');
  return resolveCircleExecutionConfiguration(
    arcNetwork,
    circleEnvironmentFromConfigService(config),
    purpose,
  );
}
