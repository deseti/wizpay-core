"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { encodeFunctionData, parseUnits } from "viem";
import type { Address } from "viem";

import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { useToast } from "@/hooks/use-toast";
import { useDialogState } from "@/hooks/useDialogState";
import {
  createCircleTransfer,
  type CircleTransfer,
} from "@/lib/transfer-service";
import { CCTP_USDC_DECIMALS } from "@/lib/cctp";
import { ERC20_ABI } from "@/constants/erc20";

import {
  BRIDGE_ASSET_SYMBOL,
} from "./bridge-types";
import { clearStoredActiveTransfer } from "./bridge-storage";
import {
  getBridgeErrorMessage,
  getEstimatedBridgeTimeLabel,
  getOptionByChain,
  getTreasuryFundingMessage,
  getTreasurySetupMessage,
  isPositiveDecimal,
  isTrackedTransfer,
  isValidDestinationAddress,
} from "./bridge-utils";
import { useBridgeFormState } from "./useBridgeFormState";
import { useBridgeExternalSignerState } from "./useBridgeExternalSignerState";
import { useBridgeTransferLifecycle } from "./useBridgeTransferLifecycle";
import { useBridgeWalletState } from "./useBridgeWalletState";

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
  const { toast } = useToast();

  // ── Refs ───────────────────────────────────────────────────────────────────────
  const terminalNoticeRef = useRef<string | null>(null);

  // ── Transfer / UI state ────────────────────────────────────────────────────────
  const [transfer, setTransfer] = useState<CircleTransfer | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [, setIsDepositingToTreasury] = useState(false);
  const { isOpen: isReviewDialogOpen, setIsOpen: setIsReviewDialogOpen } =
    useDialogState();
  const { isOpen: isSuccessDialogOpen, setIsOpen: setIsSuccessDialogOpen } =
    useDialogState();

  const tokenSymbol = BRIDGE_ASSET_SYMBOL;
  const isTransferActive = isTrackedTransfer(transfer);

  const {
    sourceChain,
    setSourceChain,
    destinationChain,
    setDestinationChain,
    amount,
    setAmount,
    destinationAddress,
    setDestinationAddress,
    passkeySolanaInput,
    setPasskeySolanaInput,
    sourceOption,
    destinationOption,
    sourceTokenAddress,
    destinationTokenAddress,
    isSameChainRoute,
    isPasskeyWalletSession,
    isPasskeyUnsupportedSource,
    passkeySourceRestrictionMessage,
    sourceChainOptions,
    destinationChainOptions,
    isDestinationSolana,
    handleSourceChainChange,
    handleDestinationChainChange,
  } = useBridgeFormState({
    authMethod,
    arcWalletAddress: arcWallet?.address,
    sepoliaWalletAddress: sepoliaWallet?.address,
    solanaWalletAddress: solanaWallet?.address,
    isTransferActive,
  });
  const {
    transferWallet,
    walletStatusError,
    isWalletLoading,
    isWalletBootstrapping,
    destinationWallets,
    isDestinationWalletsLoading,
    copiedWallet,
    refreshTransferWallet,
    refreshDestinationWallets,
    copyWalletAddress,
    handleBootstrapWallet,
  } = useBridgeWalletState({
    sourceChain,
    sourceTokenAddress,
    sourceLabel: sourceOption.label,
    destinationLabel: destinationOption.label,
    tokenSymbol,
    toast,
  });
  const {
    bridgeExecutionMode,
    sourceAccountType,
    isExternalBridgeMode,
    isExternalEvmBridge,
    externalBridgeModeMessage,
    externalWalletAddress,
    externalWalletChainId,
    sourceChainId,
    externalUsdcBalanceLabel,
    hasEnoughExternalUsdc,
    retryAttestation,
    submitExternalBridgeFlow,
  } = useBridgeExternalSignerState({
    sourceChain,
    destinationChain,
    amount,
    destinationAddress,
    sourceTokenAddress,
    sourceOption,
    destinationOption,
    transfer,
    tokenSymbol,
    setTransfer,
    setIsSubmitting,
    setErrorMessage,
    setIsReviewDialogOpen,
    setIsSuccessDialogOpen,
    toast,
  });

  // ── Terminal transfer handler ──────────────────────────────────────────────────
  const handleTerminalTransferUpdate = useCallback(
    (latest: CircleTransfer) => {
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
    },
    [refreshTransferWallet, setIsSuccessDialogOpen, toast, tokenSymbol]
  );
  const {
    isPollingTransfer,
    isReconnectingToTracking,
    isExternalBridgeTransfer,
    clearTransferTracking,
    resetTransferTrackingState,
    syncTrackedTransfer,
  } = useBridgeTransferLifecycle({
    transfer,
    setTransfer,
    sourceLabel: sourceOption.label,
    destinationLabel: destinationOption.label,
    setSourceChain,
    setDestinationChain,
    setAmount,
    setDestinationAddress,
    setErrorMessage,
    onTerminalTransferUpdate: handleTerminalTransferUpdate,
  });

  // ── Derived values ─────────────────────────────────────────────────────────────
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

  const canRetryExternalAttestation =
    isExternalBridgeTransfer &&
    Boolean(transfer?.txHashBurn) &&
    !isSubmitting &&
    (transfer?.rawStatus === "burned" ||
      transfer?.rawStatus === "attesting" ||
      transfer?.status === "failed");

  // ── Actions ────────────────────────────────────────────────────────────────────

  function dismissTransfer() {
    clearTransferTracking();
    setErrorMessage(null);
    setIsSubmitting(false);
    setIsDepositingToTreasury(false);
  }

  const handleSavePasskeySolana = useCallback(() => {
    const trimmed = passkeySolanaInput.trim();
    if (!trimmed) return;
    savePasskeySolanaAddress(trimmed);
    setPasskeySolanaInput("");
  }, [passkeySolanaInput, savePasskeySolanaAddress, setPasskeySolanaInput]);


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
      resetTransferTrackingState();

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
        syncTrackedTransfer(queuedTransfer, destinationAddress);
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
      await submitExternalBridgeFlow(clearStoredActiveTransfer);
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
    resetTransferTrackingState();

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
      syncTrackedTransfer(queuedTransfer, destinationAddress);
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

  const handleStartNew = useCallback(() => {
    setIsSuccessDialogOpen(false);
    clearTransferTracking();
    setAmount("");
    setDestinationAddress("");
    setErrorMessage(null);
    terminalNoticeRef.current = null;
  }, [
    clearTransferTracking,
    setAmount,
    setDestinationAddress,
    setIsSuccessDialogOpen,
  ]);

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
