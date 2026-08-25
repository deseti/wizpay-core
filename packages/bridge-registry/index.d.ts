export type BridgeTestnetCode =
  | "ARC-TESTNET"
  | "ETH-SEPOLIA"
  | "BASE-SEPOLIA"
  | "ARB-SEPOLIA"
  | "OP-SEPOLIA"
  | "MONAD-TESTNET";

export interface BridgeTestnetDefinition {
  readonly code: BridgeTestnetCode;
  readonly name: string;
  readonly chainId: number;
  readonly cctpDomain: number;
  readonly usdcAddress: `0x${string}`;
  readonly mintEvidenceEmitter: `0x${string}`;
  readonly mintEvidenceDecimals: 6 | 18;
  readonly tokenMessengerV2: `0x${string}`;
  readonly messageTransmitterV2: `0x${string}`;
  readonly rpcEnvKey: string;
  readonly browserRpcEnvKey: string;
  readonly defaultRpcUrl: string;
  readonly explorerBaseUrl: string;
  readonly gasCurrency: "USDC" | "ETH" | "MON";
  readonly cctpVersion: 2;
  readonly usdcDecimals: 6;
  readonly standardTransferSource: true;
  readonly fastTransferSource: boolean;
  readonly finalityThreshold: 2000;
  readonly nativeGasRequired: true;
  readonly environment: "testnet";
  readonly source: true;
  readonly destination: true;
  readonly testnet: true;
}

export declare const TOKEN_MESSENGER_V2: `0x${string}`;
export declare const MESSAGE_TRANSMITTER_V2: `0x${string}`;
export declare const CCTP_V2_TESTNET_IRIS_BASE_URL: string;
export declare const MAINNET_CHAIN_IDS: readonly number[];
export declare const BRIDGE_TESTNETS: readonly BridgeTestnetDefinition[];
export declare const BRIDGE_TESTNET_BY_CODE: Readonly<
  Record<BridgeTestnetCode, BridgeTestnetDefinition>
>;

export declare function getBridgeTestnet(code: string): BridgeTestnetDefinition;
export declare function assertBridgeRoute(
  sourceCode: string,
  destinationCode: string,
): {
  source: BridgeTestnetDefinition;
  destination: BridgeTestnetDefinition;
};
export declare function assertRegistryMatch(
  code: string,
  candidate: Partial<BridgeTestnetDefinition>,
): BridgeTestnetDefinition;
export declare function validateBridgeRegistry(entries: unknown[]): true;
