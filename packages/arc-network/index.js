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
        : resource.status === "verified"
          ? "VERIFIED_RESOURCE_EXECUTION_DISABLED"
          : resource.status === "candidate"
            ? "CANDIDATE_RESOURCE_NOT_VERIFIED"
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

function verifiedNonExecutable(value, evidence) {
  return deepFreeze({
    status: "verified",
    value,
    evidence,
    executable: false,
  });
}

function candidate(value, evidence) {
  return deepFreeze({
    status: "candidate",
    value,
    evidence,
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
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new ArcNetworkInvariantError(
      "Arc network definitions must contain exactly Arc Mainnet.",
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
      entry.environment !== "mainnet" ||
      entry.key !== "arc-mainnet" ||
      entry.name !== "Arc Mainnet" ||
      !Number.isSafeInteger(entry.chainId) ||
      entry.chainId !== 5_042 ||
      entry.testnet !== false ||
      entry.nativeCurrency?.name !== "USDC" ||
      entry.nativeCurrency?.symbol !== "USDC" ||
      entry.nativeCurrency?.decimals !== 18
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
  {
    key: "arc-mainnet",
    name: "Arc Mainnet",
    chainId: 5_042,
    environment: "mainnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    testnet: false,
  },
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
  "arc-mainnet": available({ url: "https://rpc.mainnet.arc.io" }),
});

const ARC_EXPLORER_RESOURCES = deepFreeze({
  "arc-mainnet": available({ baseUrl: "https://explorer.arc.io" }),
});

const ARC_TOKEN_RESOURCES = deepFreeze({
  "arc-mainnet": {
    USDC: available({
      symbol: "USDC",
      address: assertContractAddress(
        "0x3600000000000000000000000000000000000000",
      ),
      decimals: 6,
      authoritativeSource:
        "https://docs.arc.io/arc/references/contract-addresses",
    }),
    EURC: available({
      symbol: "EURC",
      address: assertContractAddress(
        "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
      ),
      decimals: 6,
      authoritativeSource:
        "https://docs.arc.io/arc/references/contract-addresses",
    }),
  },
});

const ARC_WIZPAY_CONTRACT_RESOURCES = deepFreeze({
  "arc-mainnet": {
    wizpay: available({
      contract: "WizPayPayrollMainnet",
      address: assertContractAddress(
        "0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34",
      ),
      deploymentSource:
        "confirmed Arc Mainnet WizPayPayrollMainnet 0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34",
    }),
    "wizpay-swap-executor-v2": unavailable(
      "WIZPAY_MAINNET_CONTRACT_NOT_DEPLOYED",
    ),
    "wizpay-swap-executor-mainnet": available({
      contract: "WizPaySwapExecutorMainnet",
      address: assertContractAddress(
        "0x7A051F17B237750EF9D4E63fb75381B9F8755774",
      ),
      deploymentSource:
        "confirmed Arc Mainnet WizPaySwapExecutorMainnet 0x7A051F17B237750EF9D4E63fb75381B9F8755774",
    }),
  },
});

const ARC_PROTOCOL_CONTRACT_RESOURCES = deepFreeze({
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
      permit2: published({
        address: assertContractAddress(
          "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        ),
      }),
    },
  },
});

const ARC_PROTOCOL_CAPABILITY_RESOURCES = deepFreeze({
  "arc-mainnet": {
    uniswap: {
      "usdc-eurc-pool": unavailable("UNISWAP_USDC_EURC_POOL_NOT_VERIFIED"),
      "usdc-eurc-pool-key": candidate(
        {
          currency0: "0x3600000000000000000000000000000000000000",
          currency1: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
          fee: 500,
          tickSpacing: 10,
          hooks: "0x0000000000000000000000000000000000000000",
        },
        "packages/contracts/deployments/resource-evidence/arc-mainnet-uniswap-v4-usdc-eurc.candidate.json",
      ),
      "usdc-eurc-pool-id": candidate(
        "0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae",
        "packages/contracts/deployments/resource-evidence/arc-mainnet-uniswap-v4-usdc-eurc.candidate.json",
      ),
      "usdc-eurc-pool-uniqueness": unavailable(
        "UNISWAP_USDC_EURC_POOL_UNIQUENESS_NOT_VERIFIED",
      ),
      "usdc-eurc-liquidity": unavailable(
        "UNISWAP_USDC_EURC_LIQUIDITY_NOT_VERIFIED",
      ),
      "rpc-quorum": unavailable("ARC_MAINNET_RPC_QUORUM_UNAVAILABLE"),
      "official-resource-evidence": verifiedNonExecutable(
        {
          usdcToEurcTransaction:
            "0xf06b3035ca97902897906d7d89eeaecba7a9de484db031f1a51f8a914f0dfd07",
          eurcToUsdcTransaction:
            "0x8b080d9a77d033ec7a5da8a7b555012064481b1f7ce85b9f419e32d81543215a",
        },
        "read-only Arc Mainnet receipts",
      ),
      "execution-authorization": unavailable(
        "ARC_MAINNET_UNISWAP_EXECUTION_AUTHORIZATION_UNAVAILABLE",
      ),
    },
  },
});

const ARC_MAINNET_UNISWAP_V4_PUBLICATION = deepFreeze({
  network: "arc-mainnet",
  chainId: 5_042,
  pair: ["USDC", "EURC"],
  walletControl: ["external-wallet"],
  custody: "user-controlled-only",
  protocol: "uniswap-v4",
  deploymentSource:
    "https://github.com/Uniswap/contracts/blob/main/deployments/json/5042.json",
  universalRouterSource:
    "https://github.com/Uniswap/sdks/blob/main/sdks/universal-router-sdk/src/utils/constants.ts",
});

const ARC_CAPABILITY_NAMES = Object.freeze([
  "send",
  "sameTokenPayroll",
  "invoice",
  "paymentLink",
  "liquidity",
  "bridge",
  "swap",
  "crossTokenPayroll",
  "crossTokenInvoice",
  "nanoAgentApi",
]);

const ARC_MAINNET_CAPABILITIES = deepFreeze(
  Object.fromEntries(ARC_CAPABILITY_NAMES.map((name) => [name, false])),
);

const ARC_CAPABILITY_DEFINITIONS = deepFreeze({
  "arc-mainnet": ARC_MAINNET_CAPABILITIES,
});

const ARC_MAINNET_CAPABILITY_ENV_KEYS = deepFreeze({
  send: "WIZPAY_ARC_MAINNET_CAPABILITY_SEND",
  sameTokenPayroll: "WIZPAY_ARC_MAINNET_CAPABILITY_SAME_TOKEN_PAYROLL",
  invoice: "WIZPAY_ARC_MAINNET_CAPABILITY_INVOICE",
  paymentLink: "WIZPAY_ARC_MAINNET_CAPABILITY_PAYMENT_LINK",
  liquidity: "WIZPAY_ARC_MAINNET_CAPABILITY_LIQUIDITY",
  bridge: "WIZPAY_ARC_MAINNET_CAPABILITY_BRIDGE",
  swap: "WIZPAY_ARC_MAINNET_CAPABILITY_SWAP",
  crossTokenPayroll: "WIZPAY_ARC_MAINNET_CAPABILITY_CROSS_TOKEN_PAYROLL",
  crossTokenInvoice: "WIZPAY_ARC_MAINNET_CAPABILITY_CROSS_TOKEN_INVOICE",
  nanoAgentApi: "WIZPAY_ARC_MAINNET_CAPABILITY_NANO_AGENT_API",
});

const MAINNET_CONFIGURABLE_CAPABILITIES = new Set([
  "send",
  "sameTokenPayroll",
  "invoice",
  "paymentLink",
  "swap",
  "crossTokenPayroll",
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

  const capabilities = { ...ARC_MAINNET_CAPABILITIES };
  for (const capability of ARC_CAPABILITY_NAMES) {
    const envKey = ARC_MAINNET_CAPABILITY_ENV_KEYS[capability];
    const raw = environment[envKey];
    if (raw === undefined) continue;
    const enabled = parseStrictCapabilityBoolean(envKey, raw);
    if (enabled && !MAINNET_CONFIGURABLE_CAPABILITIES.has(capability)) {
      throw new ArcCapabilityConfigurationError(
        "CAPABILITY_FORBIDDEN_FOR_NETWORK",
        `${capability} cannot be enabled for Arc Mainnet while required execution resources are unavailable.`,
        capability,
      );
    }
    capabilities[capability] = enabled;
  }

  const operationResources = getArcOperationResourceReadiness(key);
  for (const [capability, resource] of [
    ["send", "sendDirect"],
    ["sameTokenPayroll", "payrollDirect"],
    ["invoice", "invoiceCreation"],
    ["paymentLink", "paymentLinkDirect"],
    ["swap", "swapDirect"],
    ["crossTokenPayroll", "crossToken"],
  ]) {
    if (capabilities[capability] && !operationResources[resource]) {
      throw new ArcCapabilityConfigurationError(
        "CAPABILITY_RESOURCE_DEPENDENCY_UNAVAILABLE",
        `${capability} requires its operation-specific Arc resources.`,
        capability,
      );
    }
  }
  if (capabilities.crossTokenPayroll && !capabilities.swap) {
    throw new ArcCapabilityConfigurationError(
      "CONTRADICTORY_CAPABILITY_CONFIGURATION",
      "crossTokenPayroll requires swap.",
      "crossTokenPayroll",
    );
  }

  return deepFreeze(capabilities);
}

function getArcOperationResourceReadiness(networkKey) {
  const key = parseArcNetworkKey(networkKey);
  const rpc = ARC_RPC_RESOURCES[key].status === "available";
  const explorer = ARC_EXPLORER_RESOURCES[key].status === "available";
  const usdc = ARC_TOKEN_RESOURCES[key].USDC.status === "available";
  const eurc = ARC_TOKEN_RESOURCES[key].EURC.status === "available";
  const payrollContract =
    ARC_WIZPAY_CONTRACT_RESOURCES[key].wizpay.status === "available";
  const swapExecutor =
    ARC_WIZPAY_CONTRACT_RESOURCES[key]["wizpay-swap-executor-v2"].status ===
      "available" ||
    ARC_WIZPAY_CONTRACT_RESOURCES[key]["wizpay-swap-executor-mainnet"]
      ?.status === "available";
  const swapDirect = rpc && usdc && eurc && swapExecutor;
  return deepFreeze({
    sendDirect: rpc && explorer && usdc,
    payrollDirect: rpc && usdc && payrollContract,
    invoiceCreation: usdc,
    paymentLinkDirect: rpc && usdc,
    swapDirect,
    crossToken: swapDirect && payrollContract,
  });
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
  requireResource(
    "send",
    resources.sendDirect === undefined ? "directPayment" : "sendDirect",
  );
  requireResource(
    "sameTokenPayroll",
    resources.payrollDirect === undefined ? "directPayment" : "payrollDirect",
  );
  requireResource(
    "invoice",
    resources.invoiceCreation === undefined
      ? "directPayment"
      : "invoiceCreation",
  );
  requireResource(
    "paymentLink",
    resources.paymentLinkDirect === undefined
      ? "directPayment"
      : "paymentLinkDirect",
  );
  requireResource("bridge", "bridge");
  requireResource("swap", "swap");
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

function getArcMainnetUniswapV4Readiness() {
  const capabilityKeys = [
    "usdc-eurc-pool-key",
    "usdc-eurc-pool-id",
    "usdc-eurc-pool-uniqueness",
    "usdc-eurc-liquidity",
    "rpc-quorum",
    "official-resource-evidence",
    "execution-authorization",
  ];
  const blockers = capabilityKeys
    .map((key) =>
      getArcProtocolCapabilityResource("arc-mainnet", "uniswap", key),
    )
    .filter((resource) => resource.status === "unavailable")
    .map((resource) => resource.reason);
  return deepFreeze({
    ...ARC_MAINNET_UNISWAP_V4_PUBLICATION,
    tokens: {
      USDC: getArcTokenResource("arc-mainnet", "USDC"),
      EURC: getArcTokenResource("arc-mainnet", "EURC"),
    },
    contracts: {
      poolManager: getArcProtocolContractResource(
        "arc-mainnet",
        "uniswap-v4",
        "poolManager",
      ),
      stateView: getArcProtocolContractResource(
        "arc-mainnet",
        "uniswap-v4",
        "stateView",
      ),
      quoter: getArcProtocolContractResource(
        "arc-mainnet",
        "uniswap-v4",
        "quoter",
      ),
      universalRouter: getArcProtocolContractResource(
        "arc-mainnet",
        "universal-router",
        "universalRouter",
      ),
      permit2: getArcProtocolContractResource(
        "arc-mainnet",
        "universal-router",
        "permit2",
      ),
    },
    poolKey: getArcProtocolCapabilityResource(
      "arc-mainnet",
      "uniswap",
      "usdc-eurc-pool-key",
    ),
    poolId: getArcProtocolCapabilityResource(
      "arc-mainnet",
      "uniswap",
      "usdc-eurc-pool-id",
    ),
    poolUniqueness: getArcProtocolCapabilityResource(
      "arc-mainnet",
      "uniswap",
      "usdc-eurc-pool-uniqueness",
    ),
    liquidity: getArcProtocolCapabilityResource(
      "arc-mainnet",
      "uniswap",
      "usdc-eurc-liquidity",
    ),
    rpcQuorum: getArcProtocolCapabilityResource(
      "arc-mainnet",
      "uniswap",
      "rpc-quorum",
    ),
    officialResourceEvidence: getArcProtocolCapabilityResource(
      "arc-mainnet",
      "uniswap",
      "official-resource-evidence",
    ),
    executionAuthorization: getArcProtocolCapabilityResource(
      "arc-mainnet",
      "uniswap",
      "execution-authorization",
    ),
    capabilityEnabled: false,
    executable: false,
    blockers,
  });
}

function requireAvailableArcResource(resource) {
  if (!resource || typeof resource !== "object") {
    throw new UnknownArcResourceError("availability", resource);
  }
  if (resource.status !== "available") {
    if (
      resource.status === "published" ||
      resource.status === "candidate" ||
      resource.status === "verified" ||
      resource.status === "unavailable"
    ) {
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
  ARC_MAINNET_UNISWAP_V4_PUBLICATION,
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
  getArcMainnetUniswapV4Readiness,
  getArcOperationResourceReadiness,
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
