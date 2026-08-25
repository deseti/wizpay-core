import {
  CCTP_V2_TESTNET_IRIS_BASE_URL,
  assertBridgeRoute,
  type BridgeTestnetCode,
} from "@wizpay/bridge-registry";

export const CCTP_FEE_TIMEOUT_MS = 8_000;
export const CCTP_FEE_CACHE_TTL_MS = 60_000;
export const CCTP_FEE_RETRY_COUNT = 1;

export type CctpFeeErrorCode =
  | "ABORTED"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "MALFORMED_RESPONSE"
  | "UNSUPPORTED_ROUTE";

export class CctpFeeError extends Error {
  constructor(
    readonly code: CctpFeeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CctpFeeError";
  }
}

interface FeeEntry {
  finalityThreshold: number;
  minimumFee: number;
}

interface CachedFee {
  minimumFeeBps: string;
  expiresAt: number;
}

const feeCache = new Map<string, CachedFee>();

function routeKey(sourceDomain: number, destinationDomain: number) {
  return `${sourceDomain}:${destinationDomain}`;
}

function parseBasisPoints(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new CctpFeeError(
      "MALFORMED_RESPONSE",
      "Circle returned an invalid Standard Transfer fee.",
    );
  const text = String(value);
  if (!/^\d+(?:\.\d{1,6})?$/.test(text))
    throw new CctpFeeError(
      "MALFORMED_RESPONSE",
      "Circle returned an unsupported fee precision.",
    );
  return text;
}

