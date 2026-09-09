"use strict";

class ArcNetworkInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArcNetworkInvariantError";
    this.code = "ARC_NETWORK_INVARIANT_VIOLATION";
  }
}

class UnsupportedArcNetworkError extends Error {
  constructor(code, value) {
    super(
      code === "UNSUPPORTED_ARC_NETWORK_KEY"
        ? `Unsupported Arc network key: ${JSON.stringify(value)}.`
        : `Unsupported Arc chain ID: ${String(value)}.`,
    );
    this.name = "UnsupportedArcNetworkError";
    this.code = code;
  }
}

class UnknownArcResourceError extends Error {
  constructor(resourceType, key) {
    super(`Unknown Arc ${resourceType} resource: ${JSON.stringify(key)}.`);
    this.name = "UnknownArcResourceError";
    this.code = "UNKNOWN_ARC_RESOURCE";
    this.resourceType = resourceType;
  }
}

class UnavailableArcResourceError extends Error {
  constructor(resource) {
    const reason =
      resource.status === "published"
        ? "PUBLISHED_RESOURCE_ONCHAIN_VERIFICATION_PENDING"
        : resource.reason;
    super(`Arc resource is not available: ${reason}.`);
    this.name = "UnavailableArcResourceError";
    this.code = "ARC_RESOURCE_NOT_AVAILABLE";
    this.resourceStatus = resource.status;
    this.reason = reason;
  }
}

class ArcCapabilityConfigurationError extends Error {
  constructor(code, message, capability) {
    super(message);
    this.name = "ArcCapabilityConfigurationError";
    this.code = code;
    this.capability = capability;
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function available(value) {
  return deepFreeze({ status: "available", value });
}

function published(value) {
  return deepFreeze({
    status: "published",
    value,
    verification: "onchain-pending",
    executable: false,
  });
}

function unavailable(reason) {
  return deepFreeze({ status: "unavailable", reason });
}

function assertContractAddress(address) {
  if (
    typeof address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(address) ||
    /^0x0{40}$/.test(address)
  ) {
    throw new ArcNetworkInvariantError(
      `Invalid Arc contract address: ${String(address)}.`,
    );
  }
  return address;
}

function assertValidDefinitionShape(entries) {
  if (!Array.isArray(entries) || entries.length !== 2) {
    throw new ArcNetworkInvariantError(
      "Arc network definitions must contain exactly testnet and mainnet.",
    );
  }

  const keys = new Set();
  const chainIds = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw new ArcNetworkInvariantError(
        "Arc network definitions must be objects.",
      );
    }
    if (keys.has(entry.key)) {
      throw new ArcNetworkInvariantError(
        `Duplicate Arc network key: ${String(entry.key)}.`,
      );
    }
    if (chainIds.has(entry.chainId)) {
      throw new ArcNetworkInvariantError(
        `Duplicate Arc chain ID: ${String(entry.chainId)}.`,
      );
    }

    if (
      (entry.environment !== "testnet" && entry.environment !== "mainnet") ||
      entry.key !== `arc-${entry.environment}` ||
      !Number.isSafeInteger(entry.chainId) ||
      entry.chainId <= 0
    ) {
      throw new ArcNetworkInvariantError(
        `Invalid Arc network definition: ${String(entry.key)}.`,
      );
    }

    keys.add(entry.key);
    chainIds.add(entry.chainId);
  }

  return true;
}

const definitions = [
  { key: "arc-testnet", chainId: 5_042_002, environment: "testnet" },
  { key: "arc-mainnet", chainId: 5_042, environment: "mainnet" },
];

assertValidDefinitionShape(definitions);

const ARC_NETWORK_DEFINITIONS = Object.freeze(
  definitions.map((definition) => Object.freeze({ ...definition })),
);
const ARC_NETWORK_BY_KEY = new Map(
  ARC_NETWORK_DEFINITIONS.map((definition) => [definition.key, definition]),
);
const ARC_NETWORK_BY_CHAIN_ID = new Map(
  ARC_NETWORK_DEFINITIONS.map((definition) => [definition.chainId, definition]),
);

const ARC_RPC_RESOURCES = deepFreeze({
  "arc-testnet": available({ url: "https://rpc.testnet.arc.io" }),
  "arc-mainnet": unavailable("OFFICIAL_ARC_MAINNET_RPC_UNAVAILABLE"),
});

