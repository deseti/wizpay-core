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
import { ERC20_ABI } from "@/constants/erc20";
import { CCTP_USDC_DECIMALS, CHAIN_ID_BY_BRIDGE_CHAIN } from "@/lib/cctp";
import type {
  CircleTransfer,
  CircleTransferBlockchain,
} from "@/lib/transfer-service";

import { BRIDGE_EXTERNAL_ENABLED } from "./bridge-types";
import { isPositiveDecimal, isSolanaChain } from "./bridge-utils";
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
  externalBridgeModeMessage: string | null;
  externalWalletAddress: string | undefined;
  externalWalletChainId: number | undefined;
  sourceChainId: number | undefined;
  externalUsdcBalanceLabel: string;
  hasEnoughExternalUsdc: boolean;
  retryAttestation: () => void;
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
  const { data: externalWalletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();

  const bridgeExecutionMode: "external_signer" | "app_treasury" =
    walletMode === "external" ? "external_signer" : "app_treasury";
  const sourceAccountType: "external_wallet" | "app_treasury_wallet" =
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
    externalBridgeModeMessage,
    externalWalletAddress,
    externalWalletChainId,
    sourceChainId,
    externalUsdcBalanceLabel,
    hasEnoughExternalUsdc,
    retryAttestation,
    submitExternalBridgeFlow,
  };
}