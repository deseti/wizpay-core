import {
  assertDeploymentManifestIsolation,
  resolveArcDeploymentManifest,
} from './deployment-manifest.config';

describe('Arc deployment manifest isolation', () => {
  it('selects only the exact Arc Mainnet manifest path', () => {
    expect(resolveArcDeploymentManifest('arc-mainnet')).toEqual(
      expect.objectContaining({
        network: 'arc-mainnet',
        path: 'packages/contracts/deployments/arc-mainnet-wizpay-v2.json',
        classification: 'unavailable',
        executable: false,
      }),
    );
  });

  it.each([undefined, '', ' arc-mainnet ', 'ARC-MAINNET', 'unknown'])(
    'rejects a missing or inexact manifest selector: %p',
    (selector) => {
      expect(() => resolveArcDeploymentManifest(selector)).toThrow();
    },
  );

  it('does not allow a Mainnet manifest override through unscoped variables', () => {
    for (const key of [
      'WIZPAY_DEPLOYMENT_MANIFEST',
      'DEPLOYMENT_MANIFEST',
      'CONTRACT_DEPLOYMENT_MANIFEST',
    ]) {
      expect(() =>
        assertDeploymentManifestIsolation('arc-mainnet', {
          [key]: 'packages/contracts/deployments/arc-mainnet-wizpay-v2.json',
        }),
      ).toThrow('Unscoped deployment manifest configuration');
    }
  });
});
