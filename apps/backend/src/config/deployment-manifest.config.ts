import { parseArcNetworkKey, type ArcNetworkKey } from '@wizpay/arc-network';

export const ARC_DEPLOYMENT_MANIFESTS = Object.freeze({
  'arc-testnet': Object.freeze({
    network: 'arc-testnet' as const,
    classification: 'authoritative' as const,
    path: 'packages/contracts/deployments/arc-testnet-wizpay-v2.json',
    executable: true,
  }),
  'arc-mainnet': Object.freeze({
    network: 'arc-mainnet' as const,
    classification: 'unavailable' as const,
    path: 'packages/contracts/deployments/arc-mainnet-wizpay-v2.json',
    executable: false,
  }),
});

export function resolveArcDeploymentManifest(selector: unknown) {
  return ARC_DEPLOYMENT_MANIFESTS[parseArcNetworkKey(selector)];
}

export function assertDeploymentManifestIsolation(
  network: ArcNetworkKey,
  environment: Record<string, string | undefined>,
) {
  for (const key of [
    'WIZPAY_DEPLOYMENT_MANIFEST',
    'DEPLOYMENT_MANIFEST',
    'CONTRACT_DEPLOYMENT_MANIFEST',
  ]) {
    if (environment[key] !== undefined) {
      throw new Error(
        `Unscoped deployment manifest configuration ${key} is not accepted.`,
      );
    }
  }
  return resolveArcDeploymentManifest(network);
}