const ARC_EXPLORER_RESOURCES = deepFreeze({
  "arc-testnet": available({ baseUrl: "https://testnet.arcscan.app" }),
  "arc-mainnet": unavailable("OFFICIAL_ARC_MAINNET_EXPLORER_UNAVAILABLE"),
});

const ARC_TOKEN_RESOURCES = deepFreeze({
  "arc-testnet": {
    USDC: available({
      symbol: "USDC",
      address: assertContractAddress(
        "0x3600000000000000000000000000000000000000",
      ),
      decimals: 6,
    }),
    EURC: available({
      symbol: "EURC",
      address: assertContractAddress(
        "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
      ),
      decimals: 6,
    }),
  },
  "arc-mainnet": {
    USDC: unavailable("CIRCLE_ARC_MAINNET_USDC_NOT_YET_CONFIRMED"),
    EURC: unavailable("CIRCLE_ARC_MAINNET_EURC_NOT_YET_CONFIRMED"),
  },
});

const ARC_WIZPAY_CONTRACT_RESOURCES = deepFreeze({
  "arc-testnet": {
    wizpay: available({
      contract: "WizPay",
      address: assertContractAddress(
        "0x87ACE45582f45cC81AC1E627E875AE84cbd75946",
      ),
      deploymentSource:
        "packages/contracts/deployments/arc-testnet-wizpay-v2.json",
    }),
    "wizpay-swap-executor-v2": available({
      contract: "WizPaySwapExecutorV2",
      address: assertContractAddress(
        "0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed",
      ),
      deploymentSource:
        "packages/contracts/deployments/arc-testnet-wizpay-swap-executor-v2.json",
    }),
  },
  "arc-mainnet": {
    wizpay: unavailable("WIZPAY_MAINNET_CONTRACT_NOT_DEPLOYED"),
    "wizpay-swap-executor-v2": unavailable(
      "WIZPAY_MAINNET_CONTRACT_NOT_DEPLOYED",
    ),
  },
});

const TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE = unavailable(
  "EXTERNAL_PROTOCOL_CONTRACT_NOT_RECORDED_FOR_ARC_TESTNET",
);

const ARC_PROTOCOL_CONTRACT_RESOURCES = deepFreeze({
  "arc-testnet": {
    "uniswap-v3": {
      v3CoreFactory: TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
      multicall: TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
      quoter: TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
      nonfungiblePositionManager:
        TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
      tickLens: TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
      swapRouter02: TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
    },
    "uniswap-v4": {
      poolManager: TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
      positionManager: TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
      stateView: TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
      quoter: TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
    },
    "universal-router": {
      universalRouter: TESTNET_EXTERNAL_PROTOCOL_CONTRACT_UNAVAILABLE,
    },
  },
  "arc-mainnet": {
    "uniswap-v3": {
      v3CoreFactory: published({
        address: assertContractAddress(
          "0xf0db7b58379503491d857db50ac9ece64c653918",
        ),
      }),
      multicall: published({
        address: assertContractAddress(
          "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
        ),
      }),
      quoter: published({
        address: assertContractAddress(
          "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
        ),
      }),
      nonfungiblePositionManager: published({
        address: assertContractAddress(
          "0x39654a85a4c05127f5fd6ed22caec077a0fb1377",
        ),
      }),
      tickLens: published({
        address: assertContractAddress(
          "0x9eb8600665b55d10c1eb2316ca5127a9ca6e2e76",
        ),
      }),
      swapRouter02: published({
        address: assertContractAddress(
          "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77",
        ),
      }),
    },
    "uniswap-v4": {
      poolManager: published({
        address: assertContractAddress(
          "0x8366a39cc670b4001a1121b8f6a443a643e40951",
        ),
      }),
      positionManager: published({
        address: assertContractAddress(
          "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b",
        ),
      }),
      stateView: published({
        address: assertContractAddress(
          "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
        ),
      }),
      quoter: published({
        address: assertContractAddress(
          "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
        ),
      }),
    },
    "universal-router": {
      universalRouter: published({
        address: assertContractAddress(
          "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
        ),
        version: "2.1.1",
        creationBlock: 1_950_059,
      }),
    },
  },
});

