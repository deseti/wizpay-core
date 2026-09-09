"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ARC_EXPLORER_RESOURCES,
  ARC_NETWORK_DEFINITIONS,
  ARC_PROTOCOL_CAPABILITY_RESOURCES,
  ARC_PROTOCOL_CONTRACT_RESOURCES,
  ARC_RPC_RESOURCES,
  ARC_TOKEN_RESOURCES,
  ARC_WIZPAY_CONTRACT_RESOURCES,
  ArcNetworkInvariantError,
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
  parseArcNetworkKey,
  requireAvailableArcResource,
  ARC_CAPABILITY_DEFINITIONS,
  resolveArcCapabilities,
  parseArcCapabilityName,
  validateArcCapabilityDependencies,
} = require(".");

test("defines explicit Arc Testnet capabilities and all-false Arc Mainnet defaults", () => {
  assert.deepEqual(ARC_CAPABILITY_DEFINITIONS["arc-testnet"], {
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
  assert.equal(
    Object.values(resolveArcCapabilities("arc-mainnet", {})).every(
      (value) => value === false,
    ),
    true,
  );
});

test("keeps configurable Mainnet flags false when absent or explicitly false", () => {
  const configured = resolveArcCapabilities("arc-mainnet", {
    WIZPAY_ARC_MAINNET_CAPABILITY_SEND: "false",
    WIZPAY_ARC_MAINNET_CAPABILITY_SAME_TOKEN_PAYROLL: "false",
    WIZPAY_ARC_MAINNET_CAPABILITY_INVOICE: "false",
    WIZPAY_ARC_MAINNET_CAPABILITY_PAYMENT_LINK: "false",
  });
  for (const capability of [
    "send",
    "sameTokenPayroll",
    "invoice",
    "paymentLink",
  ]) {
    assert.equal(configured[capability], false);
  }
});

test("rejects Mainnet flags on Testnet as contradictory configuration", () => {
  assert.throws(
    () =>
      resolveArcCapabilities("arc-testnet", {
        WIZPAY_ARC_MAINNET_CAPABILITY_SEND: "true",
      }),
    (error) => error.code === "CONTRADICTORY_CAPABILITY_CONFIGURATION",
  );
});

test("parses capability flags exactly and fails closed for malformed or unknown input", () => {
  for (const value of ["TRUE", " true", "true ", "1", "yes", ""]) {
    assert.throws(
      () =>
        resolveArcCapabilities("arc-mainnet", {
          WIZPAY_ARC_MAINNET_CAPABILITY_SEND: value,
        }),
      (error) => error.code === "INVALID_CAPABILITY_CONFIGURATION",
    );
  }
  assert.throws(
    () => parseArcCapabilityName("Send"),
    (error) => error.code === "UNKNOWN_CAPABILITY",
  );
  assert.throws(
    () =>
      resolveArcCapabilities("arc-mainnet", {
        WIZPAY_ARC_MAINNET_CAPABILITY_UNKNOWN: "false",
      }),
    (error) => error.code === "UNKNOWN_CAPABILITY_CONFIGURATION",
  );
});

test("rejects forbidden Mainnet enablement and unavailable direct resources", () => {
  assert.throws(
    () =>
      resolveArcCapabilities("arc-mainnet", {
        WIZPAY_ARC_MAINNET_CAPABILITY_SWAP: "true",
      }),
    (error) => error.code === "CAPABILITY_FORBIDDEN_FOR_NETWORK",
  );
  assert.throws(
    () =>
      resolveArcCapabilities("arc-mainnet", {
        WIZPAY_ARC_MAINNET_CAPABILITY_SEND: "true",
      }),
    (error) => error.code === "CAPABILITY_RESOURCE_DEPENDENCY_UNAVAILABLE",
  );
});

test("rejects dependency-invalid capability combinations", () => {
  const allFalse = resolveArcCapabilities("arc-mainnet", {});
  assert.throws(
    () =>
      validateArcCapabilityDependencies(
        { ...allFalse, crossTokenPayroll: true },
        {
          directPayment: true,
          bridge: true,
          swap: true,
          stableFx: true,
          nanoAgentApi: true,
        },
      ),
    (error) => error.code === "CONTRADICTORY_CAPABILITY_CONFIGURATION",
  );
  assert.throws(
    () =>
      validateArcCapabilityDependencies(
        { ...allFalse, bridge: true },
        {
          directPayment: true,
          bridge: false,
          swap: true,
          stableFx: true,
          nanoAgentApi: true,
        },
      ),
    (error) => error.code === "CAPABILITY_RESOURCE_DEPENDENCY_UNAVAILABLE",
  );
});

test("defines the exact Arc Testnet and Mainnet identities", () => {
  assert.deepEqual(ARC_NETWORK_DEFINITIONS, [
    { key: "arc-testnet", chainId: 5_042_002, environment: "testnet" },
    { key: "arc-mainnet", chainId: 5_042, environment: "mainnet" },
  ]);
  assert.notEqual(
    ARC_NETWORK_DEFINITIONS[0].chainId,
    ARC_NETWORK_DEFINITIONS[1].chainId,
  );
});

test("resolves both exact network keys", () => {
  assert.equal(getArcNetworkByKey("arc-testnet").chainId, 5_042_002);
  assert.equal(getArcNetworkByKey("arc-mainnet").chainId, 5_042);
  assert.equal(parseArcNetworkKey("arc-testnet"), "arc-testnet");
  assert.equal(parseArcNetworkKey("arc-mainnet"), "arc-mainnet");
});

test("resolves both exact chain IDs", () => {
  assert.equal(getArcNetworkByChainId(5_042_002).key, "arc-testnet");
  assert.equal(getArcNetworkByChainId(5_042).key, "arc-mainnet");
});

test("strictly rejects empty, whitespace, unknown, case-modified, and near-match keys", () => {
  for (const value of [
    "",
    "   ",
    "unknown",
    "ARC-TESTNET",
    "arc-Testnet",
    "arc-testnet ",
    "arc-main",
    undefined,
    null,
  ]) {
    assert.throws(
      () => getArcNetworkByKey(value),
      (error) =>
        error instanceof UnsupportedArcNetworkError &&
        error.code === "UNSUPPORTED_ARC_NETWORK_KEY",
    );
  }
});

test("rejects unknown and malformed chain IDs without a default", () => {
  for (const value of [0, 1, 5_043, 50_420_020, "5042", undefined, null]) {
    assert.throws(
      () => getArcNetworkByChainId(value),
      (error) =>
        error instanceof UnsupportedArcNetworkError &&
        error.code === "UNSUPPORTED_ARC_CHAIN_ID",
    );
  }
});

test("exposes frozen definitions", () => {
  assert.equal(Object.isFrozen(ARC_NETWORK_DEFINITIONS), true);
  for (const definition of ARC_NETWORK_DEFINITIONS) {
    assert.equal(Object.isFrozen(definition), true);
    assert.throws(() => {
      definition.chainId = 1;
    }, TypeError);
  }
  assert.equal(getArcNetworkByKey("arc-mainnet").chainId, 5_042);
});

test("validates key, chain ID, and environment relationships", () => {
  assert.equal(assertValidArcNetworkDefinitions(ARC_NETWORK_DEFINITIONS), true);
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        { key: "arc-testnet", chainId: 5_042_002, environment: "mainnet" },
        { key: "arc-mainnet", chainId: 5_042, environment: "mainnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("rejects arc-mainnet with chain ID 5043", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        ARC_NETWORK_DEFINITIONS[0],
        { key: "arc-mainnet", chainId: 5_043, environment: "mainnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("rejects arc-testnet with chain ID 5042", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        { key: "arc-testnet", chainId: 5_042, environment: "testnet" },
        ARC_NETWORK_DEFINITIONS[1],
      ]),
    ArcNetworkInvariantError,
  );
});

test("rejects swapped canonical chain IDs", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        { key: "arc-testnet", chainId: 5_042, environment: "testnet" },
        { key: "arc-mainnet", chainId: 5_042_002, environment: "mainnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("rejects arbitrary positive chain IDs with correct keys and environments", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        { key: "arc-testnet", chainId: 7, environment: "testnet" },
        { key: "arc-mainnet", chainId: 8, environment: "mainnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("detects duplicate keys and chain IDs", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        ARC_NETWORK_DEFINITIONS[0],
        { ...ARC_NETWORK_DEFINITIONS[0] },
      ]),
    /Duplicate Arc network key/,
  );
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        ARC_NETWORK_DEFINITIONS[0],
        {
          ...ARC_NETWORK_DEFINITIONS[1],
          chainId: ARC_NETWORK_DEFINITIONS[0].chainId,
        },
      ]),
    /Duplicate Arc chain ID/,
  );
});

