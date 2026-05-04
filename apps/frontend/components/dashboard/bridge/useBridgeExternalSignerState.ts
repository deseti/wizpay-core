"use client";

import { useCallback } from "react";

import { formatUnits } from "viem";
import type { Address } from "viem";
import {
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWalletClient,
} from "wagmi";

import { useHybridWallet } from "@/components/providers/HybridWalletProvider";
import { useSolanaWallet } from "@/components/providers/SolanaWalletProvider";
import { ERC20_ABI } from "@/constants/erc20";
import { CCTP_USDC_DECIMALS, CHAIN_ID_BY_BRIDGE_CHAIN } from "@/lib/cctp";
import type {
  CircleTransfer,
  CircleTransferBlockchain,
} from "@/lib/transfer-service";

import { BRIDGE_EXTERNAL_ENABLED } from "./bridge-types";
import { isPositiveDecimal, isSolanaChain } from "./bridge-utils";
import {
  classifyExternalBridgeRoute,
  getRequiredExternalWalletLabels,
  isExternalCrossChainRoute,
  type ExternalBridgeRouteKind,
} from "./external/externalBridgeRoute";
import {
  retryExternalAttestationAndMint,
  submitExternalBridge,
} from "./useExternalBridge";

interface BridgeOption {
  id: CircleTransferBlockchain;
  label: string;
}

interface ToastArgs {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}

interface UseBridgeExternalSignerStateParams {
  sourceChain: CircleTransferBlockchain;
  destinationChain: CircleTransferBlockchain;
  amount: string;
  destinationAddress: string;
  sourceTokenAddress: string | undefined;
  sourceOption: BridgeOption;
  destinationOption: BridgeOption;
  transfer: CircleTransfer | null;
  tokenSymbol: string;
  setTransfer: React.Dispatch<React.SetStateAction<CircleTransfer | null>>;
  setIsSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setErrorMessage: React.Dispatch<React.SetStateAction<string | null>>;
  setIsReviewDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsSuccessDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toast: (args: ToastArgs) => void;
}

interface UseBridgeExternalSignerStateResult {
  bridgeExecutionMode: "external_signer" | "app_treasury";
  sourceAccountType: "external_wallet" | "app_treasury_wallet";
  isExternalBridgeMode: boolean;
  isExternalEvmBridge: boolean;
  isExternalCrossChainBridge: boolean;
  externalBridgeRouteKind: ExternalBridgeRouteKind;
  externalBridgeModeMessage: string | null;
  externalWalletAddress: string | undefined;
  externalWalletChainId: number | undefined;
  externalSolanaWalletAddress: string | null;
  availableSolanaWallets: ReadonlyArray<{ id: string; label: string }>;
  selectedSolanaWalletId: string | null;
  selectedSolanaWalletLabel: string | null;
  requiredExternalWalletLabels: readonly string[];
  hasRequiredExternalWallets: boolean;
  sourceChainId: number | undefined;
  externalUsdcBalanceLabel: string;
  hasEnoughExternalUsdc: boolean;
  retryAttestation: () => void;
  selectSolanaWallet: (walletId: string) => void;
  connectSolanaWallet: () => Promise<string>;
  submitExternalBridgeFlow: (
    clearStoredActiveTransfer: () => void
  ) => Promise<void>;
}

