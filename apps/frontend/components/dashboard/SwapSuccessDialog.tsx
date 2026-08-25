"use client";

import { TransactionSuccessDialog } from "./TransactionSuccessDialog";
import { TokenIcon } from "@/components/ui/token-icon";
import { ARC_TESTNET_CHAIN_ID, SUPPORTED_TOKENS, type TokenSymbol } from "@/lib/wizpay";

function amountWithIcon(amount: string, symbol: string) {
  const token = SUPPORTED_TOKENS[symbol as TokenSymbol];
  return token ? <span className="flex items-center gap-2"><TokenIcon chainId={ARC_TESTNET_CHAIN_ID} address={token.address} symbol={symbol} size={24} />{amount} {symbol}</span> : `${amount} ${symbol}`;
}

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
          value: amountWithIcon(result.inputAmount, result.inputToken),
        },
        {
          label: "Output",
          value: amountWithIcon(result.outputAmount, result.outputToken),
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