const ARC_PROTOCOL_CAPABILITY_RESOURCES = deepFreeze({
  "arc-testnet": { uniswap: {} },
  "arc-mainnet": {
    uniswap: {
      "usdc-eurc-pool": unavailable("UNISWAP_USDC_EURC_POOL_NOT_VERIFIED"),
      "usdc-eurc-liquidity": unavailable(
        "UNISWAP_USDC_EURC_LIQUIDITY_NOT_VERIFIED",
      ),
    },
  },
});

const ARC_CAPABILITY_NAMES = Object.freeze([
  "send",
  "sameTokenPayroll",
  "invoice",
  "paymentLink",
  "bridge",
  "swap",
  "crossTokenPayroll",
  "crossTokenInvoice",
  "stableFx",
  "nanoAgentApi",
]);

const ARC_TESTNET_CAPABILITIES = deepFreeze({
  send: true,
  sameTokenPayroll: true,
  invoice: true,
  paymentLink: true,
  bridge: true,
  swap: true,
  crossTokenPayroll: true,
  crossTokenInvoice: false,
  stableFx: false,
  nanoAgentApi: false,
});

const ARC_MAINNET_CAPABILITIES = deepFreeze(
  Object.fromEntries(ARC_CAPABILITY_NAMES.map((name) => [name, false])),
);

const ARC_CAPABILITY_DEFINITIONS = deepFreeze({
  "arc-testnet": ARC_TESTNET_CAPABILITIES,
  "arc-mainnet": ARC_MAINNET_CAPABILITIES,
});

const ARC_MAINNET_CAPABILITY_ENV_KEYS = deepFreeze({
  send: "WIZPAY_ARC_MAINNET_CAPABILITY_SEND",
  sameTokenPayroll: "WIZPAY_ARC_MAINNET_CAPABILITY_SAME_TOKEN_PAYROLL",
  invoice: "WIZPAY_ARC_MAINNET_CAPABILITY_INVOICE",
  paymentLink: "WIZPAY_ARC_MAINNET_CAPABILITY_PAYMENT_LINK",
  bridge: "WIZPAY_ARC_MAINNET_CAPABILITY_BRIDGE",
  swap: "WIZPAY_ARC_MAINNET_CAPABILITY_SWAP",
  crossTokenPayroll: "WIZPAY_ARC_MAINNET_CAPABILITY_CROSS_TOKEN_PAYROLL",
  crossTokenInvoice: "WIZPAY_ARC_MAINNET_CAPABILITY_CROSS_TOKEN_INVOICE",
  stableFx: "WIZPAY_ARC_MAINNET_CAPABILITY_STABLE_FX",
  nanoAgentApi: "WIZPAY_ARC_MAINNET_CAPABILITY_NANO_AGENT_API",
});

const MAINNET_CONFIGURABLE_CAPABILITIES = new Set([
  "send",
  "sameTokenPayroll",
  "invoice",
  "paymentLink",
]);

