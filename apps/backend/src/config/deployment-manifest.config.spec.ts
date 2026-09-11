import {
  assertDeploymentManifestIsolation,
  resolveArcDeploymentManifest,
} from './deployment-manifest.config';

describe('Arc deployment manifest isolation', () => {
  it('selects only the exact network manifest path', () => {
    expect(resolveArcDeploymentManifest('arc-testnet')).toEqual(
      expect.objectContaining({
        path: 'packages/contracts/deployments/arc-testnet-wizpay-v2.json',
        classification: 'authoritative',
        executable: true,
      }),
    );
    expect(resolveArcDeploymentManifest('arc-mainnet')).toEqual(
      expect.objectContaining({
        path: 'packages/contracts/deployments/arc-mainnet-wizpay-v2.json',
        classification: 'unavailable',
        executable: false,
      }),
    );
  });

  it('does not allow Mainnet to select a Testnet manifest override', () => {
    expect(() =>
      assertDeploymentManifestIsolation('arc-mainnet', {
        WIZPAY_DEPLOYMENT_MANIFEST:
          'packages/contracts/deployments/arc-testnet-wizpay-v2.json',
      }),
    ).toThrow('Unscoped deployment manifest configuration');
  });
});