export function useBridgeExternalSignerState({
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
}: UseBridgeExternalSignerStateParams): UseBridgeExternalSignerStateResult {
  const { walletMode, externalWalletAddress, externalWalletChainId } =
    useHybridWallet();
  const {
    availableWallets: availableSolanaWallets,
    connect: connectSolanaWallet,
    provider: solanaWalletProvider,
    publicKeyBase58: externalSolanaWalletAddress,
    selectWallet: selectSolanaWallet,
    selectedWalletId: selectedSolanaWalletId,
    selectedWalletLabel: selectedSolanaWalletLabel,
  } = useSolanaWallet();
  const { data: externalWalletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();

  const bridgeExecutionMode: "external_signer" | "app_treasury" =
    walletMode === "external" ? "external_signer" : "app_treasury";
  const sourceAccountType: "external_wallet" | "app_treasury_wallet" =
    bridgeExecutionMode === "external_signer"
      ? "external_wallet"
      : "app_treasury_wallet";
  const isExternalBridgeMode = bridgeExecutionMode === "external_signer";
  const externalBridgeRouteKind = classifyExternalBridgeRoute(
    sourceChain,
    destinationChain
  );
  const isExternalEvmBridge =
    isExternalBridgeMode &&
    BRIDGE_EXTERNAL_ENABLED &&
    externalBridgeRouteKind === "evm-to-evm";
  const isExternalCrossChainBridge =
    isExternalBridgeMode &&
    BRIDGE_EXTERNAL_ENABLED &&
    isExternalCrossChainRoute(externalBridgeRouteKind);
  const requiredExternalWalletLabels = getRequiredExternalWalletLabels(
    externalBridgeRouteKind
  );
  const sourceChainId = CHAIN_ID_BY_BRIDGE_CHAIN[sourceChain];
  const destChainId = CHAIN_ID_BY_BRIDGE_CHAIN[destinationChain];
  const sourcePublicClient = usePublicClient({ chainId: sourceChainId });
  const destPublicClient = usePublicClient({ chainId: destChainId });
  const hasRequiredExternalWallets =
    externalBridgeRouteKind === "evm-to-evm"
      ? Boolean(externalWalletAddress)
      : externalBridgeRouteKind === "solana-to-solana"
        ? Boolean(externalSolanaWalletAddress)
        : Boolean(externalWalletAddress && externalSolanaWalletAddress);
  const externalBridgeModeMessage = !BRIDGE_EXTERNAL_ENABLED
    ? `External wallet bridge is currently disabled. Switch to App Wallet (Circle) to continue.`
    : externalBridgeRouteKind === "solana-to-solana"
      ? `External wallet bridge does not support Solana to Solana routes yet. Choose an EVM route or switch to App Wallet mode.`
      : externalBridgeRouteKind === "evm-to-evm" && !externalWalletAddress
        ? `Connect an EVM wallet to continue with the external bridge.`
        : externalBridgeRouteKind === "evm-to-solana" && !externalWalletAddress
          ? `Connect an EVM wallet for the source network and a Solana wallet for the destination network before starting this bridge.`
          : externalBridgeRouteKind === "evm-to-solana" && !externalSolanaWalletAddress
            ? `Connect a Solana wallet to receive the destination-side mint on Solana.`
            : externalBridgeRouteKind === "solana-to-evm" && !externalSolanaWalletAddress
              ? `Connect a Solana wallet for the source network and an EVM wallet for the destination network before starting this bridge.`
              : externalBridgeRouteKind === "solana-to-evm" && !externalWalletAddress
                ? `Connect an EVM wallet to receive the destination-side mint on the EVM network.`
      : null;

  const externalUsdcAddress = isExternalBridgeMode && !isSolanaChain(sourceChain)
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
        isExternalBridgeMode &&
          !isSolanaChain(sourceChain) &&
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
    isSolanaChain(sourceChain)
      ? externalSolanaWalletAddress
        ? `Checked in ${selectedSolanaWalletLabel ?? "your Solana wallet"} at confirmation time`
        : "Connect a Solana wallet"
      : externalUsdcBalance !== null
      ? `${externalUsdcBalance.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`
      : "Loading...";
  const hasEnoughExternalUsdc =
    isSolanaChain(sourceChain)
      ? true
      : externalUsdcBalance === null ||
          !isPositiveDecimal(amount) ||
          externalUsdcBalance >= Number(amount);

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
      solanaWalletProvider,
      solanaWalletAddress: externalSolanaWalletAddress,
      connectSolanaWallet,
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
    solanaWalletProvider,
    externalSolanaWalletAddress,
    connectSolanaWallet,
    setErrorMessage,
    setIsReviewDialogOpen,
    setIsSubmitting,
    setIsSuccessDialogOpen,
    setTransfer,
    sourceChain,
    sourceOption,
    sourcePublicClient,
    sourceTokenAddress,
    switchChainAsync,
    toast,
    tokenSymbol,
    transfer,
  ]);

  const submitExternalBridgeFlow = useCallback(
    async (clearStoredActiveTransfer: () => void) => {
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
          solanaWalletProvider,
          solanaWalletAddress: externalSolanaWalletAddress,
          connectSolanaWallet,
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
    },
    [
      amount,
      destinationAddress,
      destinationChain,
      destinationOption,
      destPublicClient,
      externalWalletAddress,
      externalWalletChainId,
      externalWalletClient,
      solanaWalletProvider,
      externalSolanaWalletAddress,
      connectSolanaWallet,
      setErrorMessage,
      setIsReviewDialogOpen,
      setIsSubmitting,
      setIsSuccessDialogOpen,
      setTransfer,
      sourceChain,
      sourceOption,
      sourcePublicClient,
      sourceTokenAddress,
      switchChainAsync,
      toast,
      tokenSymbol,
      transfer,
    ]
  );

  return {
    bridgeExecutionMode,
    sourceAccountType,
    isExternalBridgeMode,
    isExternalEvmBridge,
    isExternalCrossChainBridge,
    externalBridgeRouteKind,
    externalBridgeModeMessage,
    externalWalletAddress,
    externalWalletChainId,
    externalSolanaWalletAddress,
    availableSolanaWallets,
    selectedSolanaWalletId,
    selectedSolanaWalletLabel,
    requiredExternalWalletLabels,
    hasRequiredExternalWallets,
    sourceChainId,
    externalUsdcBalanceLabel,
    hasEnoughExternalUsdc,
    retryAttestation,
    selectSolanaWallet,
    connectSolanaWallet,
    submitExternalBridgeFlow,
  };
}