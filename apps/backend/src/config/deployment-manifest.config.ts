import { parseArcNetworkKey } from '@wizpay/arc-network';

export const ARC_MAINNET_DEPLOYMENT_MANIFEST = Object.freeze({
  network: 'arc-mainnet' as const,
  classification: 'unavailable' as const,
  path: 'packages/contracts/deployments/arc-mainnet-wizpay-v2.json',
  executable: false,
});

export const ARC_DEPLOYMENT_MANIFESTS = Object.freeze({
  'arc-mainnet': ARC_MAINNET_DEPLOYMENT_MANIFEST,
});

export type ArcDeploymentManifest =
  typeof ARC_DEPLOYMENT_MANIFESTS[keyof typeof ARC_DEPLOYMENT_MANIFESTS];

export function resolveArcDeploymentManifest(
  selector: unknown,
): ArcDeploymentManifest {
  const network = parseArcNetworkKey(selector);
  if (network !== 'arc-mainnet') {
    throw new Error(
      `Unsupported Arc network: ${JSON.stringify(network)}. WizPay backend requires arc-mainnet.`,
    );
  }
  return ARC_DEPLOYMENT_MANIFESTS[network];
}

export function assertDeploymentManifestIsolation(
  network: 'arc-mainnet',
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