function parseArcCapabilityName(value) {
  if (typeof value !== "string" || !ARC_CAPABILITY_NAMES.includes(value)) {
    throw new ArcCapabilityConfigurationError(
      "UNKNOWN_CAPABILITY",
      `Unknown Arc capability: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function parseStrictCapabilityBoolean(key, value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ArcCapabilityConfigurationError(
    "INVALID_CAPABILITY_CONFIGURATION",
    `${key} must be exactly "true" or "false" when configured.`,
  );
}

function assertKnownCapabilityEnvironmentKeys(environment) {
  const knownKeys = new Set(Object.values(ARC_MAINNET_CAPABILITY_ENV_KEYS));
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("WIZPAY_ARC_MAINNET_CAPABILITY_") &&
      !knownKeys.has(key)
    ) {
      throw new ArcCapabilityConfigurationError(
        "UNKNOWN_CAPABILITY_CONFIGURATION",
        `Unknown Arc capability configuration key: ${key}.`,
      );
    }
  }
}

function resolveArcCapabilities(networkKey, environment = {}) {
  const key = parseArcNetworkKey(networkKey);
  assertKnownCapabilityEnvironmentKeys(environment);

  if (key === "arc-testnet") {
    for (const envKey of Object.values(ARC_MAINNET_CAPABILITY_ENV_KEYS)) {
      if (environment[envKey] === undefined) continue;
      const enabled = parseStrictCapabilityBoolean(envKey, environment[envKey]);
      if (enabled) {
        throw new ArcCapabilityConfigurationError(
          "CONTRADICTORY_CAPABILITY_CONFIGURATION",
          `${envKey} cannot configure Arc Testnet capabilities.`,
        );
      }
    }
    return ARC_TESTNET_CAPABILITIES;
  }

  const capabilities = { ...ARC_MAINNET_CAPABILITIES };
  for (const capability of ARC_CAPABILITY_NAMES) {
    const envKey = ARC_MAINNET_CAPABILITY_ENV_KEYS[capability];
    const raw = environment[envKey];
    if (raw === undefined) continue;
    const enabled = parseStrictCapabilityBoolean(envKey, raw);
    if (enabled && !MAINNET_CONFIGURABLE_CAPABILITIES.has(capability)) {
      throw new ArcCapabilityConfigurationError(
        "CAPABILITY_FORBIDDEN_FOR_NETWORK",
        `${capability} cannot be enabled for Arc Mainnet in Phase 2.`,
        capability,
      );
    }
    capabilities[capability] = enabled;
  }

  const directResourcesAvailable =
    ARC_RPC_RESOURCES[key].status === "available" &&
    ARC_TOKEN_RESOURCES[key].USDC.status === "available" &&
    ARC_TOKEN_RESOURCES[key].EURC.status === "available";
  for (const capability of [
    "send",
    "sameTokenPayroll",
    "invoice",
    "paymentLink",
  ]) {
    if (capabilities[capability] && !directResourcesAvailable) {
      throw new ArcCapabilityConfigurationError(
        "CAPABILITY_RESOURCE_DEPENDENCY_UNAVAILABLE",
        `${capability} requires verified Arc RPC and token resources.`,
        capability,
      );
    }
  }

  return deepFreeze(capabilities);
}

function isArcCapabilityEnabled(capabilities, capability) {
  const name = parseArcCapabilityName(capability);
  return capabilities[name] === true;
}

function validateArcCapabilityDependencies(capabilities, resources) {
  for (const name of ARC_CAPABILITY_NAMES) parseArcCapabilityName(name);
  const requireResource = (capability, resource) => {
    if (capabilities[capability] && resources[resource] !== true) {
      throw new ArcCapabilityConfigurationError(
        "CAPABILITY_RESOURCE_DEPENDENCY_UNAVAILABLE",
        `${capability} requires ${resource} resources.`,
        capability,
      );
    }
  };
  for (const capability of [
    "send",
    "sameTokenPayroll",
    "invoice",
    "paymentLink",
  ]) {
    requireResource(capability, "directPayment");
  }
  requireResource("bridge", "bridge");
  requireResource("swap", "swap");
  requireResource("stableFx", "stableFx");
  requireResource("nanoAgentApi", "nanoAgentApi");
  if (capabilities.crossTokenPayroll && !capabilities.swap) {
    throw new ArcCapabilityConfigurationError(
      "CONTRADICTORY_CAPABILITY_CONFIGURATION",
      "crossTokenPayroll requires swap.",
      "crossTokenPayroll",
    );
  }
  if (capabilities.crossTokenInvoice && !capabilities.swap) {
    throw new ArcCapabilityConfigurationError(
      "CONTRADICTORY_CAPABILITY_CONFIGURATION",
      "crossTokenInvoice requires swap.",
      "crossTokenInvoice",
    );
  }
  return true;
}

function assertValidArcNetworkDefinitions(entries) {
  assertValidDefinitionShape(entries);

  for (const entry of entries) {
    const expected = ARC_NETWORK_BY_KEY.get(entry.key);
    if (
      !expected ||
      entry.chainId !== expected.chainId ||
      entry.environment !== expected.environment
    ) {
      throw new ArcNetworkInvariantError(
        `Invalid Arc network definition: ${String(entry.key)}.`,
      );
    }
  }

  return true;
}

assertValidArcNetworkDefinitions(ARC_NETWORK_DEFINITIONS);

function parseArcNetworkKey(value) {
  if (typeof value !== "string" || !ARC_NETWORK_BY_KEY.has(value)) {
    throw new UnsupportedArcNetworkError("UNSUPPORTED_ARC_NETWORK_KEY", value);
  }
  return value;
}

function getArcNetworkByKey(value) {
  return ARC_NETWORK_BY_KEY.get(parseArcNetworkKey(value));
}

function getArcNetworkByChainId(value) {
  const definition = ARC_NETWORK_BY_CHAIN_ID.get(value);
  if (!definition) {
    throw new UnsupportedArcNetworkError("UNSUPPORTED_ARC_CHAIN_ID", value);
  }
  return definition;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function getNetworkRegistry(registry, networkKey) {
  return registry[parseArcNetworkKey(networkKey)];
}

function getArcRpcResource(networkKey) {
  return getNetworkRegistry(ARC_RPC_RESOURCES, networkKey);
}

function getArcExplorerResource(networkKey) {
  return getNetworkRegistry(ARC_EXPLORER_RESOURCES, networkKey);
}

function getArcTokenResource(networkKey, tokenSymbol) {
  const resources = getNetworkRegistry(ARC_TOKEN_RESOURCES, networkKey);
  if (!hasOwn(resources, tokenSymbol)) {
    throw new UnknownArcResourceError("token", tokenSymbol);
  }
  return resources[tokenSymbol];
}

function getArcWizPayContractResource(networkKey, contractKey) {
  const resources = getNetworkRegistry(
    ARC_WIZPAY_CONTRACT_RESOURCES,
    networkKey,
  );
  if (!hasOwn(resources, contractKey)) {
    throw new UnknownArcResourceError("WizPay contract", contractKey);
  }
  return resources[contractKey];
}

function getArcProtocolContractResource(networkKey, protocol, contractKey) {
  const protocols = getNetworkRegistry(
    ARC_PROTOCOL_CONTRACT_RESOURCES,
    networkKey,
  );
  if (!hasOwn(protocols, protocol)) {
    throw new UnknownArcResourceError("protocol", protocol);
  }
  if (!hasOwn(protocols[protocol], contractKey)) {
    throw new UnknownArcResourceError("protocol contract", contractKey);
  }
  return protocols[protocol][contractKey];
}

function getArcProtocolCapabilityResource(networkKey, protocol, capabilityKey) {
  const protocols = getNetworkRegistry(
    ARC_PROTOCOL_CAPABILITY_RESOURCES,
    networkKey,
  );
  if (!hasOwn(protocols, protocol)) {
    throw new UnknownArcResourceError("protocol", protocol);
  }
  if (!hasOwn(protocols[protocol], capabilityKey)) {
    throw new UnknownArcResourceError("protocol capability", capabilityKey);
  }
  return protocols[protocol][capabilityKey];
}

function requireAvailableArcResource(resource) {
  if (!resource || typeof resource !== "object") {
    throw new UnknownArcResourceError("availability", resource);
  }
  if (resource.status !== "available") {
    if (resource.status === "published" || resource.status === "unavailable") {
      throw new UnavailableArcResourceError(resource);
    }
    throw new UnknownArcResourceError("availability", resource.status);
  }
  return resource.value;
}

module.exports = {
  ARC_EXPLORER_RESOURCES,
  ARC_CAPABILITY_DEFINITIONS,
  ARC_CAPABILITY_NAMES,
  ARC_MAINNET_CAPABILITY_ENV_KEYS,
  ARC_NETWORK_DEFINITIONS,
  ARC_PROTOCOL_CAPABILITY_RESOURCES,
  ARC_PROTOCOL_CONTRACT_RESOURCES,
  ARC_RPC_RESOURCES,
  ARC_TOKEN_RESOURCES,
  ARC_WIZPAY_CONTRACT_RESOURCES,
  ArcNetworkInvariantError,
  ArcCapabilityConfigurationError,
  UnavailableArcResourceError,
  UnknownArcResourceError,
  UnsupportedArcNetworkError,
  assertValidArcNetworkDefinitions,
  getArcExplorerResource,
  getArcNetworkByChainId,
  getArcNetworkByKey,
  getArcProtocolCapabilityResource,
  getArcProtocolContractResource,
  getArcRpcResource,
  getArcTokenResource,
  getArcWizPayContractResource,
  isArcCapabilityEnabled,
  parseArcCapabilityName,
  parseArcNetworkKey,
  requireAvailableArcResource,
  resolveArcCapabilities,
  validateArcCapabilityDependencies,
};
