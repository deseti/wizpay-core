import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";

import { ERC20_ABI } from "@/constants/erc20";

const TRANSFER_EVENT = [{
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
}] as const;

export async function verifyErc20Transfer({
  amount,
  hash,
  publicClient,
  recipient,
  sender,
  token,
}: {
  amount: bigint;
  hash: Hex;
  publicClient: PublicClient;
  recipient: Address;
  sender: Address;
  token: Address;
}) {
  const [receipt, transaction] = await Promise.all([
    publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }),
    publicClient.getTransaction({ hash }),
  ]);
  assertReceipt(receipt);
  if (transaction.chainId !== publicClient.chain?.id) throw new Error("Confirmed transaction chain mismatch.");
  if (getAddress(transaction.from) !== getAddress(sender)) throw new Error("Confirmed transaction sender mismatch.");
  if (!transaction.to || getAddress(transaction.to) !== getAddress(token)) throw new Error("Confirmed transaction token mismatch.");
  const decoded = decodeFunctionData({ abi: ERC20_ABI, data: transaction.input });
  if (decoded.functionName !== "transfer") throw new Error("Confirmed transaction is not an ERC-20 transfer.");
  const [decodedRecipient, decodedAmount] = decoded.args;
  if (getAddress(decodedRecipient) !== getAddress(recipient) || decodedAmount !== amount) {
    throw new Error("Confirmed transfer calldata does not match the reviewed recipient and amount.");
  }
  const transferMatched = receipt.logs.some((log) => {
    if (getAddress(log.address) !== getAddress(token)) return false;
    try {
      const event = decodeEventLog({ abi: TRANSFER_EVENT, data: log.data, topics: log.topics });
      return event.eventName === "Transfer" && getAddress(event.args.from) === getAddress(sender) && getAddress(event.args.to) === getAddress(recipient) && event.args.value === amount;
    } catch { return false; }
  });
  if (!transferMatched) throw new Error("Confirmed receipt is missing the exact ERC-20 Transfer evidence.");
  return receipt;
}

function assertReceipt(receipt: TransactionReceipt) {
  if (receipt.status !== "success") throw new Error("Transfer transaction reverted.");
}
