export declare const MAINNET_CHAIN_IDS: readonly number[];
export declare const BRIDGE_TESTNETS: readonly never[];
export declare const BRIDGE_TESTNET_BY_CODE: Readonly<Record<string, never>>;

export declare function getBridgeTestnet(code: string): never;
export declare function assertBridgeRoute(
  sourceCode: string,
  destinationCode: string,
): never;
export declare function assertRegistryMatch(
  code: string,
  candidate: unknown,
): never;
export declare function validateBridgeRegistry(entries: unknown[]): true;
