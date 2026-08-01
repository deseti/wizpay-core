export const ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.io';

type ArcRpcConfiguration = {
  name: string;
  value: string | null | undefined;
};

/**
 * Preserve supported configuration keys while preventing Arc Testnet RPC
 * overrides from selecting any endpoint other than WizPay's required RPC.
 */
export function resolveArcTestnetRpcUrl(
  configurations: ArcRpcConfiguration[],
): string {
  for (const configuration of configurations) {
    const value = configuration.value?.trim();

    if (value && value !== ARC_TESTNET_RPC_URL) {
      throw new Error(
        `${configuration.name} must be exactly ${ARC_TESTNET_RPC_URL}.`,
      );
    }
  }

  return ARC_TESTNET_RPC_URL;
}