test("resolves the exact available Arc Testnet RPC and explorer", () => {
  assert.deepEqual(getArcRpcResource("arc-testnet"), {
    status: "available",
    value: { url: "https://rpc.testnet.arc.io" },
  });
  assert.deepEqual(getArcExplorerResource("arc-testnet"), {
    status: "available",
    value: { baseUrl: "https://testnet.arcscan.app" },
  });
});

test("resolves the exact available Arc Testnet tokens", () => {
  assert.deepEqual(getArcTokenResource("arc-testnet", "USDC"), {
    status: "available",
    value: {
      symbol: "USDC",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
    },
  });
  assert.deepEqual(getArcTokenResource("arc-testnet", "EURC"), {
    status: "available",
    value: {
      symbol: "EURC",
      address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
      decimals: 6,
    },
  });
});

test("keeps Arc Mainnet RPC, explorer, and tokens unavailable", () => {
  assert.deepEqual(getArcRpcResource("arc-mainnet"), {
    status: "unavailable",
    reason: "OFFICIAL_ARC_MAINNET_RPC_UNAVAILABLE",
  });
  assert.deepEqual(getArcExplorerResource("arc-mainnet"), {
    status: "unavailable",
    reason: "OFFICIAL_ARC_MAINNET_EXPLORER_UNAVAILABLE",
  });
  assert.deepEqual(getArcTokenResource("arc-mainnet", "USDC"), {
    status: "unavailable",
    reason: "CIRCLE_ARC_MAINNET_USDC_NOT_YET_CONFIRMED",
  });
  assert.deepEqual(getArcTokenResource("arc-mainnet", "EURC"), {
    status: "unavailable",
    reason: "CIRCLE_ARC_MAINNET_EURC_NOT_YET_CONFIRMED",
  });
});

