export declare const MAINNET_CHAIN_IDS: readonly number[];
export declare const BRIDGE_TESTNETS: readonly never[];
export declare const BRIDGE_TESTNET_BY_CODE: Readonly<Record<string, never>>;

export declare function getBridgeTestnet(code: string): never;

export type BridgeChainCode =
  | "ARC-MAINNET"
  | "ETH-MAINNET"
  | "BASE-MAINNET"
  | "ARB-MAINNET"
  | "OP-MAINNET"
  | "POLYGON-MAINNET"
  | "AVAX-MAINNET";

export type BridgeChain = Readonly<{
  code: BridgeChainCode;
  name: string;
  chainId: number;
  domain: number;
  usdcAddress: `0x${string}`;
  usdcDecimals: 6;
  tokenMessengerV2: `0x${string}`;
  messageTransmitterV2: `0x${string}`;
  explorerBaseUrl: string;
  fastTransferSource: boolean;
}>;

export declare const BRIDGE_CHAINS: readonly BridgeChain[];
export declare const BRIDGE_CHAIN_BY_CODE: Readonly<
  Record<BridgeChainCode, BridgeChain>
>;

export declare const CCTP_PRODUCTION: Readonly<{
  version: "CCTP_V2";
  standardFinalityThreshold: 2000;
  fastFinalityThreshold: 1000;
  maxBurnAmountUnits: string;
  irisApiBaseUrl: "https://iris-api.circle.com";
  authoritativeSources: readonly string[];
}>;

export declare class BridgeRegistryError extends Error {
  readonly name: "BridgeRegistryError";
  readonly code: string;
  constructor(code: string, message: string);
}

export declare function getBridgeChain(code: string): BridgeChain;
export declare function getBridgeTransferMode(
  sourceCode: string,
): "fast" | "standard";
export declare function getBridgeFinalityThreshold(
  sourceCode: string,
): 1000 | 2000;
export declare function listBridgeChains(): readonly BridgeChain[];
export declare function assertBridgeRoute(
  sourceCode: string,
  destinationCode: string,
): Readonly<{ source: BridgeChain; destination: BridgeChain }>;
export declare function assertRegistryMatch(
  code: string,
  candidate: unknown,
): true;
export declare function validateBridgeChainEntry(entry: unknown): true;
export declare function validateBridgeRegistry(entries: unknown[]): true;