export function calculateCctpMaxFee(amount: bigint, minimumFeeBps: string) {
  if (amount <= 0n || !/^\d+(?:\.\d{1,6})?$/.test(minimumFeeBps))
    throw new CctpFeeError(
      "MALFORMED_RESPONSE",
      "The CCTP fee calculation inputs are invalid.",
    );
  const [whole, fraction = ""] = minimumFeeBps.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`);
  const denominator = 10_000n * scale;
  const fee = (amount * numerator + denominator - 1n) / denominator;
  if (fee >= amount)
    throw new CctpFeeError(
      "MALFORMED_RESPONSE",
      "The CCTP fee is not valid for this transfer amount.",
    );
  return fee;
}

function parseStandardFee(value: unknown, threshold: number) {
  if (!Array.isArray(value))
    throw new CctpFeeError(
      "MALFORMED_RESPONSE",
      "Circle returned a malformed transfer-fee response.",
    );
  const entries = value.filter(
    (entry): entry is FeeEntry =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as FeeEntry).finalityThreshold === threshold,
  );
  if (entries.length !== 1)
    throw new CctpFeeError(
      "MALFORMED_RESPONSE",
      `Circle did not return exactly one Standard Transfer fee for finality threshold ${threshold}.`,
    );
  return parseBasisPoints(entries[0].minimumFee);
}

function mapHttpError(status: number) {
  if (status === 404)
    return new CctpFeeError(
      "NOT_FOUND",
      "Circle does not publish a fee for this CCTP route.",
    );
  if (status === 429)
    return new CctpFeeError(
      "RATE_LIMITED",
      "Circle fee verification is rate limited. Retry shortly.",
    );
  if (status >= 500)
    return new CctpFeeError(
      "SERVICE_UNAVAILABLE",
      "Circle fee verification is temporarily unavailable. Retry shortly.",
    );
  return new CctpFeeError(
    "MALFORMED_RESPONSE",
    `Circle rejected the fee request (${status}).`,
  );
}

export interface ResolveStandardCctpFeeInput {
  sourceCode: BridgeTestnetCode;
  destinationCode: BridgeTestnetCode;
  amount: bigint;
}

export interface ResolveStandardCctpFeeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  forceRefresh?: boolean;
  now?: () => number;
  fetcher?: typeof fetch;
}

export async function resolveStandardCctpFee(
  input: ResolveStandardCctpFeeInput,
  options: ResolveStandardCctpFeeOptions = {},
) {
  let route;
  try {
    route = assertBridgeRoute(input.sourceCode, input.destinationCode);
  } catch {
    throw new CctpFeeError(
      "UNSUPPORTED_ROUTE",
      "The selected CCTP route is not supported.",
    );
  }
  if (
    !route.source.standardTransferSource ||
    route.source.finalityThreshold !== 2000
  )
    throw new CctpFeeError(
      "UNSUPPORTED_ROUTE",
      "The selected source does not support CCTP Standard Transfer.",
    );

  const now = options.now ?? Date.now;
  const key = routeKey(route.source.cctpDomain, route.destination.cctpDomain);
  const cached = feeCache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > now()) {
    return {
      ...route,
      finalityThreshold: route.source.finalityThreshold,
      minimumFeeBps: cached.minimumFeeBps,
      maxFee: calculateCctpMaxFee(input.amount, cached.minimumFeeBps),
      cached: true,
    };
  }

  const fetcher = options.fetcher ?? fetch;
  const retries = options.retries ?? CCTP_FEE_RETRY_COUNT;
  const url = `${CCTP_V2_TESTNET_IRIS_BASE_URL}/burn/USDC/fees/${route.source.cctpDomain}/${route.destination.cctpDomain}`;
  let lastError: CctpFeeError | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted)
      throw new CctpFeeError("ABORTED", "CCTP fee verification was cancelled.");
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(),
      options.timeoutMs ?? CCTP_FEE_TIMEOUT_MS,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    try {
      const response = await fetcher(url, {
        method: "GET",
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw mapHttpError(response.status);
      const text = await response.text();
      if (text.length > 100_000)
        throw new CctpFeeError(
          "MALFORMED_RESPONSE",
          "Circle fee response exceeded the safe size limit.",
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new CctpFeeError(
          "MALFORMED_RESPONSE",
          "Circle returned malformed fee data.",
        );
      }
      const minimumFeeBps = parseStandardFee(
        parsed,
        route.source.finalityThreshold,
      );
      feeCache.set(key, {
        minimumFeeBps,
        expiresAt: now() + CCTP_FEE_CACHE_TTL_MS,
      });
      return {
        ...route,
        finalityThreshold: route.source.finalityThreshold,
        minimumFeeBps,
        maxFee: calculateCctpMaxFee(input.amount, minimumFeeBps),
        cached: false,
      };
    } catch (cause) {
      if (options.signal?.aborted)
        throw new CctpFeeError(
          "ABORTED",
          "CCTP fee verification was cancelled.",
        );
      const error = timeoutController.signal.aborted
        ? new CctpFeeError(
            "TIMEOUT",
            "Circle fee verification timed out. Retry the route check.",
          )
        : cause instanceof CctpFeeError
          ? cause
          : new CctpFeeError(
              "SERVICE_UNAVAILABLE",
              "Circle fee verification could not be reached. Retry shortly.",
            );
      lastError = error;
      if (
        attempt >= retries ||
        !["TIMEOUT", "RATE_LIMITED", "SERVICE_UNAVAILABLE"].includes(
          error.code,
        )
      )
        throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

export function clearCctpFeeCache() {
  feeCache.clear();
}

export function createCctpFeeRequestCoordinator(
  resolver: typeof resolveStandardCctpFee = resolveStandardCctpFee,
) {
  let sequence = 0;
  let controller: AbortController | null = null;
  return {
    async run(input: ResolveStandardCctpFeeInput) {
      controller?.abort();
      controller = new AbortController();
      const current = ++sequence;
      try {
        const result = await resolver(input, { signal: controller.signal });
        return current === sequence
          ? ({ state: "current", result } as const)
          : ({ state: "stale" } as const);
      } catch (error) {
        if (current !== sequence)
          return { state: "stale" } as const;
        throw error;
      }
    },
    cancel() {
      sequence += 1;
      controller?.abort();
      controller = null;
    },
  };
}