test("records only authoritative Arc Testnet WizPay deployments", () => {
  assert.deepEqual(getArcWizPayContractResource("arc-testnet", "wizpay"), {
    status: "available",
    value: {
      contract: "WizPay",
      address: "0x87ACE45582f45cC81AC1E627E875AE84cbd75946",
      deploymentSource:
        "packages/contracts/deployments/arc-testnet-wizpay-v2.json",
    },
  });
  assert.deepEqual(
    getArcWizPayContractResource("arc-testnet", "wizpay-swap-executor-v2"),
    {
      status: "available",
      value: {
        contract: "WizPaySwapExecutorV2",
        address: "0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed",
        deploymentSource:
          "packages/contracts/deployments/arc-testnet-wizpay-swap-executor-v2.json",
      },
    },
  );
});

test("keeps every Arc Mainnet WizPay contract unavailable", () => {
  for (const contractKey of ["wizpay", "wizpay-swap-executor-v2"]) {
    assert.deepEqual(getArcWizPayContractResource("arc-mainnet", contractKey), {
      status: "unavailable",
      reason: "WIZPAY_MAINNET_CONTRACT_NOT_DEPLOYED",
    });
  }
});

test("records the exact published Arc Mainnet Uniswap contract mapping", () => {
  const expected = {
    "uniswap-v3": {
      v3CoreFactory: "0xf0db7b58379503491d857db50ac9ece64c653918",
      multicall: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
      quoter: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
      nonfungiblePositionManager: "0x39654a85a4c05127f5fd6ed22caec077a0fb1377",
      tickLens: "0x9eb8600665b55d10c1eb2316ca5127a9ca6e2e76",
      swapRouter02: "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77",
    },
    "uniswap-v4": {
      poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      positionManager: "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b",
      stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
      quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    },
    "universal-router": {
      universalRouter: "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
    },
  };

  for (const [protocol, contracts] of Object.entries(expected)) {
    for (const [contractKey, address] of Object.entries(contracts)) {
      const resource = getArcProtocolContractResource(
        "arc-mainnet",
        protocol,
        contractKey,
      );
      assert.equal(resource.status, "published");
      assert.equal(resource.verification, "onchain-pending");
      assert.equal(resource.executable, false);
      assert.equal(resource.value.address, address);
    }
  }

  assert.deepEqual(
    getArcProtocolContractResource(
      "arc-mainnet",
      "universal-router",
      "universalRouter",
    ).value,
    {
      address: "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
      version: "2.1.1",
      creationBlock: 1_950_059,
    },
  );
});

