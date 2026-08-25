"use client";

import { TransactionSuccessDialog } from "./TransactionSuccessDialog";

export interface SwapSuccessResult {
  inputAmount: string;
  inputToken: string;
  outputAmount: string;
  outputToken: string;
  walletMode: "External Wallet" | "App Wallet";
  network: string;
  transactionHash: string;
  explorerUrl: string;
}

export function SwapSuccessDialog({
  open,
  result,
  onDone,
  onStartAnother,
}: {
  open: boolean;
  result: SwapSuccessResult;
  onDone: () => void;
  onStartAnother: () => void;
}) {
  return (
    <TransactionSuccessDialog
      open={open}
      title="Swap completed"
      description="The swap output was verified from the confirmed transaction."
      rows={[
        {
          label: "Input",
          value: `${result.inputAmount} ${result.inputToken}`,
        },
        {
          label: "Output",
          value: `${result.outputAmount} ${result.outputToken}`,
        },
        { label: "Wallet mode", value: result.walletMode },
        { label: "Network", value: result.network },
      ]}
      transactionHash={result.transactionHash}
      explorerUrl={result.explorerUrl}
      onDone={onDone}
      onStartAnother={onStartAnother}
      startAnotherLabel="Start another swap"
    />
  );
}
