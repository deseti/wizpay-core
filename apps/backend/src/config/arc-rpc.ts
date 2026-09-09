import {
  getArcRpcResource,
  parseArcNetworkKey,
  requireAvailableArcResource,
  type ArcNetworkKey,
} from '@wizpay/arc-network';

type ArcRpcConfiguration = {
  name: string;
  value: string | null | undefined;
};

/**
 * Resolve an exact canonical Arc RPC and reject legacy active overrides.
 */
export function resolveArcRpcUrl(
  selector: unknown,
  configurations: ArcRpcConfiguration[] = [],
): string {
  const networkKey: ArcNetworkKey = parseArcNetworkKey(selector);
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
