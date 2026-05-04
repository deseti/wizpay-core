"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { CircleTransferBlockchain } from "@/lib/transfer-service";

import {
  DEFAULT_SOURCE_BLOCKCHAIN,
  DESTINATION_OPTIONS,
  USDC_ADDRESS_BY_CHAIN,
} from "./bridge-types";
import {
  getDefaultDestinationBlockchain,
  getOptionByChain,
  isSolanaChain,
} from "./bridge-utils";

interface UseBridgeFormStateParams {
  authMethod: string | null | undefined;
  arcWalletAddress?: string | null;
  sepoliaWalletAddress?: string | null;
  solanaWalletAddress?: string | null;
  isTransferActive: boolean;
}

export function useBridgeFormState({
  authMethod,
  arcWalletAddress,
  sepoliaWalletAddress,
  solanaWalletAddress,
  isTransferActive,
}: UseBridgeFormStateParams) {
  const initialSourceBlockchain: CircleTransferBlockchain =
    authMethod === "passkey" ? "ARC-TESTNET" : DEFAULT_SOURCE_BLOCKCHAIN;

  const [sourceChain, setSourceChain] = useState<CircleTransferBlockchain>(
    initialSourceBlockchain
  );
  const [destinationChain, setDestinationChain] =
    useState<CircleTransferBlockchain>(
      getDefaultDestinationBlockchain(initialSourceBlockchain)
    );
  const [amount, setAmount] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [passkeySolanaInput, setPasskeySolanaInput] = useState("");

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
      ? (arcWalletAddress ?? "")
      : destinationChain === "ETH-SEPOLIA"
        ? (sepoliaWalletAddress ?? "")
        : (solanaWalletAddress ?? "");

  const sourceTokenAddress = USDC_ADDRESS_BY_CHAIN[sourceChain];
  const destinationTokenAddress = USDC_ADDRESS_BY_CHAIN[destinationChain];
  const isSameChainRoute = sourceChain === destinationChain;
  const isPasskeyWalletSession = authMethod === "passkey";
  const isPasskeyUnsupportedSource =
    isPasskeyWalletSession &&
    (sourceChain === "SOLANA-DEVNET" || sourceChain === "ETH-SEPOLIA");
  const passkeySourceRestrictionMessage =
    "Passkey wallet can only use Arc as source. Use Google login, Email, OTP, or External Wallet (MetaMask) for Solana and Ethereum Sepolia source.";
  const sourceChainOptions = isPasskeyWalletSession
    ? DESTINATION_OPTIONS.filter((opt) => opt.id === "ARC-TESTNET")
    : DESTINATION_OPTIONS;
  const destinationChainOptions = DESTINATION_OPTIONS;
  const isDestinationSolana = isSolanaChain(destinationChain);

  useEffect(() => {
    if (isTransferActive) return;
    if (suggestedDestinationAddress) {
      // When the form is idle, mirror the currently suggested destination.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDestinationAddress(suggestedDestinationAddress);
      return;
    }
    setDestinationAddress("");
  }, [isTransferActive, suggestedDestinationAddress]);

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

  return {
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
  };
}