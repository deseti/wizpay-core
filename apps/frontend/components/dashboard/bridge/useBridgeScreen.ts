"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import type { Address } from "viem";
import {
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWalletClient,
} from "wagmi";

import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { useHybridWallet } from "@/components/providers/HybridWalletProvider";
import { useToast } from "@/hooks/use-toast";
import { useAdaptivePolling } from "@/hooks/useAdaptivePolling";
import { useDialogState } from "@/hooks/useDialogState";
import {
  bootstrapCircleTransferWallet,
  createCircleTransfer,
  getCircleTransferStatus,
  getCircleTransferWallet,
  TransferApiError,
  type CircleTransfer,
  type CircleTransferBlockchain,
  type CircleTransferWallet,
} from "@/lib/transfer-service";
import { CCTP_USDC_DECIMALS, CHAIN_ID_BY_BRIDGE_CHAIN } from "@/lib/cctp";
import { ERC20_ABI } from "@/constants/erc20";

import {
  BRIDGE_ASSET_SYMBOL,
  BRIDGE_EXTERNAL_ENABLED,
  BRIDGE_POLL_INTERVAL_MS,
  BRIDGE_STUCK_TIMEOUT_MS,
  DEFAULT_SOURCE_BLOCKCHAIN,
  DESTINATION_OPTIONS,
  USDC_ADDRESS_BY_CHAIN,
  type DestinationWalletMap,
} from "./bridge-types";
import {
  clearStoredActiveTransfer,
  clearStoredTransferWallet,
  getStoredActiveTransfer,
  getStoredTransferWallet,
  setStoredActiveTransfer,
  setStoredTransferWallet,
} from "./bridge-storage";
import {
  getBridgeErrorMessage,
  getDefaultDestinationBlockchain,
  getEstimatedBridgeTimeLabel,
  getOptionByChain,
  getTreasuryFundingMessage,
  getTreasurySetupMessage,
  isPositiveDecimal,
  isSolanaChain,
  isTrackedTransfer,
  isValidDestinationAddress,
  recoverTerminalTransfer,
  shortenAddress,
} from "./bridge-utils";
import {
  retryExternalAttestationAndMint,
  submitExternalBridge,
} from "./useExternalBridge";

