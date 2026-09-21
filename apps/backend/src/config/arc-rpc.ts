import {
  getArcRpcResource,
  parseArcNetworkKey,
  requireAvailableArcResource,
  type ArcNetworkKey,
} from '@wizpay/arc-network';

export const ARC_MAINNET_KEY = 'arc-mainnet' as const;

type ArcRpcConfiguration = {
  name: string;
  value: string | null | undefined;
};

/**
 * Resolve the exact canonical Arc Mainnet RPC and reject overrides.
 * WizPay backend execution is strict Mainnet-only: any selector other
 * than arc-mainnet is rejected instead of resolved to another network.
 */
export function resolveArcRpcUrl(
  selector: unknown,
  configurations: ArcRpcConfiguration[] = [],
): string {
  const networkKey: ArcNetworkKey = parseArcNetworkKey(selector);
  if (networkKey !== ARC_MAINNET_KEY) {
    throw new Error(
      `Unsupported Arc network: ${JSON.stringify(networkKey)}. WizPay backend requires ${ARC_MAINNET_KEY}.`,
    );
  }
  const rpcUrl = requireAvailableArcResource(getArcRpcResource(networkKey)).url;

  for (const configuration of configurations) {
    const value = configuration.value;

    if (
      value !== undefined &&
      value !== null &&
      value !== '' &&
      value !== rpcUrl
    ) {
      throw new Error(
        `${configuration.name} conflicts with WIZPAY_ARC_NETWORK.`,
      );
    }
  }

  return rpcUrl;
}
