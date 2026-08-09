"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type Address, type Hex, isAddress } from "viem";
import {
  ArrowRightLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import { usePublicClient, useReadContract, useWalletClient } from "wagmi";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PERMIT2_ADDRESS } from "@/constants/addresses";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ERC20_ABI } from "@/constants/erc20";
import { useActionGuard } from "@/hooks/useActionGuard";
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { useDialogState } from "@/hooks/useDialogState";
import { useToast } from "@/hooks/use-toast";
import { useTransactionExecutor } from "@/hooks/useTransactionExecutor";
import { BackendApiError } from "@/lib/backend-api";
import { buildXShareUrl } from "@/lib/social";
import {
  createArcSwapAdapter,
  executePreparedArcUserSwap,
} from "@/lib/circle-swap-kit";
import {
  APP_WALLET_SWAP_CHAIN,
  quoteAppWalletSwap,
  type AppWalletSwapProvider,
  type AppWalletSwapQuoteResponse,
} from "@/lib/app-wallet-swap-service";
import {
  USER_SWAP_CHAIN,
  createStablefxFundingPresign,
  createStablefxTradableQuote,
  createStablefxTrade,
  fundStablefxTrade,
  getStablefxTrade,
  prepareUserSwap,
  quoteUserSwap,
  type StablefxTradeResponse,
  type UserSwapProvider,
  type UserSwapPrepareResponse,
  type UserSwapQuoteResponse,
} from "@/lib/user-swap-service";
import {
  findFirstString,
  formatUserSwapQuoteAmount,
  getUserSwapExpectedOutputDisplay,
  getUserSwapExpectedOutputValue,
  getUserSwapMinimumOutputDisplay,
  getUserSwapMinimumOutputValue,
  parseUserSwapQuoteAmount,
} from "@/lib/user-swap-quote-parser";
import {
  EXPLORER_BASE_URL,
  PREVIEW_SLIPPAGE_BPS,
  SUPPORTED_TOKENS,
  formatTokenAmount,
  getFriendlyErrorMessage,
  isTransactionHash,
  parseAmountToUnits,
  type TokenSymbol,
} from "@/lib/wizpay";
import { arcTestnet } from "@/lib/wagmi";
import { AppWalletSwapProgress } from "./swap/AppWalletSwapProgress";
import {
  getAppWalletQuoteErrorMessage,
  getAppWalletQuoteProvider,
} from "./swap/app-wallet-swap-view-model";
import {
  useAppWalletSwapOperation,
  type SwapRequestStatus,
} from "./swap/use-app-wallet-swap-operation";

type SwapQuoteState = UserSwapQuoteResponse | AppWalletSwapQuoteResponse;
type ExternalWalletSwapProvider = Extract<
  UserSwapProvider,
  "stablefx" | "xylonet"
>;

const EXTERNAL_WALLET_SWAP_PROVIDER_LABELS: Record<
  ExternalWalletSwapProvider,
  string
