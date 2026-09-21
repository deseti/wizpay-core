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
  getArcCctpResource,
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
  parseArcNetworkKey,
  requireAvailableArcResource,
  ARC_CAPABILITY_DEFINITIONS,
  resolveArcCapabilities,
  parseArcCapabilityName,
  validateArcCapabilityDependencies,
} = require(".");

test("defines Arc Mainnet-only network identity", () => {
  assert.equal(ARC_NETWORK_DEFINITIONS.length, 1);
  assert.deepEqual(ARC_NETWORK_DEFINITIONS[0], {
    key: "arc-mainnet",
    name: "Arc Mainnet",
    chainId: 5_042,
    environment: "mainnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    testnet: false,
  });
});

test("defines all-false Arc Mainnet capability defaults", () => {
  assert.deepEqual(ARC_CAPABILITY_DEFINITIONS["arc-mainnet"], {
    send: false,
    sameTokenPayroll: false,
    invoice: false,
    paymentLink: false,
    liquidity: false,
    bridge: false,
    swap: false,
    crossTokenPayroll: false,
    crossTokenInvoice: false,
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

test("rejects still-forbidden Mainnet capabilities while allowing the verified bridge, swap, and payroll flags", () => {
  assert.throws(
    () =>
      resolveArcCapabilities("arc-mainnet", {
        WIZPAY_ARC_MAINNET_CAPABILITY_LIQUIDITY: "true",
      }),
    (error) => error.code === "CAPABILITY_FORBIDDEN_FOR_NETWORK",
  );
  const bridgeEnabled = resolveArcCapabilities("arc-mainnet", {
    WIZPAY_ARC_MAINNET_CAPABILITY_BRIDGE: "true",
  });
  assert.equal(bridgeEnabled.bridge, true);
  const swapEnabled = resolveArcCapabilities("arc-mainnet", {
    WIZPAY_ARC_MAINNET_CAPABILITY_SWAP: "true",
  });
  assert.equal(swapEnabled.swap, true);
  assert.equal(swapEnabled.sameTokenPayroll, false);
  const payrollEnabled = resolveArcCapabilities("arc-mainnet", {
    WIZPAY_ARC_MAINNET_CAPABILITY_SAME_TOKEN_PAYROLL: "true",
  });
  assert.equal(payrollEnabled.sameTokenPayroll, true);
  const crossEnabled = resolveArcCapabilities("arc-mainnet", {
    WIZPAY_ARC_MAINNET_CAPABILITY_SWAP: "true",
    WIZPAY_ARC_MAINNET_CAPABILITY_CROSS_TOKEN_PAYROLL: "true",
  });
  assert.equal(crossEnabled.swap, true);
  assert.equal(crossEnabled.crossTokenPayroll, true);
  assert.throws(
    () =>
      resolveArcCapabilities("arc-mainnet", {
        WIZPAY_ARC_MAINNET_CAPABILITY_CROSS_TOKEN_PAYROLL: "true",
      }),
    (error) => error.code === "CONTRADICTORY_CAPABILITY_CONFIGURATION",
  );
});

test("validates Mainnet capability dependencies without legacy fallbacks", () => {
  const allFalse = resolveArcCapabilities("arc-mainnet", {});
  assert.equal(
    validateArcCapabilityDependencies(
      { ...allFalse, send: true, invoice: true },
      {
        sendDirect: true,
        payrollDirect: false,
        invoiceCreation: true,
        paymentLinkDirect: false,
        bridge: false,
        swap: false,
        nanoAgentApi: false,
      },
    ),
    true,
  );
});

test("keeps Mainnet cross-token readiness dependent on EURC and swap executor", () => {
  const mainnet = getArcOperationResourceReadiness("arc-mainnet");
  assert.equal(mainnet.sendDirect, true);
  assert.equal(mainnet.payrollDirect, true);
  assert.equal(mainnet.bridgeDirect, true);
  assert.equal(mainnet.swapDirect, true);
  assert.equal(mainnet.crossToken, true);
});

test("exposes official Circle CCTP V2 production resources for Arc Mainnet", () => {
  const messenger = getArcCctpResource("arc-mainnet", "tokenMessengerV2");
  assert.equal(messenger.status, "available");
  assert.equal(
    messenger.value.address,
    "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  );
  assert.equal(messenger.value.domain, 26);
  const transmitter = getArcCctpResource(
    "arc-mainnet",
    "messageTransmitterV2",
  );
  assert.equal(transmitter.status, "available");
  assert.equal(
    transmitter.value.address,
    "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  );
  const iris = getArcCctpResource("arc-mainnet", "irisApi");
  assert.equal(iris.status, "available");
  assert.equal(iris.value.baseUrl, "https://iris-api.circle.com");
  assert.throws(
    () => getArcCctpResource("arc-mainnet", "tokenMessengerV1"),
    UnknownArcResourceError,
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
          nanoAgentApi: true,
        },
      ),
    (error) => error.code === "CAPABILITY_RESOURCE_DEPENDENCY_UNAVAILABLE",
  );
});

test("defines the exact Arc Mainnet identity", () => {
  assert.deepEqual(
    ARC_NETWORK_DEFINITIONS.map(
      ({ key, name, chainId, environment, nativeCurrency, testnet }) => ({
        key,
        name,
        chainId,
        environment,
        nativeCurrency,
        testnet,
      }),
    ),
    [
      {
        key: "arc-mainnet",
        name: "Arc Mainnet",
        chainId: 5_042,
        environment: "mainnet",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        testnet: false,
      },
    ],
  );
});

test("resolves the exact Mainnet key", () => {
  assert.equal(getArcNetworkByKey("arc-mainnet").chainId, 5_042);
  assert.equal(parseArcNetworkKey("arc-mainnet"), "arc-mainnet");
});

test("resolves the exact Mainnet chain ID", () => {
  assert.equal(getArcNetworkByChainId(5_042).key, "arc-mainnet");
});

test("strictly rejects empty, whitespace, unknown, case-modified, and near-match keys", () => {
  for (const value of [
    "",
    "   ",
    "unknown",
    "ARC-MAINNET",
    "arc-Mainnet",
    "arc-mainnet ",
    "arc-main",
    "arc-test",
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
  for (const value of [0, 1, 5_043, 5_042_002, 50_420_020, "5042", undefined, null]) {
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
        { key: "arc-mainnet", chainId: 5_042, environment: "testnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("rejects arc-mainnet with chain ID 5043", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        { key: "arc-mainnet", chainId: 5_043, environment: "mainnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("rejects arbitrary positive chain IDs with correct keys and environments", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        { key: "arc-mainnet", chainId: 8, environment: "mainnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("resolves the exact available Arc Mainnet RPC and explorer", () => {
  assert.deepEqual(getArcRpcResource("arc-mainnet"), {
    status: "available",
    value: { url: "https://rpc.mainnet.arc.io" },
  });
  assert.deepEqual(getArcExplorerResource("arc-mainnet"), {
    status: "available",
    value: { baseUrl: "https://explorer.arc.io" },
  });
});

test("resolves the live Arc Mainnet canonical tokens", () => {
  assert.deepEqual(getArcTokenResource("arc-mainnet", "USDC"), {
    status: "available",
    value: {
      symbol: "USDC",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
      authoritativeSource:
        "https://docs.arc.io/arc/references/contract-addresses",
    },
  });
  assert.deepEqual(getArcTokenResource("arc-mainnet", "EURC"), {
    status: "available",
    value: {
      symbol: "EURC",
      address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
      decimals: 6,
      authoritativeSource:
        "https://docs.arc.io/arc/references/contract-addresses",
    },
  });
});

test("registers confirmed Arc Mainnet Payroll and Swap Executor without repurposing V2", () => {
  assert.deepEqual(getArcWizPayContractResource("arc-mainnet", "wizpay"), {
    status: "available",
    value: {
      contract: "WizPayPayrollMainnet",
      address: "0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34",
      deploymentSource:
        "confirmed Arc Mainnet WizPayPayrollMainnet 0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34",
    },
  });
  assert.deepEqual(
    getArcWizPayContractResource("arc-mainnet", "wizpay-swap-executor-mainnet"),
    {
      status: "available",
      value: {
        contract: "WizPaySwapExecutorMainnet",
        address: "0x7A051F17B237750EF9D4E63fb75381B9F8755774",
        deploymentSource:
          "confirmed Arc Mainnet WizPaySwapExecutorMainnet 0x7A051F17B237750EF9D4E63fb75381B9F8755774",
      },
    },
  );
  assert.deepEqual(
    getArcWizPayContractResource("arc-mainnet", "wizpay-swap-executor-v2"),
    {
      status: "unavailable",
      reason: "WIZPAY_MAINNET_CONTRACT_NOT_DEPLOYED",
    },
  );
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
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
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

test("never exposes published, candidate, verified-non-executable, or unavailable resources as executable", () => {
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
    () =>
      requireAvailableArcResource(
        getArcProtocolCapabilityResource(
          "arc-mainnet",
          "uniswap",
          "usdc-eurc-pool-id",
        ),
      ),
    (error) =>
      error instanceof UnavailableArcResourceError &&
      error.resourceStatus === "candidate" &&
      error.reason === "CANDIDATE_RESOURCE_NOT_VERIFIED",
  );
  assert.deepEqual(
    requireAvailableArcResource(getArcRpcResource("arc-mainnet")),
    { url: "https://rpc.mainnet.arc.io" },
  );
});

test("keeps the generic pool capability and live liquidity unavailable", () => {
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

test("exposes candidate V4 pool identity without enabling execution", () => {
  const readiness = getArcMainnetUniswapV4Readiness();
  assert.equal(readiness.network, "arc-mainnet");
  assert.equal(readiness.chainId, 5_042);
  assert.deepEqual(readiness.pair, ["USDC", "EURC"]);
  assert.deepEqual(readiness.walletControl, ["external-wallet"]);
  assert.equal(readiness.custody, "user-controlled-only");
  assert.equal(readiness.capabilityEnabled, false);
  assert.equal(readiness.executable, false);
  assert.equal(readiness.poolKey.status, "candidate");
  assert.equal(readiness.poolId.status, "candidate");
  assert.equal(readiness.poolKey.executable, false);
  assert.equal(readiness.poolId.executable, false);
  assert.equal(readiness.poolUniqueness.status, "unavailable");
  assert.equal(readiness.liquidity.status, "unavailable");
  assert.equal(readiness.rpcQuorum.status, "unavailable");
  assert.equal(readiness.officialResourceEvidence.status, "verified");
  assert.equal(readiness.officialResourceEvidence.executable, false);
  assert.equal(readiness.executionAuthorization.status, "unavailable");
  assert.deepEqual(readiness.blockers, [
    "UNISWAP_USDC_EURC_POOL_UNIQUENESS_NOT_VERIFIED",
    "UNISWAP_USDC_EURC_LIQUIDITY_NOT_VERIFIED",
    "ARC_MAINNET_RPC_QUORUM_UNAVAILABLE",
    "ARC_MAINNET_UNISWAP_EXECUTION_AUTHORIZATION_UNAVAILABLE",
  ]);
  assert.equal(readiness.tokens.USDC.status, "available");
  assert.equal(readiness.tokens.EURC.status, "available");
  assert.equal(readiness.contracts.universalRouter.status, "published");
  assert.equal(readiness.contracts.permit2.status, "published");
  assert.equal(
    readiness.contracts.universalRouter.value.address,
    "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
  );
  assert.equal(Object.isFrozen(readiness), true);
  assert.equal(Object.isFrozen(readiness.blockers), true);
});

test("resolves only Arc Mainnet without cross-network fallback", () => {
  assert.equal(
    getArcRpcResource("arc-mainnet").value.url,
    "https://rpc.mainnet.arc.io",
  );
  assert.equal(
    getArcExplorerResource("arc-mainnet").value.baseUrl,
    "https://explorer.arc.io",
  );
  assert.equal(
    getArcWizPayContractResource("arc-mainnet", "wizpay").value.contract,
    "WizPayPayrollMainnet",
  );
});

test("strictly rejects unknown and inexact resource keys", () => {
  const calls = [
    () => getArcTokenResource("arc-mainnet", ""),
    () => getArcTokenResource("arc-mainnet", " "),
    () => getArcTokenResource("arc-mainnet", "usdc"),
    () => getArcTokenResource("arc-mainnet", "USD"),
    () => getArcWizPayContractResource("arc-mainnet", "WizPay"),
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