test("never exposes published or unavailable resources as executable", () => {
  const publishedResource = getArcProtocolContractResource(
    "arc-mainnet",
    "uniswap-v3",
    "swapRouter02",
  );
  assert.throws(
    () => requireAvailableArcResource(publishedResource),
    (error) =>
      error instanceof UnavailableArcResourceError &&
      error.resourceStatus === "published" &&
      error.reason === "PUBLISHED_RESOURCE_ONCHAIN_VERIFICATION_PENDING",
  );
  assert.throws(
    () => requireAvailableArcResource(getArcRpcResource("arc-mainnet")),
    (error) =>
      error instanceof UnavailableArcResourceError &&
      error.resourceStatus === "unavailable" &&
      error.reason === "OFFICIAL_ARC_MAINNET_RPC_UNAVAILABLE",
  );
  assert.deepEqual(
    requireAvailableArcResource(getArcRpcResource("arc-testnet")),
    {
      url: "https://rpc.testnet.arc.io",
    },
  );
});

test("keeps Arc Mainnet USDC/EURC pool and liquidity unverified", () => {
  assert.deepEqual(
    getArcProtocolCapabilityResource(
      "arc-mainnet",
      "uniswap",
      "usdc-eurc-pool",
    ),
    {
      status: "unavailable",
      reason: "UNISWAP_USDC_EURC_POOL_NOT_VERIFIED",
    },
  );
  assert.deepEqual(
    getArcProtocolCapabilityResource(
      "arc-mainnet",
      "uniswap",
      "usdc-eurc-liquidity",
    ),
    {
      status: "unavailable",
      reason: "UNISWAP_USDC_EURC_LIQUIDITY_NOT_VERIFIED",
    },
  );
});

test("does not fall back across Arc networks", () => {
  assert.equal(getArcRpcResource("arc-mainnet").status, "unavailable");
  assert.equal(getArcExplorerResource("arc-mainnet").status, "unavailable");
  assert.equal(
    getArcTokenResource("arc-mainnet", "USDC").status,
    "unavailable",
  );
  assert.equal(
    getArcWizPayContractResource("arc-mainnet", "wizpay").status,
    "unavailable",
  );
  assert.equal(
    getArcProtocolContractResource("arc-testnet", "uniswap-v3", "swapRouter02")
      .status,
    "unavailable",
  );
});

test("strictly rejects unknown and inexact resource keys", () => {
  const calls = [
    () => getArcTokenResource("arc-testnet", ""),
    () => getArcTokenResource("arc-testnet", " "),
    () => getArcTokenResource("arc-testnet", "usdc"),
    () => getArcTokenResource("arc-testnet", "USD"),
    () => getArcWizPayContractResource("arc-testnet", "WizPay"),
    () => getArcProtocolContractResource("arc-mainnet", "uniswap", "quoter"),
    () => getArcProtocolContractResource("arc-mainnet", "UNISWAP-V3", "quoter"),
    () => getArcProtocolContractResource("arc-mainnet", "uniswap-v3", "Quoter"),
    () => getArcProtocolContractResource("arc-mainnet", "uniswap-v3", "quote"),
    () =>
      getArcProtocolCapabilityResource(
        "arc-mainnet",
        "uniswap",
        "usdc-eurc-pool ",
      ),
  ];

  for (const call of calls) assert.throws(call, UnknownArcResourceError);
});

test("requires an explicit exact network for every resource lookup", () => {
  const calls = [
    () => getArcRpcResource(),
    () => getArcExplorerResource(""),
    () => getArcTokenResource(" ", "USDC"),
    () => getArcWizPayContractResource("ARC-MAINNET", "wizpay"),
    () =>
      getArcProtocolContractResource("arc-mainnet ", "uniswap-v3", "quoter"),
  ];

  for (const call of calls) assert.throws(call, UnsupportedArcNetworkError);
});

test("deep-freezes every resource registry and nested value", () => {
  const registries = [
    ARC_RPC_RESOURCES,
    ARC_EXPLORER_RESOURCES,
    ARC_TOKEN_RESOURCES,
    ARC_WIZPAY_CONTRACT_RESOURCES,
    ARC_PROTOCOL_CONTRACT_RESOURCES,
    ARC_PROTOCOL_CAPABILITY_RESOURCES,
  ];

  function assertDeepFrozen(value) {
    if (!value || typeof value !== "object") return;
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertDeepFrozen(child);
  }

  for (const registry of registries) assertDeepFrozen(registry);
});
