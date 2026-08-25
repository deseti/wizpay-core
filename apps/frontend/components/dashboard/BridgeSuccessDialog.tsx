"use client";

import { TransactionSuccessDialog } from "./TransactionSuccessDialog";
import { TokenIcon } from "@/components/ui/token-icon";
import { ARC_TESTNET_CHAIN_ID, SUPPORTED_TOKENS } from "@/lib/wizpay";

export interface BridgeSuccessDialogProps {
  open: boolean;
  sourceNetwork: string;
  destinationNetwork: string;
  amount: string;
  token: string;
  recipient: string;
  sourceTransactionUrl: string;
  destinationTransactionUrl: string;
  onDone: () => void;
  onStartAnother: () => void;
}

export function BridgeSuccessDialog({
  open,
  sourceNetwork,
  destinationNetwork,
  amount,
  token,
  recipient,
  sourceTransactionUrl,
  destinationTransactionUrl,
  onDone,
  onStartAnother,
}: BridgeSuccessDialogProps) {
  return (
    <TransactionSuccessDialog
      open={open}
      title="Bridge completed"
      description="The destination mint was strictly verified onchain."
      rows={[
        {
          label: "Route",
          value: `${sourceNetwork} → ${destinationNetwork}`,
        },
        { label: "Amount", value: <span className="flex items-center gap-2"><TokenIcon chainId={ARC_TESTNET_CHAIN_ID} address={SUPPORTED_TOKENS.USDC.address} symbol={token} size={24} />{amount} {token}</span> },
        {
          label: "Recipient wallet",
          value: <span className="break-all font-mono text-xs">{recipient}</span>,
        },
      ]}
      explorerUrl={sourceTransactionUrl}
      primaryTransactionLabel="Source burn transaction"
      secondaryTransaction={{
        label: "Destination mint transaction",
        explorerUrl: destinationTransactionUrl,
      }}
      onDone={onDone}
      onStartAnother={onStartAnother}
      startAnotherLabel="Start another bridge"
    />
  );
}
