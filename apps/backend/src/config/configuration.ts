import {
  loadBackendArcNetworkConfiguration,
  type BackendArcNetworkConfiguration,
} from './arc-network.config';
import {
  resolveArcCapabilities,
  type ArcCapabilities,
} from '@wizpay/arc-network';

export interface ApplicationConfig {
  arcNetwork: BackendArcNetworkConfiguration;
  arcCapabilities: ArcCapabilities;
}

export default (): ApplicationConfig => ({
  arcNetwork: loadBackendArcNetworkConfiguration(),
  arcCapabilities: resolveArcCapabilities(
    process.env.WIZPAY_ARC_NETWORK as 'arc-mainnet',
    process.env,
  ),
});
