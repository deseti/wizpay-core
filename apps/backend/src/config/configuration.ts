import {
  loadBackendArcNetworkConfiguration,
  type BackendArcNetworkConfiguration,
} from './arc-network.config';
import {
  resolveArcCapabilities,
  type ArcCapabilities,
} from '@wizpay/arc-network';

export interface FxConfig {
  /** FX routing mode: 'legacy' routes to StableFXAdapter_V2, 'new' routes to Circle StableFX RFQ. */
  routingMode: string;
  /** Settlement poll interval in milliseconds. */
  pollIntervalMs: number;
  /** Maximum number of settlement poll attempts before timeout. */
  pollMaxAttempts: number;
  /** Circle StableFX API base URL. */
  apiBaseUrl: string;
  /** Circle StableFX API key. */
  apiKey: string;
  /** JSON string of supported token pairs (e.g., [{"from":"USDC","to":"EURC"}]). */
  supportedPairs: string;
  /** Production mode flag — when true, enforces fxMode="stablefx" and rejects legacy fallback. */
  useRealStableFx: boolean;
  /** Auto-update-rates toggle — when false, disables the legacy rate update job. */
  autoUpdateRatesEnabled: boolean;
}

export interface ApplicationConfig {
  arcNetwork: BackendArcNetworkConfiguration;
  arcCapabilities: ArcCapabilities;
  fx: FxConfig;
}

export default (): ApplicationConfig => ({
  arcNetwork: loadBackendArcNetworkConfiguration(),
  arcCapabilities: resolveArcCapabilities(
    process.env.WIZPAY_ARC_NETWORK as 'arc-testnet' | 'arc-mainnet',
    process.env,
  ),
  fx: {
    routingMode: process.env.FX_ROUTING_MODE ?? 'new',
    pollIntervalMs: Number.parseInt(
      process.env.FX_POLL_INTERVAL_MS ?? '3000',
      10,
    ),
    pollMaxAttempts: Number.parseInt(
      process.env.FX_POLL_MAX_ATTEMPTS ?? '60',
      10,
    ),
    apiBaseUrl: process.env.STABLEFX_API_BASE_URL ?? '',
    apiKey: process.env.STABLEFX_API_KEY ?? '',
    supportedPairs: process.env.STABLEFX_SUPPORTED_PAIRS ?? '[]',
    useRealStableFx: process.env.NEXT_PUBLIC_USE_REAL_STABLEFX !== 'false',
    autoUpdateRatesEnabled: process.env.AUTO_UPDATE_RATES_ENABLED !== 'false',
  },
});