> = {
  stablefx: "StableFX Official",
  xylonet: "XyloNet",
};
const APP_WALLET_SWAP_PROVIDER_LABELS: Record<AppWalletSwapProvider, string> = {
  stablefx: "StableFX",
  swapkit: "SwapKit",
};
const XYLONET_EXECUTION_DEADLINE_SECONDS = 20 * 60;
const WIZPAY_SWAP_EXECUTOR_ABI = [
  {
    inputs: [
      { name: "router", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    name: "executeSwap",
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

interface SwapSuccessState {
  amountIn: string;
  amountOut: string | null;
  explorerUrl: string | null;
  instructionCount: number;
  referenceId: string;
  status: "pending" | "success";
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  transactionId: string | null;
  transactionStatus: string | null;
  txHash: Hex | null;
  walletMode: "circle" | "external";
}

function shortenHash(hash: string | undefined) {
  if (!hash) {
    return "Pending";
  }

  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

function getPreparedAmountOut(
  prepared: UserSwapPrepareResponse,
  tokenOut: TokenSymbol,
) {
  return formatUserSwapQuoteAmount(
    getUserSwapExpectedOutputValue(prepared),
    tokenOut,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireTypedData(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.message)) {
    throw new Error(`${label} did not include signable typed data.`);
  }

  return value;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing from the StableFX response.`);
  }

  return value.trim();
}

function normalizeStablefxAddress(value: string, label: string): Address {
  const trimmed = value.trim();

  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error(`${label} must be a valid EVM address.`);
  }

  return trimmed as Address;
}

function addressesMatch(first: string | undefined, second: string | undefined) {
  return Boolean(
    first && second && first.toLowerCase() === second.toLowerCase(),
  );
}

const APP_WALLET_QUOTE_DEBOUNCE_MS = 500;
const APP_WALLET_ROUTING_THRESHOLD_BASE_UNITS = 10_000_000n;

function resolveAutomaticAppWalletProvider(
  amountInBaseUnits: string,
): AppWalletSwapProvider | undefined {
  if (!/^\d+$/.test(amountInBaseUnits) || BigInt(amountInBaseUnits) <= 0n) {
    return undefined;
  }

  return BigInt(amountInBaseUnits) < APP_WALLET_ROUTING_THRESHOLD_BASE_UNITS
    ? "swapkit"
    : "stablefx";
}

function buildAppWalletQuoteRequestKey(input: {
  amountIn: string;
  fromAddress: string;
  provider: AppWalletSwapProvider | undefined;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
}) {
  return [
    input.fromAddress.toLowerCase(),
    input.tokenIn,
    input.tokenOut,
    input.amountIn,
    input.provider ?? "backend-default",
    APP_WALLET_SWAP_CHAIN,
  ].join("|");
}

function isQuoteExpired(expiresAt: string | undefined) {
  if (!expiresAt?.trim()) {
    return false;
  }

  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

function hasPositiveQuoteAmount(value: unknown, token: TokenSymbol) {
  const parsed = parseUserSwapQuoteAmount(value, token);
  return parsed !== null && parsed.units > 0n;
}

function logAppWalletQuoteEvent(
  event: string,
  details: Record<string, string | number>,
) {
  console.info(`[app-wallet-quote] ${event}`, details);
}

function looksLikeAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function isSignerAddressField(path: string) {
  const finalKey = path.split(".").at(-1)?.toLowerCase() ?? "";
  const signerKeys = new Set([
    "account",
    "address",
    "from",
    "owner",
    "recipient",
    "recipientaddress",
    "signer",
    "taker",
    "trader",
    "user",
    "wallet",
  ]);
  const nonSignerKeys = new Set([
    "contract",
    "destination",
    "maker",
    "spender",
    "token",
    "to",
    "verifyingcontract",
  ]);

  if (nonSignerKeys.has(finalKey)) {
    return false;
  }

  return signerKeys.has(finalKey);
}

function collectStablefxMessageAddressFields(
  value: unknown,
  path = "message",
): Array<{ address: string; path: string; signerField: boolean }> {
  if (looksLikeAddress(value)) {
    return [
      {
        address: value,
        path,
        signerField: isSignerAddressField(path),
      },
    ];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectStablefxMessageAddressFields(item, `${path}.${index}`),
    );
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) =>
    collectStablefxMessageAddressFields(nested, `${path}.${key}`),
  );
}

function assertStablefxMessageAddressFields(
  message: Record<string, unknown>,
  expectedAddress: string,
) {
  const conflicts = collectStablefxMessageAddressFields(message).filter(
    (field) =>
      field.signerField && !addressesMatch(field.address, expectedAddress),
  );

  if (conflicts.length > 0) {
    throw new Error(
      `StableFX typed-data ${conflicts[0].path} does not match the selected wallet address.`,
    );
  }
}

function getQuoteProvider(quote: SwapQuoteState | null) {
  if (isRecord(quote) && quote.provider === "stablefx") {
    return "stablefx";
  }

  if (isRecord(quote) && quote.provider === "swapkit") {
    return "swapkit";
  }

  if (isRecord(quote) && quote.provider === "xylonet") {
    return "xylonet";
  }

  return undefined;
}

type StablefxExecutionCapability = {
  enabled: boolean;
  label: string;
  message: string | null;
};

function getStablefxExecutionCapability({
  tokenIn,
  tokenOut,
  walletMode,
}: {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  walletMode: "circle" | "external" | null;
}): StablefxExecutionCapability {
  if (walletMode === "external") {
    return {
      enabled: true,
      label: `External ${tokenIn} -> ${tokenOut}: enabled`,
      message: null,
    };
  }

  if (walletMode === "circle") {
    return {
      enabled: true,
      label: `App Wallet ${tokenIn} -> ${tokenOut}: enabled`,
      message: null,
    };
  }

  return {
    enabled: false,
    label: "StableFX execution: wallet required",
    message: "Connect an App Wallet or external wallet to execute StableFX.",
  };
}

function isStablefxSuccessStatus(status: string | undefined) {
  return ["taker_funded", "complete", "completed", "settled"].includes(
    status?.toLowerCase() ?? "",
  );
}

function isStablefxFinalStatus(status: string | undefined) {
  return ["complete", "completed", "settled"].includes(
    status?.toLowerCase() ?? "",
  );
}

function isStablefxFailureStatus(status: string | undefined) {
  return ["failed", "rejected", "expired", "breached", "refunded"].includes(
    status?.toLowerCase() ?? "",
  );
}

function logStablefxStep(
  step:
    | "tradable_quote"
    | "allowance_check"
    | "approve"
    | "sign_quote"
    | "create_trade"
    | "get_trade"
    | "funding_presign"
    | "fund",
  details: Record<string, unknown> = {},
) {
  console.info("[stablefx-swap]", {
    provider: "stablefx",
    step,
    ...details,
  });
}

function isStablefxQuoteExpiredError(error: unknown) {
  if (
    error instanceof BackendApiError &&
    error.code === "USER_SWAP_STABLEFX_QUOTE_EXPIRED"
  ) {
    return true;
  }

  if (error instanceof Error) {
    return error.message.toLowerCase().includes("quote expired");
  }

  return false;
}

function resolveStablefxContractTradeId(trade: StablefxTradeResponse) {
  const candidates = [
    trade.contractTradeId,
    isRecord(trade.data) ? trade.data.contractTradeId : undefined,
    isRecord(trade.trade) ? trade.trade.contractTradeId : undefined,
    isRecord(trade.data) && isRecord(trade.data.trade)
      ? trade.data.trade.contractTradeId
      : undefined,
  ];

  for (const candidate of candidates) {
    if (
      (typeof candidate === "string" || typeof candidate === "number") &&
      /^\d+$/.test(String(candidate).trim())
    ) {
      return String(candidate).trim();
    }
  }

  return null;
}

function getNestedStringValue(value: unknown, path: string[]) {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }

    current = current[key];
  }

  return typeof current === "string" || typeof current === "number"
    ? String(current)
    : null;
}

function getStablefxExplorerTxHash(
  trade: StablefxTradeResponse,
  options: { includeRecordTrade?: boolean } = {},
): Hex | null {
  const deliveryPaths = [
    ["settlementTransactionHash"],
    ["data", "settlementTransactionHash"],
    ["contractTransactions", "makerDeliver", "txHash"],
    ["data", "contractTransactions", "makerDeliver", "txHash"],
    ["contractTransactions", "makerDeliver", "transactionHash"],
    ["data", "contractTransactions", "makerDeliver", "transactionHash"],
    ["contractTransactions", "takerDeliver", "txHash"],
    ["data", "contractTransactions", "takerDeliver", "txHash"],
    ["contractTransactions", "takerDeliver", "transactionHash"],
    ["data", "contractTransactions", "takerDeliver", "transactionHash"],
  ];
  const recordPaths = [
    ["contractTransactions", "recordTrade", "txHash"],
    ["data", "contractTransactions", "recordTrade", "txHash"],
    ["contractTransactions", "recordTrade", "transactionHash"],
    ["data", "contractTransactions", "recordTrade", "transactionHash"],
  ];
  const paths = options.includeRecordTrade
    ? [...deliveryPaths, ...recordPaths]
    : deliveryPaths;

  for (const path of paths) {
    const candidate = getNestedStringValue(trade, path);

    if (candidate && isTransactionHash(candidate)) {
      return candidate as Hex;
    }
  }

  return null;
}

function getStablefxRecordTradeStatus(trade: StablefxTradeResponse) {
  return getNestedStringValue(trade, [
    "contractTransactions",
    "recordTrade",
    "status",
  ]);
}

function getStablefxRecordTradeFailureDetail(trade: StablefxTradeResponse) {
  return (
    getNestedStringValue(trade, [
      "contractTransactions",
      "recordTrade",
      "errorDetails",
    ]) ??
    getNestedStringValue(trade, [
      "data",
      "contractTransactions",
      "recordTrade",
      "errorDetails",
    ]) ??
    getNestedStringValue(trade, [
      "contractTransactions",
      "recordTrade",
      "revertReason",
    ]) ??
    getNestedStringValue(trade, [
      "data",
      "contractTransactions",
      "recordTrade",
      "revertReason",
    ]) ??
    getNestedStringValue(trade, [
      "contractTransactions",
      "recordTrade",
      "failureReason",
    ]) ??
    getNestedStringValue(trade, [
      "data",
      "contractTransactions",
      "recordTrade",
      "failureReason",
    ]) ??
    getNestedStringValue(trade, [
      "contractTransactions",
      "recordTrade",
      "errorMessage",
    ]) ??
    getNestedStringValue(trade, [
      "data",
      "contractTransactions",
      "recordTrade",
      "errorMessage",
    ]) ??
    getNestedStringValue(trade, [
      "contractTransactions",
      "recordTrade",
      "error",
    ]) ??
    getNestedStringValue(trade, [
      "data",
      "contractTransactions",
      "recordTrade",
      "error",
    ])
  );
}

function getStablefxRecordTradeTxHash(trade: StablefxTradeResponse) {
  return (
    getNestedStringValue(trade, [
      "contractTransactions",
      "recordTrade",
      "txHash",
    ]) ??
    getNestedStringValue(trade, [
      "data",
      "contractTransactions",
      "recordTrade",
      "txHash",
    ]) ??
    getNestedStringValue(trade, [
      "contractTransactions",
      "recordTrade",
      "transactionHash",
    ]) ??
    getNestedStringValue(trade, [
      "data",
      "contractTransactions",
      "recordTrade",
      "transactionHash",
    ])
  );
}

function getQuoteStringValue(
  quote: SwapQuoteState,
  topLevelKeys: string[],
  rawPaths: string[],
) {
  for (const key of topLevelKeys) {
    if (isRecord(quote)) {
      const value = quote[key];

      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }

      if (typeof value === "number" || typeof value === "bigint") {
        return value.toString();
      }
    }
  }

  return findFirstString("raw" in quote ? quote.raw : quote.rawQuote, rawPaths);
}

function getQuoteAddressValue(
  quote: SwapQuoteState,
  topLevelKeys: string[],
  rawPaths: string[],
  label: string,
): Address {
  const value = getQuoteStringValue(quote, topLevelKeys, rawPaths);

  if (!value || !isAddress(value)) {
    throw new Error(`XyloNet quote did not include a valid ${label}.`);
  }

  return value as Address;
}

function getQuoteBaseUnitValue(
  quote: SwapQuoteState,
  topLevelKeys: string[],
  rawPaths: string[],
  label: string,
): bigint {
  const value = getQuoteStringValue(quote, topLevelKeys, rawPaths);

  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`XyloNet quote did not include a valid ${label}.`);
  }

  const amount = BigInt(value);
  if (amount <= 0n) {
    throw new Error(`XyloNet quote ${label} must be greater than zero.`);
  }

  return amount;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function SwapScreen() {
  const { walletAddress, walletMode } = useActiveWalletAddress();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { signTypedData, signTypedDataWithMetadata } = useTransactionExecutor();
  const { toast } = useToast();
  const { isProcessing: isGuarded, guard } = useActionGuard();
  const { isOpen: isSuccessDialogOpen, setIsOpen: setIsSuccessDialogOpen } =
    useDialogState();

  const [tokenIn, setTokenIn] = useState<TokenSymbol>("USDC");
  const [tokenOut, setTokenOut] = useState<TokenSymbol>("EURC");
  const [amountIn, setAmountIn] = useState("");
  const [externalSwapProvider, setExternalSwapProvider] =
    useState<ExternalWalletSwapProvider>("stablefx");
  const [appWalletSwapProvider, setAppWalletSwapProvider] = useState<
    AppWalletSwapProvider | undefined
  >(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [requestStatus, setRequestStatus] = useState<SwapRequestStatus>("idle");
  const [quote, setQuote] = useState<SwapQuoteState | null>(null);
  const [quoteWalletMode, setQuoteWalletMode] = useState<
    "circle" | "external" | null
  >(null);
  const [successState, setSuccessState] = useState<SwapSuccessState | null>(
    null,
  );
  const [quoteRetryNonce, setQuoteRetryNonce] = useState(0);
  const quoteRequestKeyRef = useRef<string | null>(null);
  const quoteSuccessfulKeyRef = useRef<string | null>(null);
  const quoteInFlightKeyRef = useRef<string | null>(null);
  const quoteSequenceRef = useRef(0);
  const quoteAbortControllerRef = useRef<AbortController | null>(null);
  const quoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tokenInConfig = SUPPORTED_TOKENS[tokenIn];
  const amountInUnits = useMemo(
    () => parseAmountToUnits(amountIn, tokenInConfig.decimals),
    [amountIn, tokenInConfig.decimals],
  );
  const amountInBaseUnits = amountInUnits.toString();
  const { data: currentBalanceData } = useReadContract({
    address: tokenInConfig.address,
    abi: ERC20_ABI,
    chainId: arcTestnet.id,
    functionName: "balanceOf",
    args: walletAddress ? [walletAddress] : undefined,
    query: { enabled: Boolean(walletAddress && walletMode === "external") },
  });
  const currentBalance = currentBalanceData ?? 0n;
  const insufficientBalance = amountInUnits > currentBalance;
  const isExternalWalletMode = walletMode === "external";
  const isCircleWalletMode = walletMode === "circle";
  const isExternalWalletOnArc = walletClient?.chain?.id === arcTestnet.id;
  const swapAdapter = useMemo(
    () =>
      isExternalWalletMode
        ? createArcSwapAdapter(publicClient, walletClient)
        : null,
    [isExternalWalletMode, publicClient, walletClient],
  );
  const modeBlockMessage = isCircleWalletMode
    ? null
    : !isExternalWalletMode
      ? "Select an external wallet or Circle App Wallet before starting an Arc Testnet swap."
      : !walletClient
        ? "Connect an external EVM wallet before starting an Arc Testnet swap."
        : !isExternalWalletOnArc
          ? "Switch your external wallet to Arc Testnet before quoting or swapping."
          : !publicClient
            ? "Arc Testnet public client is not ready yet."
            : null;
  const formInvalid =
    !walletAddress || tokenIn === tokenOut || amountInUnits <= 0n;
  const automaticAppWalletProvider =
    isCircleWalletMode && !formInvalid
      ? resolveAutomaticAppWalletProvider(amountInBaseUnits)
      : undefined;
  const resolvedAppWalletProvider = isCircleWalletMode
    ? automaticAppWalletProvider
    : appWalletSwapProvider;
  const appWalletQuoteRequestKey =
    isCircleWalletMode && walletAddress && !formInvalid
      ? buildAppWalletQuoteRequestKey({
          amountIn: amountInBaseUnits,
          fromAddress: walletAddress,
          provider: automaticAppWalletProvider,
          tokenIn,
          tokenOut,
        })
      : null;
  const rawQuoteProvider = getQuoteProvider(quote);
  const quoteMatchesForm =
    quote !== null &&
    quoteWalletMode === walletMode &&
    quote.tokenIn === tokenIn &&
    quote.tokenOut === tokenOut &&
    quote.amountIn === amountInBaseUnits &&
    (!isExternalWalletMode || rawQuoteProvider === externalSwapProvider) &&
    (!isCircleWalletMode ||
      !automaticAppWalletProvider ||
      rawQuoteProvider === automaticAppWalletProvider) &&
    (!("fromAddress" in quote) ||
      quote.fromAddress.toLowerCase() === walletAddress?.toLowerCase());
  const appWalletQuoteIsValid =
    isCircleWalletMode &&
    quoteMatchesForm &&
    appWalletQuoteRequestKey !== null &&
    quoteRequestKeyRef.current === appWalletQuoteRequestKey &&
    quote?.sourceChain === APP_WALLET_SWAP_CHAIN &&
    !isQuoteExpired(quote.expiresAt) &&
    hasPositiveQuoteAmount(getUserSwapExpectedOutputValue(quote), tokenOut) &&
    (rawQuoteProvider !== "swapkit" ||
      hasPositiveQuoteAmount(getUserSwapMinimumOutputValue(quote), tokenOut));
  const appWalletLifecycle = useAppWalletSwapOperation({
    appWalletSwapProvider: resolvedAppWalletProvider,
    formInvalid,
    getRequestBase,
    isCircleWalletMode,
    modeBlockMessage,
    quote:
      quoteWalletMode === "circle" && quote && "operationMode" in quote
        ? quote
        : null,
    quoteIsValid: appWalletQuoteIsValid,
    quoteMatchesForm,
    setAppWalletSwapProvider,
    setErrorMessage,
    setQuote: (nextQuote) => setQuote(nextQuote),
    setQuoteWalletMode,
    setRequestStatus,
    toast,
  });
  const appWalletOperation = appWalletLifecycle.operation;
  const quoteProvider = quoteMatchesForm ? rawQuoteProvider : undefined;
  const displayedAppWalletProvider = appWalletOperation
    ? appWalletOperation.provider
    : (resolvedAppWalletProvider ??
      (quoteMatchesForm ? getAppWalletQuoteProvider(quote) : undefined));
  const isStablefxQuote = quoteProvider === "stablefx";
  const isXylonetSelected =
    isExternalWalletMode && externalSwapProvider === "xylonet";
  const activeProviderLabel = isCircleWalletMode
    ? displayedAppWalletProvider
      ? APP_WALLET_SWAP_PROVIDER_LABELS[displayedAppWalletProvider]
      : undefined
    : quoteProvider === "stablefx" || quoteProvider === "xylonet"
      ? EXTERNAL_WALLET_SWAP_PROVIDER_LABELS[quoteProvider]
      : isExternalWalletMode
        ? EXTERNAL_WALLET_SWAP_PROVIDER_LABELS[externalSwapProvider]
        : quoteProvider;
  const stablefxCapability = getStablefxExecutionCapability({
    tokenIn,
    tokenOut,
    walletMode,
  });
  const quoteIsDisplayable = isCircleWalletMode
    ? appWalletQuoteIsValid
    : quoteMatchesForm;
  const expectedOutput = quoteIsDisplayable
    ? getUserSwapExpectedOutputDisplay(quote, tokenOut)
    : null;
  const minimumOutput = quoteIsDisplayable
    ? getUserSwapMinimumOutputDisplay(quote, tokenOut)
    : null;
  const quoteExpiry =
    quoteIsDisplayable && quote?.expiresAt
      ? new Date(quote.expiresAt).toLocaleTimeString()
      : null;
  const busy = requestStatus !== "idle" || isGuarded;
  const quoteDisabled =
    busy ||
    formInvalid ||
    (isExternalWalletMode && insufficientBalance) ||
    Boolean(modeBlockMessage);
  const swapDisabled =
    quoteDisabled ||
    (isCircleWalletMode && !appWalletQuoteIsValid) ||
    (isStablefxQuote && !stablefxCapability.enabled);

  useEffect(() => {
    if (!isCircleWalletMode || !appWalletQuoteRequestKey) return;

    if (
      quote &&
      (quoteRequestKeyRef.current !== appWalletQuoteRequestKey ||
        !quoteMatchesForm)
    ) {
      quoteRequestKeyRef.current = null;
      quoteSuccessfulKeyRef.current = null;
      setQuote(null);
      setQuoteWalletMode(null);
      logAppWalletQuoteEvent("invalidated", {
        amountIn: amountInBaseUnits,
        provider: automaticAppWalletProvider ?? "none",
        reason: "form_changed",
        sequence: quoteSequenceRef.current,
        tokenPair: `${tokenIn}->${tokenOut}`,
      });
    }
  }, [
    amountInBaseUnits,
    appWalletQuoteRequestKey,
    automaticAppWalletProvider,
    isCircleWalletMode,
    quote,
    quoteMatchesForm,
    setQuote,
    setQuoteWalletMode,
    tokenIn,
    tokenOut,
  ]);

  useEffect(() => {
    if (!isCircleWalletMode || !appWalletQuoteRequestKey || modeBlockMessage) {
      return;
    }

    if (
      quoteSuccessfulKeyRef.current === appWalletQuoteRequestKey ||
      quoteInFlightKeyRef.current === appWalletQuoteRequestKey
    ) {
      return;
    }

    if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current);

    logAppWalletQuoteEvent("scheduled", {
      amountIn: amountInBaseUnits,
      debounceMs: APP_WALLET_QUOTE_DEBOUNCE_MS,
      provider: automaticAppWalletProvider ?? "none",
      sequence: quoteSequenceRef.current + 1,
      tokenPair: `${tokenIn}->${tokenOut}`,
    });

    let cancelled = false;
    quoteTimerRef.current = setTimeout(async () => {
      if (cancelled) return;

      quoteAbortControllerRef.current?.abort();
      const controller = new AbortController();
      quoteAbortControllerRef.current = controller;
      const sequence = ++quoteSequenceRef.current;
      quoteInFlightKeyRef.current = appWalletQuoteRequestKey;
      setRequestStatus("quoting");
      setErrorMessage(null);
      logAppWalletQuoteEvent("request_started", {
        amountIn: amountInBaseUnits,
        provider: automaticAppWalletProvider ?? "none",
        sequence,
        tokenPair: `${tokenIn}->${tokenOut}`,
      });

      try {
        const nextQuote = await quoteAppWalletSwap(
          {
            amountIn: amountInBaseUnits,
            chain: APP_WALLET_SWAP_CHAIN,
            fromAddress: walletAddress!,
            tokenIn,
            tokenOut,
            ...(automaticAppWalletProvider
              ? { provider: automaticAppWalletProvider }
              : {}),
          },
          { signal: controller.signal },
        );

        if (
          cancelled ||
          controller.signal.aborted ||
          sequence !== quoteSequenceRef.current
        ) {
          logAppWalletQuoteEvent("stale_response_ignored", {
            amountIn: amountInBaseUnits,
            sequence,
            tokenPair: `${tokenIn}->${tokenOut}`,
          });
          return;
        }

        setQuote(nextQuote);
        setQuoteWalletMode("circle");
        quoteRequestKeyRef.current = appWalletQuoteRequestKey;
        quoteSuccessfulKeyRef.current = appWalletQuoteRequestKey;
        const resolvedProvider = getAppWalletQuoteProvider(nextQuote);
        if (resolvedProvider) {
          const resolvedRequestKey = buildAppWalletQuoteRequestKey({
            amountIn: amountInBaseUnits,
            fromAddress: walletAddress!,
            provider: resolvedProvider,
            tokenIn,
            tokenOut,
          });
          quoteRequestKeyRef.current = resolvedRequestKey;
          quoteSuccessfulKeyRef.current = resolvedRequestKey;
          if (resolvedProvider !== automaticAppWalletProvider) {
            setQuote(null);
            setQuoteWalletMode(null);
            setErrorMessage(
              "The backend returned a provider that does not match automatic App Wallet routing.",
            );
            return;
          }
          setAppWalletSwapProvider(resolvedProvider);
        }
        logAppWalletQuoteEvent("request_succeeded", {
          amountIn: amountInBaseUnits,
          expiresAt: nextQuote.expiresAt,
          provider: resolvedProvider ?? "unknown",
          sequence,
          tokenPair: `${tokenIn}->${tokenOut}`,
        });
      } catch (error) {
        if (
          cancelled ||
          controller.signal.aborted ||
          sequence !== quoteSequenceRef.current
        ) {
          logAppWalletQuoteEvent("request_cancelled", {
            amountIn: amountInBaseUnits,
            sequence,
            tokenPair: `${tokenIn}->${tokenOut}`,
          });
          return;
        }

        const message = getAppWalletQuoteErrorMessage(error, {
          tokenIn,
          tokenOut,
        });
        quoteRequestKeyRef.current = null;
        quoteSuccessfulKeyRef.current = null;
        setQuote(null);
        setQuoteWalletMode(null);
        setErrorMessage(message);
        logAppWalletQuoteEvent("request_failed", {
          amountIn: amountInBaseUnits,
          provider: automaticAppWalletProvider ?? "none",
          sequence,
          tokenPair: `${tokenIn}->${tokenOut}`,
        });
      } finally {
        if (sequence === quoteSequenceRef.current) {
          quoteInFlightKeyRef.current = null;
          quoteAbortControllerRef.current = null;
          setRequestStatus("idle");
        }
      }
    }, APP_WALLET_QUOTE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (quoteTimerRef.current) {
        clearTimeout(quoteTimerRef.current);
        quoteTimerRef.current = null;
      }
      if (quoteInFlightKeyRef.current === appWalletQuoteRequestKey) {
        quoteSequenceRef.current += 1;
        quoteAbortControllerRef.current?.abort();
        quoteAbortControllerRef.current = null;
        quoteInFlightKeyRef.current = null;
      }
    };
  }, [
    amountInBaseUnits,
    appWalletQuoteRequestKey,
    automaticAppWalletProvider,
    isCircleWalletMode,
    modeBlockMessage,
    quoteRetryNonce,
    setAppWalletSwapProvider,
    setErrorMessage,
    setQuote,
    setQuoteWalletMode,
    setRequestStatus,
    tokenIn,
    tokenOut,
    walletAddress,
  ]);

  function resetSwapFeedback() {
    setErrorMessage(null);
    setSuccessState(null);
    appWalletLifecycle.reset();
    quoteAbortControllerRef.current?.abort();
    quoteAbortControllerRef.current = null;
    quoteInFlightKeyRef.current = null;
    quoteRequestKeyRef.current = null;
    quoteSuccessfulKeyRef.current = null;
    if (quoteTimerRef.current) {
      clearTimeout(quoteTimerRef.current);
      quoteTimerRef.current = null;
    }
    setQuote(null);
    setQuoteWalletMode(null);
  }

  function getRequestBase() {
    if (!walletAddress) {
      throw new Error("Connect a wallet before starting a swap.");
    }

    return {
      tokenIn,
      tokenOut,
      amountIn: amountInBaseUnits,
      fromAddress: walletAddress,
      chain: USER_SWAP_CHAIN,
    } as const;
  }

  async function requestQuote() {
    if (isCircleWalletMode) {
      return appWalletLifecycle.requestQuote();
    }

    if (modeBlockMessage) {
      setErrorMessage(modeBlockMessage);
      return null;
    }

    if (formInvalid) {
      setErrorMessage("Connect a wallet and enter a valid swap amount first.");
      return null;
    }

    setRequestStatus("quoting");
    setErrorMessage(null);

    try {
      const nextQuote = await quoteUserSwap({
        ...getRequestBase(),
        provider: externalSwapProvider,
        slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
      });
      setQuote(nextQuote);
      setQuoteWalletMode(walletMode);
      return nextQuote;
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      setErrorMessage(message);
      toast({
        title: "Quote unavailable",
        description: message,
        variant: "destructive",
      });
      return null;
    } finally {
      setRequestStatus("idle");
    }
  }

  async function copyToClipboard(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast({
        title: "Copied",
        description: `${label} copied to clipboard.`,
      });
    } catch {
      toast({
        title: "Copy failed",
        description: `Could not copy ${label}.`,
        variant: "destructive",
      });
    }
  }

  async function ensureExternalStablefxPermit2Allowance() {
    if (!isExternalWalletMode) {
      return;
    }

    if (!walletAddress || !walletClient || !publicClient) {
      throw new Error("External wallet is not ready for StableFX approval.");
    }

    const owner = normalizeStablefxAddress(walletAddress, "Owner address");
    const tokenAddress = tokenInConfig.address;
    const requiredAmount = amountInUnits;

    setRequestStatus("checkingAllowance");
    const allowance = (await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, PERMIT2_ADDRESS],
    })) as bigint;
    const allowanceEnough = allowance >= requiredAmount;

    logStablefxStep("allowance_check", {
      walletMode,
      tokenIn,
      tokenOut,
      owner,
      tokenAddress,
      spenderAddress: PERMIT2_ADDRESS,
      requiredAmount: requiredAmount.toString(),
      allowance: allowance.toString(),
      allowanceEnough,
    });

    if (allowanceEnough) {
      return;
    }

    setRequestStatus("approving");
    toast({
      title: `Approve ${tokenIn}`,
      description: `Approve ${tokenIn} spending for Circle StableFX, then the swap will continue automatically.`,
    });

    const approvalTxHash = await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [PERMIT2_ADDRESS, requiredAmount],
      account: owner,
      chain: arcTestnet,
    });

    logStablefxStep("approve", {
      walletMode,
      tokenIn,
      tokenOut,
      owner,
      tokenAddress,
      spenderAddress: PERMIT2_ADDRESS,
      requiredAmount: requiredAmount.toString(),
      approvalTxHash,
    });

    await publicClient.waitForTransactionReceipt({
      hash: approvalTxHash,
      confirmations: 1,
    });

    const confirmedAllowance = (await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, PERMIT2_ADDRESS],
    })) as bigint;
    const confirmedAllowanceEnough = confirmedAllowance >= requiredAmount;

    logStablefxStep("allowance_check", {
      walletMode,
      tokenIn,
      tokenOut,
      owner,
      tokenAddress,
      spenderAddress: PERMIT2_ADDRESS,
      requiredAmount: requiredAmount.toString(),
      allowance: confirmedAllowance.toString(),
      allowanceEnough: confirmedAllowanceEnough,
      approvalTxHash,
    });

    if (!confirmedAllowanceEnough) {
      throw new Error(
        `${tokenIn} approval confirmed but allowance is still below the StableFX input amount.`,
      );
    }
  }

  async function pollStablefxTrade(
    tradeId: string,
  ): Promise<StablefxTradeResponse> {
    let latest: StablefxTradeResponse | null = null;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      latest = await getStablefxTrade(tradeId);
      const status =
        typeof latest.status === "string" ? latest.status : undefined;

      if (isStablefxFinalStatus(status) || getStablefxExplorerTxHash(latest)) {
        return latest;
      }

      if (isStablefxFailureStatus(status)) {
        throw new Error(`StableFX trade ended with status ${status}.`);
      }

      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }

    if (latest) {
      return latest;
    }

    throw new Error("StableFX trade status was not available after funding.");
  }

  async function createStablefxTradeWithFreshQuote() {
    if (!isExternalWalletMode) {
      throw new Error(
        "Direct StableFX execution is only available for External Wallet mode.",
      );
    }

    if (!walletAddress) {
      throw new Error("Connect a wallet before starting a StableFX swap.");
    }

    const selectedAddress = normalizeStablefxAddress(
      walletAddress,
      "Selected wallet address",
    );

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      setRequestStatus("preparing");
      logStablefxStep("tradable_quote", {
        attempt,
        recipientAddress: selectedAddress,
        selectedAddress,
      });

      const tradableQuote = await createStablefxTradableQuote({
        ...getRequestBase(),
        fromAddress: selectedAddress,
        recipientAddress: selectedAddress,
      });
      const quoteTypedData = requireTypedData(
        tradableQuote.typedData,
        "StableFX tradable quote",
      );
      const quoteId = requireString(
        tradableQuote.id ?? tradableQuote.quoteId,
        "quoteId",
      );
      const quoteMessage = quoteTypedData.message as Record<string, unknown>;
      assertStablefxMessageAddressFields(quoteMessage, selectedAddress);

      logStablefxStep("tradable_quote", {
        attempt,
        messageAddressFields: collectStablefxMessageAddressFields(quoteMessage),
        selectedAddress,
        typedDataDomainVerifyingContract: isRecord(quoteTypedData.domain)
          ? quoteTypedData.domain.verifyingContract
          : undefined,
      });

      setRequestStatus("signing");
      logStablefxStep("sign_quote", {
        attempt,
        selectedAddress,
      });
      const signedQuoteTypedData = await signTypedDataWithMetadata({
        chainId: arcTestnet.id,
        memo: `StableFX ${tokenIn} to ${tokenOut} quote`,
        typedData: quoteTypedData,
      });
      logStablefxStep("sign_quote", {
        attempt,
        selectedAddress,
        signerAddress: signedQuoteTypedData.walletAddress,
        walletId: signedQuoteTypedData.walletId,
      });

      if (
        signedQuoteTypedData.walletAddress &&
        !addressesMatch(signedQuoteTypedData.walletAddress, selectedAddress)
      ) {
        throw new Error(
          "StableFX signature wallet does not match the selected external wallet address.",
        );
      }

      setRequestStatus("creating");
      const createTradeAddress = selectedAddress;
      if (!addressesMatch(selectedAddress, createTradeAddress)) {
        throw new Error(
          "StableFX create trade address does not match the selected wallet address.",
        );
      }
      logStablefxStep("create_trade", {
        attempt,
        createTradeAddress,
        selectedAddress,
        walletId: signedQuoteTypedData.walletId,
      });

      try {
        const trade = await createStablefxTrade({
          idempotencyKey: crypto.randomUUID(),
          quoteId,
          address: createTradeAddress,
          selectedAddress,
          message: quoteMessage,
          signature: signedQuoteTypedData.signature,
          tokenIn,
          tokenOut,
          walletMode: "external",
        });

        return {
          trade,
          tradableQuote,
        };
      } catch (error) {
        if (isStablefxQuoteExpiredError(error) && attempt === 1) {
          logStablefxStep("create_trade", {
            attempt,
            upstreamCode: 3004,
            retrying: true,
          });
          continue;
        }

        if (isStablefxQuoteExpiredError(error)) {
          throw new Error(
            "StableFX quote expired before signing completed. Please retry.",
          );
        }

        throw error;
      }
    }

    throw new Error(
      "StableFX quote expired before signing completed. Please retry.",
    );
  }

  async function waitForStablefxFundingIdentifier(
    createdTrade: StablefxTradeResponse,
  ) {
    const tradeId = requireString(createdTrade.id, "tradeId");
    const immediateContractTradeId =
      resolveStablefxContractTradeId(createdTrade);

    if (immediateContractTradeId) {
      return {
        contractTradeId: immediateContractTradeId,
        trade: createdTrade,
        tradeId,
      };
    }

    for (let attempt = 1; attempt <= 15; attempt += 1) {
      setRequestStatus("settling");
      logStablefxStep("get_trade", { attempt, tradeId });
      const latestTrade = await getStablefxTrade(tradeId);
      const contractTradeId = resolveStablefxContractTradeId(latestTrade);

      if (contractTradeId) {
        return {
          contractTradeId,
          trade: latestTrade,
          tradeId,
        };
      }

      const status =
        typeof latestTrade.status === "string" ? latestTrade.status : undefined;
      const recordTradeStatus = getStablefxRecordTradeStatus(latestTrade);

      if (recordTradeStatus?.toLowerCase() === "failed") {
        const failureDetail = getStablefxRecordTradeFailureDetail(latestTrade);
        const recordTradeTxHash = getStablefxRecordTradeTxHash(latestTrade);
        throw new Error(
          failureDetail
            ? `StableFX ${tokenIn} -> ${tokenOut} recordTrade failed after approval. Trade ID ${tradeId}. Details: ${failureDetail}${recordTradeTxHash ? ` Record tx: ${recordTradeTxHash}.` : ""}`
            : `StableFX ${tokenIn} -> ${tokenOut} recordTrade failed after approval. Contact Circle with trade ID ${tradeId} for the on-chain recordTrade failure details.`,
        );
      }

      if (isStablefxFailureStatus(status)) {
        throw new Error(
          `StableFX trade ended with status ${status} before funding.`,
        );
      }

      await delay(2_000);
    }

    throw new Error(
      "StableFX trade was created but funding identifier was not ready yet. Please retry status check.",
    );
  }

  async function executeStablefxSwap(activeQuote: SwapQuoteState) {
    if (!isExternalWalletMode) {
      await appWalletLifecycle.createDepositInstruction();
      return;
    }

    await ensureExternalStablefxPermit2Allowance();
    const { trade, tradableQuote } = await createStablefxTradeWithFreshQuote();
    const { contractTradeId, tradeId } =
      await waitForStablefxFundingIdentifier(trade);

    logStablefxStep("funding_presign");
    const fundingPresign = await createStablefxFundingPresign({
      contractTradeId,
    });
    const fundingTypedData = requireTypedData(
      fundingPresign.typedData,
      "StableFX funding presign",
    );

    setRequestStatus("signing");
    const fundingSignature = await signTypedData({
      chainId: arcTestnet.id,
      memo: `StableFX ${tokenIn} funding`,
      typedData: fundingTypedData,
    });

    setRequestStatus("funding");
    logStablefxStep("fund");
    await fundStablefxTrade({
      permit2: fundingTypedData.message as Record<string, unknown>,
      signature: fundingSignature,
    });

    setRequestStatus("settling");
    const settledTrade = await pollStablefxTrade(tradeId);
    const settlementTxHash = getStablefxExplorerTxHash(settledTrade, {
      includeRecordTrade: true,
    });
    const status =
      typeof settledTrade.status === "string" ? settledTrade.status : null;
    const amountOut =
      findFirstString(settledTrade, ["to.amount"]) ??
      findFirstString(tradableQuote, ["to.amount"]) ??
      getUserSwapExpectedOutputDisplay(activeQuote, tokenOut);

    setSuccessState({
      amountIn,
      amountOut: amountOut ? `${amountOut} ${tokenOut}` : null,
      explorerUrl: settlementTxHash
        ? `${EXPLORER_BASE_URL}/tx/${settlementTxHash}`
        : null,
      instructionCount: 2,
      referenceId: tradeId,
      status: isStablefxSuccessStatus(status ?? undefined)
        ? "success"
        : "pending",
      tokenIn,
      tokenOut,
      transactionId: tradeId,
      transactionStatus: status,
      txHash: settlementTxHash,
      walletMode,
    });
    setIsSuccessDialogOpen(true);
    toast({
      title: settlementTxHash
        ? "StableFX swap settled"
        : "StableFX swap funded",
      description: settlementTxHash
        ? `StableFX settlement ${shortenHash(settlementTxHash)} on Arc Testnet.`
        : `StableFX trade ${status ?? "funded"} by Circle.`,
    });
  }

  async function executeXylonetSwap(activeQuote: SwapQuoteState) {
    if (!isExternalWalletMode) {
      throw new Error(
        "XyloNet execution is only available for External Wallet mode.",
      );
    }

    if (!walletAddress || !walletClient || !publicClient) {
      throw new Error(
        "Connect an external EVM wallet before executing XyloNet.",
      );
    }

    if (walletClient.chain?.id !== arcTestnet.id) {
      throw new Error(
        "Switch your external wallet to Arc Testnet before executing XyloNet.",
      );
    }

    if (getQuoteProvider(activeQuote) !== "xylonet") {
      throw new Error("Request a fresh XyloNet quote before executing.");
    }

    const owner = normalizeStablefxAddress(walletAddress, "Owner address");
    const executorAddress = getQuoteAddressValue(
      activeQuote,
      ["executorAddress"],
      ["executorAddress"],
      "executor address",
    );
    const routerAddress = getQuoteAddressValue(
      activeQuote,
      ["routerAddress"],
      ["routerAddress"],
      "router address",
    );
    const tokenInAddress = getQuoteAddressValue(
      activeQuote,
      [],
      ["tokenInAddress"],
      "tokenIn address",
    );
    const tokenOutAddress = getQuoteAddressValue(
      activeQuote,
      [],
      ["tokenOutAddress"],
      "tokenOut address",
    );
    const inputAmount = getQuoteBaseUnitValue(
      activeQuote,
      ["amountIn"],
      ["amountIn"],
      "amountIn",
    );
    const minAmountOut = getQuoteBaseUnitValue(
      activeQuote,
      ["minAmountOut", "minimumAmountOut", "minimumOutput"],
      ["minAmountOut", "minimumAmountOut", "minimumOutput"],
      "minAmountOut",
    );
    const recipient = getQuoteAddressValue(
      activeQuote,
      ["toAddress"],
      ["toAddress", "recipient"],
      "recipient address",
    );
    const deadline = BigInt(
      Math.floor(Date.now() / 1000) + XYLONET_EXECUTION_DEADLINE_SECONDS,
    );
    let instructionCount = 1;

    setRequestStatus("checkingAllowance");
    const allowance = (await publicClient.readContract({
      address: tokenInAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, executorAddress],
    })) as bigint;

    if (allowance < inputAmount) {
      instructionCount += 1;
      setRequestStatus("approving");
      toast({
        title: `Approve ${tokenIn}`,
        description: `Approve ${tokenIn} spending for the WizPay XyloNet executor, then the swap will continue automatically.`,
      });

      const approvalTxHash = await walletClient.writeContract({
        address: tokenInAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [executorAddress, inputAmount],
        account: owner,
        chain: arcTestnet,
      });

      await publicClient.waitForTransactionReceipt({
        hash: approvalTxHash,
        confirmations: 1,
      });

      const confirmedAllowance = (await publicClient.readContract({
        address: tokenInAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, executorAddress],
      })) as bigint;

      if (confirmedAllowance < inputAmount) {
        throw new Error(
          `${tokenIn} approval confirmed but allowance is still below the XyloNet input amount.`,
        );
      }
    }

    setRequestStatus("executing");
    const txHash = await walletClient.writeContract({
      address: executorAddress,
      abi: WIZPAY_SWAP_EXECUTOR_ABI,
      functionName: "executeSwap",
      args: [
        routerAddress,
        tokenInAddress,
        tokenOutAddress,
        inputAmount,
        minAmountOut,
        recipient,
        deadline,
      ],
      account: owner,
      chain: arcTestnet,
    });

    await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    });

    setSuccessState({
      amountIn,
      amountOut: getUserSwapExpectedOutputDisplay(activeQuote, tokenOut),
      explorerUrl: `${EXPLORER_BASE_URL}/tx/${txHash}`,
      instructionCount,
      referenceId: txHash,
      status: "success",
      tokenIn,
      tokenOut,
      transactionId: txHash,
      transactionStatus: "COMPLETE",
      txHash,
      walletMode: "external",
    });
    setIsSuccessDialogOpen(true);
    toast({
      title: "XyloNet swap submitted",
      description: `External wallet submitted ${shortenHash(txHash)} on Arc Testnet.`,
    });
  }

  async function handleSwap() {
    if (modeBlockMessage) {
      setErrorMessage(modeBlockMessage);
      return;
    }

    if (isExternalWalletMode && !walletClient) {
      setErrorMessage("Connect an external EVM wallet before swapping.");
      return;
    }

    if (formInvalid) {
      setErrorMessage("Connect a wallet and enter a valid swap amount first.");
      return;
    }

    if (isExternalWalletMode && insufficientBalance) {
      setErrorMessage(`Insufficient ${tokenIn} balance.`);
      return;
    }

    if (isCircleWalletMode && !appWalletQuoteIsValid) {
      setErrorMessage(
        "Wait for a current, valid App Wallet quote before confirming the swap.",
      );
      return;
    }

    setErrorMessage(null);

    try {
      const activeQuote = isCircleWalletMode
        ? quote
        : quoteMatchesForm
          ? quote
          : await requestQuote();

      if (!activeQuote) {
        return;
      }

      if (
        isExternalWalletMode &&
        (externalSwapProvider === "xylonet" ||
          getQuoteProvider(activeQuote) === "xylonet")
      ) {
        await executeXylonetSwap(activeQuote);
        return;
      }

      if (getQuoteProvider(activeQuote) === "stablefx") {
        if (!isExternalWalletMode) {
          if (!isCircleWalletMode) {
            setErrorMessage(
              "Select an external wallet or Circle App Wallet before starting a StableFX swap.",
            );
            return;
          }

          await appWalletLifecycle.createDepositInstruction();
          return;
        }

        if (!stablefxCapability.enabled) {
          setErrorMessage(
            stablefxCapability.message ??
              "StableFX execution requires an App Wallet or external wallet.",
          );
          return;
        }

        await executeStablefxSwap(activeQuote);
        return;
      }

      setRequestStatus("preparing");

      if (isCircleWalletMode) {
        await appWalletLifecycle.createDepositInstruction();
        return;
      }

      const prepared = await prepareUserSwap({
        ...getRequestBase(),
        slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
      });

      setRequestStatus("signing");

      if (!swapAdapter) {
        throw new Error(
          "Swap adapter is not ready for the connected external wallet.",
        );
      }

      const txHash = await executePreparedArcUserSwap({
        adapter: swapAdapter,
        prepared,
        tokenIn,
      });

      if (!isTransactionHash(txHash)) {
        throw new Error("Wallet returned an invalid transaction hash.");
      }

      setSuccessState({
        amountIn,
        amountOut: getPreparedAmountOut(prepared, tokenOut),
        explorerUrl: `${EXPLORER_BASE_URL}/tx/${txHash}`,
        instructionCount: 1,
        referenceId: txHash,
        status: "success",
        tokenIn,
        tokenOut,
        transactionId: txHash,
        transactionStatus: "COMPLETE",
        txHash,
        walletMode: "external",
      });
      setIsSuccessDialogOpen(true);
      toast({
        title: "Swap submitted",
        description: `External wallet submitted ${shortenHash(txHash)} on Arc Testnet.`,
      });
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      if (isCircleWalletMode) {
        quoteRequestKeyRef.current = null;
        quoteSuccessfulKeyRef.current = null;
        setQuote(null);
        setQuoteWalletMode(null);
        setErrorMessage(
          message === "Internal server error"
            ? "App Wallet operation could not be created. The quote was invalidated; retry after local provider configuration is repaired."
            : message,
        );
      } else {
        setErrorMessage(message);
      }
      toast({
        title: "Swap failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setRequestStatus("idle");
    }
  }

  return (
    <>
      <div className="animate-fade-up space-y-4 sm:space-y-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Swap
          </h1>
          <p className="text-sm text-muted-foreground/70">
            {isCircleWalletMode
              ? "Swap tokens using your App Wallet on Arc Testnet."
              : "External wallet Arc Testnet swap. Signed by connected external wallet."}
          </p>
        </div>

        <Card className="glass-card mx-auto max-w-lg overflow-hidden border-border/40">
          <CardContent className="space-y-4 py-5 sm:space-y-5 sm:py-6">
            <div className="space-y-3 rounded-2xl border border-border/40 bg-background/35 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  You pay
                </span>
                <span className="text-xs text-muted-foreground/50">
                  {isExternalWalletMode
                    ? `Balance: ${formatTokenAmount(currentBalance, tokenInConfig.decimals)} ${tokenIn}`
                    : "App Wallet swap"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.000001"
                  placeholder="0.0"
                  value={amountIn}
                  onChange={(event) => {
                    resetSwapFeedback();
                    setAmountIn(event.target.value);
                  }}
                  className="h-12 flex-1 border-0 bg-transparent p-0 text-2xl font-bold placeholder:text-muted-foreground/30 focus-visible:ring-0"
                />
                <Select
                  value={tokenIn}
                  onValueChange={(value) => {
                    const nextTokenIn = value as TokenSymbol;

                    resetSwapFeedback();
                    setTokenIn(nextTokenIn);

                    if (nextTokenIn === tokenOut) {
                      setTokenOut(nextTokenIn === "USDC" ? "EURC" : "USDC");
                    }
                  }}
                >
                  <SelectTrigger className="h-10 w-[110px] rounded-xl border-border/40 bg-background/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(SUPPORTED_TOKENS).map((token) => (
                      <SelectItem
                        key={`in-${token.symbol}`}
                        value={token.symbol}
                      >
                        {token.symbol}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="relative z-10 -my-2 flex justify-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/40 bg-card/80 text-primary shadow-lg">
                <ArrowRightLeft className="h-4 w-4 rotate-90" />
              </div>
            </div>

            <div className="space-y-3 rounded-2xl border border-border/40 bg-background/35 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  You receive
                </span>
                <span className="text-xs text-muted-foreground/50">
                  Backend proxy quote
                </span>
              </div>
              <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 text-2xl font-bold">
                  {expectedOutput ?? "0.0"}
                </p>
                <Select
                  value={tokenOut}
                  onValueChange={(value) => {
                    resetSwapFeedback();
                    setTokenOut(value as TokenSymbol);
                  }}
                >
                  <SelectTrigger className="h-10 w-[110px] rounded-xl border-border/40 bg-background/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(SUPPORTED_TOKENS)
                      .filter((token) => token.symbol !== tokenIn)
                      .map((token) => (
                        <SelectItem
                          key={`out-${token.symbol}`}
                          value={token.symbol}
                        >
                          {token.symbol}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {isExternalWalletMode ? (
              <div className="space-y-2 rounded-xl border border-border/30 bg-background/20 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                      Provider
                    </div>
                    <div className="text-xs text-muted-foreground/60">
                      External Wallet only
                    </div>
                  </div>
                  <Select
                    value={externalSwapProvider}
                    onValueChange={(value) => {
                      resetSwapFeedback();
                      setQuote(null);
                      setExternalSwapProvider(
                        value as ExternalWalletSwapProvider,
                      );
                    }}
                  >
                    <SelectTrigger className="h-10 w-[180px] rounded-xl border-border/40 bg-background/50">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stablefx">
                        StableFX Official
                      </SelectItem>
                      <SelectItem value="xylonet">XyloNet</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : isCircleWalletMode ? (
              <div className="space-y-2 rounded-xl border border-border/30 bg-background/20 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                      Provider
                    </div>
                    <div className="text-xs text-muted-foreground/60">
                      App Wallet only
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-foreground">
                      {displayedAppWalletProvider
                        ? APP_WALLET_SWAP_PROVIDER_LABELS[
                            displayedAppWalletProvider
                          ]
                        : "—"}
                    </div>
                    <div className="text-xs text-muted-foreground/60">
                      Auto-selected
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="space-y-2 rounded-xl border border-border/30 bg-background/20 px-4 py-3 text-sm">
              <div className="flex justify-between gap-3 text-muted-foreground/70">
                <span>Network</span>
                <span className="font-mono text-foreground">Arc Testnet</span>
              </div>
              {activeProviderLabel ? (
                <div className="flex justify-between gap-3 text-muted-foreground/70">
                  <span>Provider</span>
                  <span className="font-mono text-foreground">
                    {activeProviderLabel}
                  </span>
                </div>
              ) : null}
              <div className="flex justify-between gap-3 text-muted-foreground/70">
                <span>Expected output</span>
                <span className="font-mono text-foreground">
                  {expectedOutput ?? "-"}
                </span>
              </div>
              <div className="flex justify-between gap-3 text-muted-foreground/70">
                <span>Minimum output</span>
                <span className="font-mono text-foreground">
                  {minimumOutput ?? "-"}
                </span>
              </div>
              {quoteExpiry ? (
                <div className="flex justify-between gap-3 text-muted-foreground/70">
                  <span>Quote expiry</span>
                  <span className="font-mono text-foreground">
                    {quoteExpiry}
                  </span>
                </div>
              ) : null}
              <div className="flex justify-between gap-3 text-muted-foreground/70">
                <span>Slippage</span>
                <span className="font-mono text-foreground">2%</span>
              </div>
            </div>

            {modeBlockMessage ? (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
                {modeBlockMessage}
              </div>
            ) : null}

            {isXylonetSelected ? (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
                XyloNet execution is available for External Wallet swaps only.
                Your wallet will approve the executor before the swap if needed.
              </div>
            ) : null}

            {isCircleWalletMode ? (
              <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 px-4 py-3 text-sm text-sky-100">
                {isStablefxQuote
                  ? "For App Wallet swaps, WizPay uses a Treasury execution wallet to complete StableFX because Circle App Wallets on Arc are smart contract accounts."
                  : "App Wallet swap settles securely through WizPay. Approve the deposit and your swap will complete automatically."}
              </div>
            ) : null}

            {isStablefxQuote ? (
              <div className="space-y-2 rounded-xl border border-sky-500/25 bg-sky-500/5 px-4 py-3 text-sm text-sky-100">
                <div className="font-medium">StableFX capability</div>
                <div className="text-xs text-sky-100/85">
                  Current path: {stablefxCapability.label}
                </div>
                <div className="grid gap-1 text-xs text-sky-100/85">
                  <span>External USDC {"->"} EURC: enabled</span>
                  <span>External EURC {"->"} USDC: enabled</span>
                  <span>App Wallet USDC {"->"} EURC: enabled</span>
                  <span>App Wallet EURC {"->"} USDC: enabled</span>
                </div>
                {stablefxCapability.message ? (
                  <div className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-100">
                    {stablefxCapability.message}
                  </div>
                ) : null}
              </div>
            ) : null}

            {errorMessage && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                <span>{errorMessage}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setErrorMessage(null)}
                  className="shrink-0 text-destructive hover:text-destructive/80"
                >
                  Dismiss
                </Button>
                {isCircleWalletMode && !formInvalid ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setErrorMessage(null);
                      setQuoteRetryNonce((value) => value + 1);
                    }}
                    className="shrink-0 text-destructive hover:text-destructive/80"
                  >
                    Retry quote
                  </Button>
                ) : null}
              </div>
            )}

            {isExternalWalletMode &&
              insufficientBalance &&
              amountInUnits > 0n && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
                  Insufficient {tokenIn} balance.
                </div>
              )}

            <div className="grid gap-3 sm:grid-cols-2">
              {isExternalWalletMode ? (
                <Button
                  variant="outline"
                  onClick={() => void requestQuote()}
                  disabled={quoteDisabled}
                  className="h-12 text-base"
                >
                  {requestStatus === "quoting" ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      Quoting...
                    </span>
                  ) : (
                    "Preview quote"
                  )}
                </Button>
              ) : (
                <div className="flex h-12 items-center justify-center rounded-md border border-border/40 bg-background/20 text-sm text-muted-foreground">
                  {requestStatus === "quoting"
                    ? "Getting quote..."
                    : appWalletQuoteIsValid
                      ? "Quote updated automatically"
                      : "Enter a valid amount to get a quote"}
                </div>
              )}
              <Button
                onClick={() => void guard(handleSwap)}
                disabled={swapDisabled}
                className="glow-btn h-12 bg-gradient-to-r from-primary to-violet-500 text-base text-primary-foreground shadow-lg shadow-primary/20"
              >
                {requestStatus === "preparing" ||
                requestStatus === "checkingAllowance" ||
                requestStatus === "approving" ||
                requestStatus === "signing" ||
                requestStatus === "creating" ||
                requestStatus === "executing" ||
                requestStatus === "funding" ||
                requestStatus === "settling" ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {requestStatus === "creating"
                      ? "Preparing..."
                      : requestStatus === "checkingAllowance"
                        ? `Checking ${tokenIn} allowance...`
                        : requestStatus === "approving"
                          ? `Approve ${tokenIn} spending...`
                          : requestStatus === "executing"
                            ? "Executing..."
                            : requestStatus === "funding"
                              ? "Funding..."
                              : requestStatus === "settling"
                                ? "Checking status..."
                                : requestStatus === "signing"
                                  ? isCircleWalletMode
                                    ? "Waiting for confirmation..."
                                    : "Signing..."
                                  : "Preparing..."}
                  </span>
                ) : (
                  <>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    {isCircleWalletMode ? "Confirm swap" : "Swap"}
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-primary" />
              Token Pair
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground/80">
            <p>
              Only Arc Testnet USDC and EURC are enabled. External wallets sign
              directly via the connected browser wallet. App Wallet swaps are
              settled securely by WizPay after you approve the deposit.
            </p>
          </CardContent>
        </Card>
      </div>

      <AppWalletSwapProgress
        isCircleWalletMode={isCircleWalletMode}
        isGuarded={isGuarded}
        isOpen={appWalletLifecycle.isOperationOpen}
        isRefundConfirmationOpen={appWalletLifecycle.isRefundConfirmationOpen}
        onCopy={(value, label) => void copyToClipboard(value, label)}
        onExecute={() => void guard(appWalletLifecycle.executeSwap)}
        onOpenChange={appWalletLifecycle.setIsOperationOpen}
        onRefund={() => void guard(appWalletLifecycle.requestRefund)}
        onRefundConfirmationOpenChange={
          appWalletLifecycle.setIsRefundConfirmationOpen
        }
        onReset={resetSwapFeedback}
        onSubmitDeposit={() => void guard(appWalletLifecycle.submitDeposit)}
        operation={appWalletOperation}
        requestStatus={requestStatus}
      />

      <Dialog open={isSuccessDialogOpen} onOpenChange={setIsSuccessDialogOpen}>
        <DialogContent className="glass-card max-w-md overflow-hidden border-border/40 bg-background/95 p-0">
          <div className="relative overflow-hidden p-6">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
            <div
              className={`mb-5 flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ${
                successState?.status === "pending"
                  ? "bg-amber-500/12 text-amber-300 ring-amber-400/20"
                  : "bg-emerald-500/12 text-emerald-400 ring-emerald-400/20"
              }`}
            >
              {successState?.status === "pending" ? (
                <Clock3 className="h-7 w-7" />
              ) : (
                <CheckCircle2 className="h-7 w-7" />
              )}
            </div>
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl">
                {successState?.status === "pending"
                  ? "Swap Pending"
                  : successState?.walletMode === "circle"
                    ? "Payout Confirmed"
                    : "Swap Confirmed"}
              </DialogTitle>
              <DialogDescription>
                {successState?.status === "pending"
                  ? successState.walletMode === "circle"
                    ? "App Wallet swap is waiting for confirmed payout."
                    : "Transaction submitted. Waiting for confirmation."
                  : successState?.walletMode === "circle"
                    ? "Payout is confirmed on Arc Testnet."
                    : "Your external wallet submitted the Arc Testnet swap transaction."}
              </DialogDescription>
            </DialogHeader>

            {successState ? (
              <div className="mt-6 space-y-4">
                {successState.status === "success"
                  ? (() => {
                      const xShareUrl = buildXShareUrl({
                        summary:
                          successState.walletMode === "circle"
                            ? `WizPay Circle App Wallet swap: ${successState.amountIn} ${successState.tokenIn} to ${successState.tokenOut} on Arc Testnet.`
                            : `WizPay external-wallet swap: ${successState.amountIn} ${successState.tokenIn} to ${successState.tokenOut} on Arc Testnet.`,
                        explorerUrl: successState.explorerUrl ?? undefined,
                        secondaryText: `Reference: ${successState.txHash ?? successState.referenceId}`,
                      });

                      return (
                        <Button
                          variant="outline"
                          className="w-full gap-2 border-[#1DA1F2]/50 text-[#1DA1F2] hover:bg-[#1DA1F2]/10"
                          asChild
                        >
                          <a href={xShareUrl} target="_blank" rel="noreferrer">
                            <MessageCircle className="h-4 w-4" />
                            Share to X (Twitter)
                          </a>
                        </Button>
                      );
                    })()
                  : null}

                <div className="rounded-2xl border border-border/40 bg-background/45 p-4">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Route</span>
                    <span className="font-medium">
                      {successState.tokenIn} to {successState.tokenOut}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Amount in</span>
                    <span className="font-mono font-medium">
                      {successState.amountIn} {successState.tokenIn}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Expected out
                    </span>
                    <span className="font-mono font-medium">
                      {successState.amountOut ??
                        "Returned by Circle when available"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Execution</span>
                    <span className="text-right font-medium">
                      {successState.walletMode === "circle"
                        ? "Circle App Wallet challenge"
                        : "External wallet"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Instructions
                    </span>
                    <span className="font-mono font-medium">
                      {successState.instructionCount}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Transaction
                    </span>
                    <span className="font-mono font-medium">
                      {successState.txHash
                        ? shortenHash(successState.txHash)
                        : "Pending by reference"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Circle status
                    </span>
                    <span className="font-mono font-medium">
                      {successState.transactionStatus ?? "-"}
                    </span>
                  </div>
                  {successState.transactionId ? (
                    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground/70">
                        Transaction id
                      </span>
                      <span className="min-w-0 break-all text-right font-mono font-medium">
                        {successState.transactionId}
                      </span>
                    </div>
                  ) : null}
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Reference</span>
                    <span className="min-w-0 break-all text-right font-mono font-medium">
                      {successState.referenceId}
                    </span>
                  </div>
                  {!successState.txHash ? (
                    <p className="mt-3 text-xs text-muted-foreground/70">
                      Circle returned a referenceId but no txHash. The
                      transaction is not shown as settled until Circle returns a
                      txHash.
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-3 sm:flex-row">
                  {successState.explorerUrl ? (
                    <Button asChild className="flex-1">
                      <a
                        href={successState.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View transaction
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setIsSuccessDialogOpen(false)}
                  >
                    Close
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