export function useBridgeScreen() {
  const {
    arcWallet,
    sepoliaWallet,
    solanaWallet,
    authMethod,
    createContractExecutionChallenge,
    createTransferChallenge,
    executeChallenge,
    getWalletBalances,
    savePasskeySolanaAddress,
    userEmail,
  } = useCircleWallet();
  const { walletMode, externalWalletAddress, externalWalletChainId } =
    useHybridWallet();
  const { data: externalWalletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const { toast } = useToast();
  const initialSourceBlockchain: CircleTransferBlockchain =
    authMethod === "passkey" ? "ARC-TESTNET" : DEFAULT_SOURCE_BLOCKCHAIN;

  // ── Refs ───────────────────────────────────────────────────────────────────────
  const restoredTransferRef = useRef(false);
  const terminalNoticeRef = useRef<string | null>(null);
  const reconnectingPollCountRef = useRef(0);
  const pollTransferFnRef = useRef<(() => Promise<void>) | null>(null);

  // ── Route state ────────────────────────────────────────────────────────────────
  const [sourceChain, setSourceChain] = useState<CircleTransferBlockchain>(
    initialSourceBlockchain
  );
  const [destinationChain, setDestinationChain] =
    useState<CircleTransferBlockchain>(
      getDefaultDestinationBlockchain(initialSourceBlockchain)
    );
  const [amount, setAmount] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");

  // ── Transfer / UI state ────────────────────────────────────────────────────────
  const [transfer, setTransfer] = useState<CircleTransfer | null>(null);
  const [transferWallet, setTransferWallet] =
    useState<CircleTransferWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [walletStatusError, setWalletStatusError] = useState<string | null>(
    null
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDepositingToTreasury, setIsDepositingToTreasury] = useState(false);
  const [isWalletLoading, setIsWalletLoading] = useState(false);
  const [isWalletBootstrapping, setIsWalletBootstrapping] = useState(false);
  const [isPollingTransfer, setIsPollingTransfer] = useState(false);
  const [isReconnectingToTracking, setIsReconnectingToTracking] =
    useState(false);
  const { isOpen: isReviewDialogOpen, setIsOpen: setIsReviewDialogOpen } =
    useDialogState();
  const { isOpen: isSuccessDialogOpen, setIsOpen: setIsSuccessDialogOpen } =
    useDialogState();
  const [destinationWallets, setDestinationWallets] =
    useState<DestinationWalletMap>({});
  const [isDestinationWalletsLoading, setIsDestinationWalletsLoading] =
    useState(false);
  const [copiedWallet, setCopiedWallet] = useState<string | null>(null);
  const [passkeySolanaInput, setPasskeySolanaInput] = useState("");

  const tokenSymbol = BRIDGE_ASSET_SYMBOL;

  // ── Derived values ─────────────────────────────────────────────────────────────
  const sourceOption = useMemo(
    () => getOptionByChain(sourceChain),
    [sourceChain]
  );
  const destinationOption = useMemo(
    () => getOptionByChain(destinationChain),
    [destinationChain]
  );
  const suggestedDestinationAddress =
    destinationChain === "ARC-TESTNET"
      ? (arcWallet?.address ?? "")
      : destinationChain === "ETH-SEPOLIA"
        ? (sepoliaWallet?.address ?? "")
        : (solanaWallet?.address ?? "");
  const destinationTokenAddress = USDC_ADDRESS_BY_CHAIN[destinationChain];
  const sourceTokenAddress = USDC_ADDRESS_BY_CHAIN[sourceChain];
  const isSameChainRoute = sourceChain === destinationChain;
  const bridgeExecutionMode =
    walletMode === "external" ? "external_signer" : "app_treasury";
  const isPasskeyWalletSession = authMethod === "passkey";
  const isPasskeyUnsupportedSource =
    isPasskeyWalletSession &&
    (sourceChain === "SOLANA-DEVNET" || sourceChain === "ETH-SEPOLIA");
  const passkeySourceRestrictionMessage =
    "Passkey wallet can only use Arc as source. Use Google login, Email, OTP, or External Wallet (MetaMask) for Solana and Ethereum Sepolia source.";
  const sourceAccountType =
    bridgeExecutionMode === "external_signer"
      ? "external_wallet"
      : "app_treasury_wallet";
  const isExternalBridgeMode = bridgeExecutionMode === "external_signer";
  const isExternalEvmBridge =
    isExternalBridgeMode &&
    BRIDGE_EXTERNAL_ENABLED &&
    !isSolanaChain(sourceChain) &&
    !isSolanaChain(destinationChain);
  const sourceChainId = CHAIN_ID_BY_BRIDGE_CHAIN[sourceChain];
  const destChainId = CHAIN_ID_BY_BRIDGE_CHAIN[destinationChain];
  const sourcePublicClient = usePublicClient({ chainId: sourceChainId });
  const destPublicClient = usePublicClient({ chainId: destChainId });
  const externalBridgeModeMessage = !BRIDGE_EXTERNAL_ENABLED
    ? `External wallet bridge is currently disabled. Switch to App Wallet (Circle) to continue.`
    : isSolanaChain(sourceChain) || isSolanaChain(destinationChain)
      ? `External wallet bridge does not support Solana routes. Switch to App Wallet (Circle) or select an EVM-only route.`
      : null;

  const externalUsdcAddress = isExternalEvmBridge
    ? (sourceTokenAddress as Address | undefined)
    : undefined;
  const { data: externalUsdcBalanceRaw } = useReadContract({
    abi: ERC20_ABI,
    address: externalUsdcAddress,
    functionName: "balanceOf",
    args: externalWalletAddress ? [externalWalletAddress] : undefined,
    chainId: sourceChainId,
    query: {
      enabled: Boolean(
        isExternalEvmBridge &&
          externalWalletAddress &&
          externalUsdcAddress &&
          sourceChainId
      ),
      staleTime: 10_000,
      refetchInterval: 15_000,
    },
  });
  const externalUsdcBalance =
    typeof externalUsdcBalanceRaw === "bigint"
      ? Number(formatUnits(externalUsdcBalanceRaw, CCTP_USDC_DECIMALS))
      : null;
  const externalUsdcBalanceLabel =
    externalUsdcBalance !== null
      ? `${externalUsdcBalance.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`
      : "Loading...";
  const hasEnoughExternalUsdc =
    externalUsdcBalance === null ||
    !isPositiveDecimal(amount) ||
    externalUsdcBalance >= Number(amount);

  const walletBalanceAmount = Number(transferWallet?.balance?.amount || "0");
  const walletBalanceKnown = transferWallet?.balance != null;
  const treasuryWalletEmpty =
    walletBalanceKnown &&
    Number.isFinite(walletBalanceAmount) &&
    walletBalanceAmount <= 0;
  const hasSufficientWalletBalance =
    !walletBalanceKnown ||
    !Number.isFinite(Number(amount || "0")) ||
    Number(amount || "0") <= 0 ||
    walletBalanceAmount >= Number(amount || "0");
  const isTransferActive = isTrackedTransfer(transfer);
  const isExternalBridgeTransfer =
    transfer?.transferId?.startsWith("ext-") ?? false;

  const estimatedTimeLabel = useMemo(() => {
    const effectiveSource = transfer?.sourceBlockchain ?? sourceChain;
    return getEstimatedBridgeTimeLabel(
      effectiveSource,
      isExternalBridgeTransfer || isExternalEvmBridge
    );
  }, [
    isExternalBridgeTransfer,
    isExternalEvmBridge,
    sourceChain,
    transfer?.sourceBlockchain,
  ]);

  const canSubmitAppWallet =
    !isExternalBridgeMode &&
    Boolean(transferWallet) &&
    hasSufficientWalletBalance;
  const canSubmitExternalWallet =
    isExternalEvmBridge &&
    Boolean(externalWalletAddress) &&
    hasEnoughExternalUsdc;
  const canSubmit =
    Boolean(destinationTokenAddress) &&
    Boolean(sourceTokenAddress) &&
    isPositiveDecimal(amount) &&
    !isSameChainRoute &&
    !isPasskeyUnsupportedSource &&
    isValidDestinationAddress(destinationAddress, destinationChain) &&
    (canSubmitAppWallet || canSubmitExternalWallet) &&
    !isTransferActive;

  const sourceChainOptions = isPasskeyWalletSession
    ? DESTINATION_OPTIONS.filter((opt) => opt.id === "ARC-TESTNET")
    : DESTINATION_OPTIONS;
  const destinationChainOptions = DESTINATION_OPTIONS;

  const canRetryExternalAttestation =
    isExternalBridgeTransfer &&
    Boolean(transfer?.txHashBurn) &&
    !isSubmitting &&
    (transfer?.rawStatus === "burned" ||
      transfer?.rawStatus === "attesting" ||
      transfer?.status === "failed");

  const isDestinationSolana = isSolanaChain(destinationChain);

  // ── Restore active transfer from localStorage ──────────────────────────────────
  useEffect(() => {
    if (restoredTransferRef.current) return;
    restoredTransferRef.current = true;

    const storedTransfer = getStoredActiveTransfer();
    if (!storedTransfer) return;

    const recoveredTransfer = recoverTerminalTransfer(storedTransfer);
    if (recoveredTransfer) {
      clearStoredActiveTransfer();
      return;
    }

    if (
      storedTransfer.status === "settled" ||
      storedTransfer.status === "failed"
    ) {
      clearStoredActiveTransfer();
      return;
    }

    const storedAgeMs =
      Date.now() - new Date(storedTransfer.createdAt).getTime();
    if (storedAgeMs > BRIDGE_STUCK_TIMEOUT_MS) {
      clearStoredActiveTransfer();
      return;
    }

    if (
      storedTransfer.transferId.startsWith("0x") ||
      storedTransfer.transferId.startsWith("ext-")
    ) {
      clearStoredActiveTransfer();
      return;
    }

    setTransfer(storedTransfer);
    setSourceChain(storedTransfer.sourceBlockchain);
    setDestinationChain(storedTransfer.blockchain);
    setAmount(storedTransfer.amount);
    setDestinationAddress(storedTransfer.destinationAddress || "");
  }, []);

  // ── Sync suggested destination address ────────────────────────────────────────
  useEffect(() => {
    if (isTransferActive) return;
    if (suggestedDestinationAddress) {
      setDestinationAddress(suggestedDestinationAddress);
      return;
    }
    setDestinationAddress("");
  }, [isTransferActive, suggestedDestinationAddress]);

  // ── Load source treasury wallet ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function loadTransferWallet() {
      setIsWalletLoading(true);
      setTransferWallet((current) =>
        current?.blockchain === sourceChain ? current : null
      );

      const stored = getStoredTransferWallet(sourceChain);

      try {
        const wallet = await getCircleTransferWallet({
          blockchain: sourceChain,
          tokenAddress: sourceTokenAddress,
          walletId: stored?.walletId || undefined,
          walletAddress: stored?.walletAddress || undefined,
        });

        if (cancelled) return;
        setTransferWallet(wallet);
        setStoredTransferWallet(sourceChain, wallet);
        setWalletStatusError(null);
      } catch (error) {
        if (cancelled) return;
        if (
          error instanceof TransferApiError &&
          (error.code === "CIRCLE_WALLET_NOT_FOUND" ||
            error.code === "CIRCLE_WALLET_CONFIG_MISSING" ||
            error.code === "CIRCLE_WALLET_CHAIN_MISMATCH" ||
            error.code === "CIRCLE_WALLET_ID_MISMATCH")
        ) {
          clearStoredTransferWallet(sourceChain);
        }
        setTransferWallet(null);
        setWalletStatusError(
          getBridgeErrorMessage(error, {
            destinationLabel: destinationOption.label,
            sourceLabel: sourceOption.label,
          })
        );
      } finally {
        if (!cancelled) setIsWalletLoading(false);
      }
    }

    void loadTransferWallet();
    return () => {
      cancelled = true;
    };
  }, [
    destinationOption.label,
    sourceChain,
    sourceOption.label,
    sourceTokenAddress,
  ]);

  // ── Persist active transfer ────────────────────────────────────────────────────
  useEffect(() => {
    if (!transfer) return;
    setStoredActiveTransfer(transfer);
  }, [transfer]);

  // ── Poll active transfer status ────────────────────────────────────────────────
  useEffect(() => {
    if (
      !transfer?.transferId ||
      !isTransferActive ||
      isExternalBridgeTransfer
    ) {
      setIsPollingTransfer(false);
      setIsReconnectingToTracking(false);
      return;
    }

    const activeTransferId = transfer.transferId;
    let cancelled = false;

    async function pollTransfer() {
      setIsPollingTransfer(true);
      try {
        const latest = await getCircleTransferStatus(activeTransferId);
        if (cancelled) return;

        setTransfer(latest);
        setStoredActiveTransfer(latest);
        reconnectingPollCountRef.current = 0;
        setIsReconnectingToTracking(false);
        setErrorMessage(null);
        handleTerminalTransferUpdate(latest);
      } catch (error) {
        if (cancelled) return;

        if (
          error instanceof TransferApiError &&
          error.code === "CIRCLE_BRIDGE_NOT_FOUND"
        ) {
          const recovered = recoverTerminalTransfer(transfer);
          if (recovered) {
            setTransfer(recovered);
            setIsReconnectingToTracking(false);
            setErrorMessage(null);
            handleTerminalTransferUpdate(recovered);
            return;
          }

          reconnectingPollCountRef.current += 1;
          if (reconnectingPollCountRef.current >= 15) {
            reconnectingPollCountRef.current = 0;
            clearStoredActiveTransfer();
            setTransfer(null);
            setIsReconnectingToTracking(false);
            setErrorMessage(
              "Bridge tracking timed out. The task no longer exists on backend."
            );
            return;
          }

          setIsReconnectingToTracking(true);
          setErrorMessage(
            "Bridge not yet detected on backend. Reconnecting to status tracking..."
          );
          return;
        }

        setIsReconnectingToTracking(false);
        setErrorMessage(
          getBridgeErrorMessage(error, {
            destinationLabel: destinationOption.label,
            sourceLabel: sourceOption.label,
          })
        );
      } finally {
        if (!cancelled) setIsPollingTransfer(false);
      }
    }

    pollTransferFnRef.current = pollTransfer;
    void pollTransfer();

    return () => {
      cancelled = true;
      pollTransferFnRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isTransferActive,
    transfer?.transferId,
    destinationOption.label,
    sourceOption.label,
  ]);

  useAdaptivePolling({
    onPoll: () => void pollTransferFnRef.current?.(),
    activeInterval: BRIDGE_POLL_INTERVAL_MS,
    idleInterval: 15_000,
    idleAfter: 60_000,
    enabled: Boolean(transfer?.transferId) && isTransferActive,
  });

  // ── Load initial destination wallets ──────────────────────────────────────────
  useEffect(() => {
    void refreshDestinationWallets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Terminal transfer handler ──────────────────────────────────────────────────
  function handleTerminalTransferUpdate(latest: CircleTransfer) {
    if (latest.status === "settled") {
      const key = `${latest.transferId}:settled`;
      if (terminalNoticeRef.current !== key) {
        terminalNoticeRef.current = key;
        setIsSuccessDialogOpen(true);
        clearStoredActiveTransfer();
        toast({
          title: "Bridge completed",
          description: `${tokenSymbol} arrived on ${getOptionByChain(latest.blockchain).label}.`,
        });
        void refreshTransferWallet();
      }
      return;
    }

    if (latest.status === "failed") {
      const key = `${latest.transferId}:failed`;
      if (terminalNoticeRef.current !== key) {
        terminalNoticeRef.current = key;
        clearStoredActiveTransfer();
        toast({
          title: "Bridge transfer failed",
          description:
            latest.errorReason ||
            `Circle could not finish the ${getOptionByChain(latest.sourceBlockchain).label} to ${getOptionByChain(latest.blockchain).label} bridge.`,
          variant: "destructive",
        });
        void refreshTransferWallet();
      }
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────────

  function dismissTransfer() {
    clearStoredActiveTransfer();
    setTransfer(null);
    setErrorMessage(null);
    setIsReconnectingToTracking(false);
    setIsSubmitting(false);
    setIsDepositingToTreasury(false);
    reconnectingPollCountRef.current = 0;
  }

  async function refreshTransferWallet() {
    setIsWalletLoading(true);
    setTransferWallet((current) =>
      current?.blockchain === sourceChain ? current : null
    );
    const stored = getStoredTransferWallet(sourceChain);
    try {
      const wallet = await getCircleTransferWallet({
        blockchain: sourceChain,
        tokenAddress: sourceTokenAddress,
        walletId: stored?.walletId || undefined,
        walletAddress: stored?.walletAddress || undefined,
      });
      setTransferWallet(wallet);
      setStoredTransferWallet(sourceChain, wallet);
      setWalletStatusError(null);
    } catch (error) {
      if (
        error instanceof TransferApiError &&
        (error.code === "CIRCLE_WALLET_NOT_FOUND" ||
          error.code === "CIRCLE_WALLET_CONFIG_MISSING" ||
          error.code === "CIRCLE_WALLET_CHAIN_MISMATCH" ||
          error.code === "CIRCLE_WALLET_ID_MISMATCH")
      ) {
        clearStoredTransferWallet(sourceChain);
      }
      setTransferWallet(null);
      setWalletStatusError(
        getBridgeErrorMessage(error, {
          destinationLabel: destinationOption.label,
          sourceLabel: sourceOption.label,
        })
      );
    } finally {
      setIsWalletLoading(false);
    }
  }

  const copyWalletAddress = useCallback(
    async (address: string, key: string) => {
      try {
        await navigator.clipboard.writeText(address);
        setCopiedWallet(key);
        window.setTimeout(() => setCopiedWallet(null), 2000);
      } catch {
        // clipboard not available
      }
    },
    []
  );

  const handleSavePasskeySolana = useCallback(() => {
    const trimmed = passkeySolanaInput.trim();
    if (!trimmed) return;
    savePasskeySolanaAddress(trimmed);
    setPasskeySolanaInput("");
  }, [passkeySolanaInput, savePasskeySolanaAddress]);

  async function refreshDestinationWallets() {
    setIsDestinationWalletsLoading(true);
    const chains = DESTINATION_OPTIONS.map((opt) => opt.id);
    try {
      const entries = await Promise.all(
        chains.map(async (chain) => {
          const tokenAddress = USDC_ADDRESS_BY_CHAIN[chain];
          if (!tokenAddress) return [chain, null] as const;
          const stored = getStoredTransferWallet(chain);
          try {
            const wallet = await getCircleTransferWallet({
              blockchain: chain,
              tokenAddress,
              walletId: stored?.walletId || undefined,
              walletAddress: stored?.walletAddress || undefined,
            });
            setStoredTransferWallet(chain, wallet);
            return [chain, wallet] as const;
          } catch {
            return [chain, null] as const;
          }
        })
      );
      const next: DestinationWalletMap = {};
      for (const [chain, wallet] of entries) {
        next[chain] = wallet;
      }
      setDestinationWallets(next);
    } finally {
      setIsDestinationWalletsLoading(false);
    }
  }

  async function handleBootstrapWallet() {
    setIsWalletBootstrapping(true);
    setWalletStatusError(null);
    try {
      const wallet = await bootstrapCircleTransferWallet({
        blockchain: sourceChain,
        tokenAddress: sourceTokenAddress,
        refId: `WIZPAY-BRIDGE-SOURCE-${sourceChain}-${Date.now()}`,
        walletName: `WizPay ${sourceOption.label} App Treasury Wallet`,
      });
      setTransferWallet(wallet);
      setStoredTransferWallet(sourceChain, wallet);
      void refreshDestinationWallets();
      setWalletStatusError(null);
      toast({
        title: "App treasury wallet ready",
        description: `Fund ${shortenAddress(wallet.walletAddress)} on ${sourceOption.label} with ${tokenSymbol} before bridging.`,
      });
    } catch (error) {
      const message = getBridgeErrorMessage(error, {
        destinationLabel: destinationOption.label,
        sourceLabel: sourceOption.label,
      });
      setWalletStatusError(message);
      toast({
        title: "Source wallet setup failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsWalletBootstrapping(false);
    }
  }

  function openBridgeReview() {
    if (isExternalBridgeMode) {
      if (externalBridgeModeMessage) {
        setErrorMessage(externalBridgeModeMessage);
        return;
      }
      if (isTransferActive) {
        setErrorMessage(
          "A bridge is already running. You can leave this page and come back later while tracking continues in the background."
        );
        return;
      }
      if (isSameChainRoute) {
        setErrorMessage("Source and destination network must be different.");
        return;
      }
      if (
        !isPositiveDecimal(amount) ||
        !isValidDestinationAddress(destinationAddress, destinationChain)
      ) {
        setErrorMessage(
          "Enter a valid amount and destination address before starting the bridge."
        );
        return;
      }
      setErrorMessage(null);
      setIsReviewDialogOpen(true);
      return;
    }

    if (isTransferActive) {
      setErrorMessage(
        "A bridge is already running. You can leave this page and come back later while tracking continues in the background."
      );
      return;
    }

    if (isPasskeyUnsupportedSource) {
      setErrorMessage(passkeySourceRestrictionMessage);
      return;
    }

    if (!transferWallet) {
      setErrorMessage(getTreasurySetupMessage(sourceOption.label));
      return;
    }

    if (transferWallet.blockchain !== sourceChain) {
      setErrorMessage(
        `The displayed source treasury wallet does not match ${sourceOption.label}. Refresh the treasury wallet and try again.`
      );
      return;
    }

    if (!hasSufficientWalletBalance) {
      setErrorMessage(
        getTreasuryFundingMessage({
          networkLabel: sourceOption.label,
          availableAmount: transferWallet.balance?.amount || "0",
          symbol: transferWallet.balance?.symbol || tokenSymbol,
          walletAddress: transferWallet.walletAddress,
          requestedAmount: amount,
        })
      );
      return;
    }

    if (isSameChainRoute) {
      setErrorMessage("Source and destination network must be different.");
      return;
    }

    if (!canSubmit) {
      setErrorMessage(
        "Enter a valid amount and destination wallet before starting the bridge."
      );
      return;
    }

    setErrorMessage(null);
    setIsReviewDialogOpen(true);
  }

  function hasEnoughPersonalUsdc(
    reportedAmount: string,
    requestedAmount: string
  ) {
    const requestedUnits = parseUnits(requestedAmount, CCTP_USDC_DECIMALS);
    const trimmed = reportedAmount.trim();

    if (/^\d+$/.test(trimmed)) {
      const asBaseUnits = BigInt(trimmed) >= requestedUnits;
      const asHumanUnits =
        parseUnits(trimmed, CCTP_USDC_DECIMALS) >= requestedUnits;
      return asBaseUnits || asHumanUnits;
    }

    try {
      return parseUnits(trimmed, CCTP_USDC_DECIMALS) >= requestedUnits;
    } catch {
      return Number(trimmed) >= Number(requestedAmount);
    }
  }

  // ── submitBridge ───────────────────────────────────────────────────────────────
  async function submitBridge() {
    // ── Passkey flow ─────────────────────────────────────────────────────────────
    if (isPasskeyWalletSession) {
      if (isPasskeyUnsupportedSource) {
        setErrorMessage(passkeySourceRestrictionMessage);
        setIsReviewDialogOpen(false);
        return;
      }

      if (!transferWallet) {
        setErrorMessage(getTreasurySetupMessage(sourceOption.label));
        setIsReviewDialogOpen(false);
        return;
      }
      if (transferWallet.blockchain !== sourceChain) {
        setErrorMessage(
          `The displayed source treasury wallet does not match ${sourceOption.label}. Refresh and try again.`
        );
        setIsReviewDialogOpen(false);
        return;
      }

      setIsSubmitting(true);
      setErrorMessage(null);
      setIsReviewDialogOpen(false);
      setIsSuccessDialogOpen(false);
      reconnectingPollCountRef.current = 0;
      setIsReconnectingToTracking(false);

      try {
        const referenceId = `BRIDGE-${sourceChain}-TO-${destinationChain}-${Date.now()}`;
        const userSourceWallet =
          sourceChain === "ARC-TESTNET" ? arcWallet : solanaWallet;

        if (!userSourceWallet?.id) {
          throw new Error(
            `Personal ${sourceOption.label} wallet not connected.`
          );
        }

        const balances = await getWalletBalances(userSourceWallet.id);
        const usdcBalance = balances.find(
          (b) =>
            b.symbol === "USDC" ||
            b.tokenAddress?.toLowerCase() === sourceTokenAddress?.toLowerCase()
        );

        if (!usdcBalance) {
          throw new Error(
            `Could not find USDC token in your personal ${sourceOption.label} wallet.`
          );
        }

        if (!hasEnoughPersonalUsdc(usdcBalance.amount, amount)) {
          throw new Error(
            `Insufficient personal wallet balance on ${sourceOption.label}. Available: ${usdcBalance.amount} USDC, required: ${amount} USDC. Fund your personal Circle wallet (not treasury wallet) and retry.`
          );
        }

        if (!sourceTokenAddress) {
          throw new Error(
            `USDC address is not configured for ${sourceOption.label}.`
          );
        }

        toast({
          title: "Step 1: Deposit",
          description: `Approve the transfer of ${amount} USDC from your ${sourceOption.label} wallet to the treasury wallet using passkey.`,
        });

        setIsDepositingToTreasury(true);

        const passkeyTransferCallData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [
            transferWallet.walletAddress as Address,
            parseUnits(amount.toString(), CCTP_USDC_DECIMALS),
          ],
        });

        const challenge = await createContractExecutionChallenge({
          walletId: userSourceWallet.id,
          contractAddress: sourceTokenAddress,
          callData: passkeyTransferCallData,
          refId: `PASSKEY-DEPOSIT-${referenceId}`,
        });

        await executeChallenge(challenge.challengeId);

        toast({
          title: "Step 2: Bridge",
          description:
            "Deposit confirmed. Executing bridge from the funded treasury wallet...",
        });

        await new Promise((resolve) => setTimeout(resolve, 2500));
        setIsDepositingToTreasury(false);

        const queuedTransfer = await createCircleTransfer({
          amount,
          blockchain: destinationChain,
          sourceBlockchain: sourceChain,
          bridgeExecutionMode: "app_treasury",
          sourceAccountType: "app_treasury_wallet",
          destinationAddress,
          referenceId,
          tokenAddress: destinationTokenAddress,
          walletId: transferWallet.walletId || undefined,
          walletAddress: transferWallet.walletAddress,
          userEmail: userEmail || undefined,
          walletMode: "W3S",
        });

        terminalNoticeRef.current = null;
        setTransfer(queuedTransfer);
        setStoredActiveTransfer(queuedTransfer);
        setSourceChain(queuedTransfer.sourceBlockchain);
        setDestinationChain(queuedTransfer.blockchain);
        setAmount(queuedTransfer.amount);
        setDestinationAddress(
          queuedTransfer.destinationAddress || destinationAddress
        );
        toast({
          title: "Bridge started",
          description: `Passkey bridge started. Estimated time ${estimatedTimeLabel}.`,
        });
      } catch (error) {
        const message = getBridgeErrorMessage(error, {
          destinationLabel: destinationOption.label,
          sourceLabel: sourceOption.label,
        });
        setErrorMessage(message);
        toast({
          title: "Bridge transfer failed",
          description: message,
          variant: "destructive",
        });
      } finally {
        setIsSubmitting(false);
        setIsDepositingToTreasury(false);
      }

      return;
    }

    // ── External EVM wallet flow ──────────────────────────────────────────────────
    if (isExternalEvmBridge) {
      await submitExternalBridge(
        {
          sourceChain,
          destinationChain,
          amount,
          destinationAddress,
          sourceTokenAddress,
          sourceOption,
          destinationOption,
          externalWalletClient,
          externalWalletAddress: externalWalletAddress as Address | undefined,
          externalWalletChainId,
          sourcePublicClient,
          destPublicClient,
          switchChainAsync,
          setTransfer,
          setIsSubmitting,
          setErrorMessage,
          setIsReviewDialogOpen,
          setIsSuccessDialogOpen,
          toast,
          tokenSymbol,
          transfer,
        },
        clearStoredActiveTransfer
      );
      return;
    }

    if (isExternalBridgeMode) {
      setErrorMessage(
        externalBridgeModeMessage ??
          "External wallet bridge is not available for the selected route."
      );
      setIsReviewDialogOpen(false);
      return;
    }

    // ── W3S (Google / Email) flow ─────────────────────────────────────────────────
    if (!transferWallet) {
      setErrorMessage(getTreasurySetupMessage(sourceOption.label));
      setIsReviewDialogOpen(false);
      return;
    }

    if (transferWallet.blockchain !== sourceChain) {
      setErrorMessage(
        `The displayed source treasury wallet does not match ${sourceOption.label}. Refresh and try again.`
      );
      setIsReviewDialogOpen(false);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setIsReviewDialogOpen(false);
    setIsSuccessDialogOpen(false);
    reconnectingPollCountRef.current = 0;
    setIsReconnectingToTracking(false);

    try {
      const referenceId = `BRIDGE-${sourceChain}-TO-${destinationChain}-${Date.now()}`;

      const userSourceWallet =
        sourceChain === "ARC-TESTNET"
          ? arcWallet
          : sourceChain === "ETH-SEPOLIA"
            ? sepoliaWallet
            : solanaWallet;

      if (!userSourceWallet?.id) {
        throw new Error(`Personal ${sourceOption.label} wallet not connected.`);
      }

      const balances = await getWalletBalances(userSourceWallet.id);
      const usdcBalance = balances.find(
        (b) =>
          b.symbol === "USDC" ||
          b.tokenAddress?.toLowerCase() === sourceTokenAddress?.toLowerCase()
      );

      if (!usdcBalance) {
        throw new Error(
          `Could not find USDC token in your personal ${sourceOption.label} wallet. Available tokens: ${balances.map((b) => `${b.symbol}=${b.tokenAddress}`).join(", ")}`
        );
      }

      if (!usdcBalance.tokenId) {
        throw new Error(
          `USDC tokenId for ${sourceOption.label} is missing. Refresh wallet balances and retry.`
        );
      }

      if (!hasEnoughPersonalUsdc(usdcBalance.amount, amount)) {
        throw new Error(
          `Insufficient personal wallet balance on ${sourceOption.label}. Available: ${usdcBalance.amount} USDC, required: ${amount} USDC. Fund your personal Circle wallet (not treasury wallet) and retry.`
        );
      }

      toast({
        title: "Step 1: Deposit",
        description: `Approve the transfer of ${amount} USDC from your ${sourceOption.label} wallet to the treasury wallet via Circle popup.`,
      });

      setIsDepositingToTreasury(true);

      const transferChallenge = await createTransferChallenge({
        walletId: userSourceWallet.id,
        destinationAddress: transferWallet.walletAddress,
        tokenId: usdcBalance.tokenId,
        amounts: [amount.toString()],
        feeLevel: "HIGH",
        refId: `W3S-DEPOSIT-${referenceId}`,
      });

      await executeChallenge(transferChallenge.challengeId);

      toast({
        title: "Step 2: Bridge",
        description:
          "Deposit confirmed. Executing bridge from the funded treasury wallet...",
      });

      await new Promise((resolve) => setTimeout(resolve, 2500));
      setIsDepositingToTreasury(false);

      const queuedTransfer = await createCircleTransfer({
        amount,
        blockchain: destinationChain,
        sourceBlockchain: sourceChain,
        bridgeExecutionMode,
        sourceAccountType,
        destinationAddress,
        referenceId,
        tokenAddress: destinationTokenAddress,
        walletId: transferWallet.walletId || undefined,
        walletAddress: transferWallet.walletAddress,
        userEmail: userEmail || undefined,
        walletMode: "W3S",
      });

      terminalNoticeRef.current = null;
      setTransfer(queuedTransfer);
      setStoredActiveTransfer(queuedTransfer);
      setSourceChain(queuedTransfer.sourceBlockchain);
      setDestinationChain(queuedTransfer.blockchain);
      setAmount(queuedTransfer.amount);
      setDestinationAddress(
        queuedTransfer.destinationAddress || destinationAddress
      );
      toast({
        title: "Bridge started",
        description: `Estimated time ${estimatedTimeLabel}. You can leave this page and come back later while Circle finishes the bridge.`,
      });
    } catch (error) {
      const message = getBridgeErrorMessage(error, {
        destinationLabel: destinationOption.label,
        sourceLabel: sourceOption.label,
      });
      setErrorMessage(message);
      toast({
        title: "Bridge transfer failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
      setIsDepositingToTreasury(false);
    }
  }

  // ── Chain change handlers ──────────────────────────────────────────────────────
  const handleSourceChainChange = useCallback(
    (value: string) => {
      const newSource = value as CircleTransferBlockchain;
      if (newSource === destinationChain) {
        const fallback = getDefaultDestinationBlockchain(newSource);
        setDestinationChain(fallback);
        if (isSolanaChain(fallback) !== isSolanaChain(destinationChain)) {
          setDestinationAddress("");
        }
      }
      setSourceChain(newSource);
    },
    [destinationChain]
  );

  const handleDestinationChainChange = useCallback(
    (value: string) => {
      const newDest = value as CircleTransferBlockchain;
      if (newDest === sourceChain) return;
      if (isSolanaChain(newDest) !== isSolanaChain(destinationChain)) {
        setDestinationAddress("");
      }
      setDestinationChain(newDest);
    },
    [sourceChain, destinationChain]
  );

  // ── Composite action handlers ──────────────────────────────────────────────────
  const retryAttestation = useCallback(() => {
    void retryExternalAttestationAndMint({
      sourceChain,
      destinationChain,
      amount,
      destinationAddress,
      sourceTokenAddress,
      sourceOption,
      destinationOption,
      externalWalletClient,
      externalWalletAddress: externalWalletAddress as Address | undefined,
      externalWalletChainId,
      sourcePublicClient,
      destPublicClient,
      switchChainAsync,
      setTransfer,
      setIsSubmitting,
      setErrorMessage,
      setIsReviewDialogOpen,
      setIsSuccessDialogOpen,
      toast,
      tokenSymbol,
      transfer,
    });
  }, [
    amount,
    destinationAddress,
    destinationChain,
    destinationOption,
    destPublicClient,
    externalWalletAddress,
    externalWalletChainId,
    externalWalletClient,
    setIsReviewDialogOpen,
    setIsSuccessDialogOpen,
    sourceChain,
    sourceOption,
    sourcePublicClient,
    sourceTokenAddress,
    switchChainAsync,
    toast,
    tokenSymbol,
    transfer,
  ]);

  const handleStartNew = useCallback(() => {
    setIsSuccessDialogOpen(false);
    clearStoredActiveTransfer();
    setTransfer(null);
    setAmount("");
    setDestinationAddress("");
    setErrorMessage(null);
    reconnectingPollCountRef.current = 0;
    setIsReconnectingToTracking(false);
    terminalNoticeRef.current = null;
  }, []);

  return {
    // ── State ──────────────────────────────────────────────────────────────────
    sourceChain,
    destinationChain,
    amount,
    setAmount,
    destinationAddress,
    setDestinationAddress,
    transfer,
    transferWallet,
    errorMessage,
    walletStatusError,
    isSubmitting,
    isWalletLoading,
    isWalletBootstrapping,
    isPollingTransfer,
    isReconnectingToTracking,
    isReviewDialogOpen,
    setIsReviewDialogOpen,
    isSuccessDialogOpen,
    setIsSuccessDialogOpen,
    destinationWallets,
    isDestinationWalletsLoading,
    copiedWallet,
    passkeySolanaInput,
    setPasskeySolanaInput,
    // ── Derived ────────────────────────────────────────────────────────────────
    tokenSymbol,
    sourceOption,
    destinationOption,
    isSameChainRoute,
    isPasskeyWalletSession,
    isPasskeyUnsupportedSource,
    passkeySourceRestrictionMessage,
    isExternalBridgeMode,
    isExternalEvmBridge,
    externalBridgeModeMessage,
    externalUsdcBalanceLabel,
    hasEnoughExternalUsdc,
    treasuryWalletEmpty,
    hasSufficientWalletBalance,
    isTransferActive,
    estimatedTimeLabel,
    sourceChainOptions,
    destinationChainOptions,
    canRetryExternalAttestation,
    isDestinationSolana,
    externalWalletAddress,
    externalWalletChainId,
    sourceChainId,
    arcWalletAddress: arcWallet?.address,
    sepoliaWalletAddress: sepoliaWallet?.address,
    solanaWalletAddress: solanaWallet?.address,
    // ── Handlers ───────────────────────────────────────────────────────────────
    handleSourceChainChange,
    handleDestinationChainChange,
    dismissTransfer,
    refreshTransferWallet,
    copyWalletAddress,
    handleSavePasskeySolana,
    refreshDestinationWallets,
    handleBootstrapWallet,
    openBridgeReview,
    submitBridge,
    retryAttestation,
    handleStartNew,
  };
}
