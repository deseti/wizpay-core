import {
  BRIDGE_TESTNETS,
  CCTP_V2_TESTNET_IRIS_BASE_URL,
  assertBridgeRoute,
  assertRegistryMatch,
  getBridgeTestnet,
  type BridgeTestnetCode,
  type BridgeTestnetDefinition,
} from "@wizpay/bridge-registry";
import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  keccak256,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type Transaction,
  type TransactionReceipt,
} from "viem";

export const CCTP_STANDARD_FINALITY = 2000 as const;
export const CCTP_USDC_DECIMALS = 6;
export const CCTP_V2_RECOVERY_KEY = "wizpay-external-cctp-v2-recovery";
export const CCTP_DESTINATION_LOG_CHUNK_SIZE = 10_000n;
export const CCTP_DESTINATION_LOG_LOOKBACK = 250_000n;

export const CCTP_TOKEN_MESSENGER_V2_ABI = parseAbi([
  "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)",
  "event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)",
]);
export const CCTP_MESSAGE_TRANSMITTER_V2_ABI = parseAbi([
  "function receiveMessage(bytes message,bytes attestation) returns (bool)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
  "event MessageSent(bytes message)",
  "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
]);
export const CCTP_ERC20_ABI = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export interface DirectBridgeRecovery {
  cctpVersion: 2;
  sourceChainId: number;
  sourceDomain: number;
  destinationChainId: number;
  destinationDomain: number;
  sourceTransactionHash: Hex;
  destinationTransactionHash?: Hex;
  walletAddress: Address;
  createdAt: string;
  amountUnits?: string;
}
export interface DecodedCctpV2Message {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Address;
  recipient: Address;
  destinationCaller: Address;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  burnVersion: number;
  burnToken: Address;
  mintRecipient: Address;
  amount: bigint;
  messageSender: Address;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  messageHash: Hex;
  messageBody: Hex;
}
export interface IrisMessage {
  status?: string;
  cctpVersion?: number;
  eventNonce?: Hex;
  message?: Hex;
  attestation?: Hex;
}
export interface VerifiedSourceTransfer {
  recovery: DirectBridgeRecovery;
  source: BridgeTestnetDefinition;
  destination: BridgeTestnetDefinition;
  sourceMessage: Hex;
  message: Hex;
  attestation: Hex;
  decoded: DecodedCctpV2Message;
}

function sliceBytes(message: Hex, offset: number, length: number): Hex {
  const start = 2 + offset * 2;
  return `0x${message.slice(start, start + length * 2)}`;
}
function readNumber(message: Hex, offset: number, length: number) {
  return Number(BigInt(sliceBytes(message, offset, length)));
}
function readBigInt(message: Hex, offset: number, length: number) {
  return BigInt(sliceBytes(message, offset, length));
}
function readAddress(message: Hex, offset: number) {
  return getAddress(`0x${sliceBytes(message, offset, 32).slice(-40)}`);
}
export function addressToBytes32(address: Address): Hex {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}
export function decodeCctpV2Message(message: Hex): DecodedCctpV2Message {
  if (!isHex(message) || (message.length - 2) / 2 < 376)
    throw new Error(
      "Circle returned an invalid or incomplete CCTP V2 message.",
    );
  const body = 148;
  return {
    version: readNumber(message, 0, 4),
    sourceDomain: readNumber(message, 4, 4),
    destinationDomain: readNumber(message, 8, 4),
    nonce: sliceBytes(message, 12, 32),
    sender: readAddress(message, 44),
    recipient: readAddress(message, 76),
    destinationCaller: readAddress(message, 108),
    minFinalityThreshold: readNumber(message, 140, 4),
    finalityThresholdExecuted: readNumber(message, 144, 4),
    burnVersion: readNumber(message, body, 4),
    burnToken: readAddress(message, body + 4),
    mintRecipient: readAddress(message, body + 36),
    amount: readBigInt(message, body + 68, 32),
    messageSender: readAddress(message, body + 100),
    maxFee: readBigInt(message, body + 132, 32),
    feeExecuted: readBigInt(message, body + 164, 32),
    expirationBlock: readBigInt(message, body + 196, 32),
    messageHash: keccak256(message),
    messageBody: `0x${message.slice(2 + body * 2)}`,
  };
}

export function validateBridgeRequest(input: {
  sourceCode: string;
  destinationCode: string;
  walletAddress: string;
  recipientAddress: string;
  amount: bigint;
  maxFee: bigint;
}) {
  const { source, destination } = assertBridgeRoute(
    input.sourceCode,
    input.destinationCode,
  );
  assertRegistryMatch(source.code, source);
  assertRegistryMatch(destination.code, destination);
  if (!source.standardTransferSource || source.finalityThreshold !== 2000)
    throw new Error(
      "The selected source does not support CCTP Standard Transfer.",
    );
  if (!isAddress(input.walletAddress) || !isAddress(input.recipientAddress))
    throw new Error("Connect a valid external EVM wallet before bridging.");
  const walletAddress = getAddress(input.walletAddress);
  const recipientAddress = getAddress(input.recipientAddress);
  if (!isAddressEqual(walletAddress, recipientAddress))
    throw new Error(
      "Bridge recipient must match the connected external wallet.",
    );
  if (input.amount <= 0n)
    throw new Error("Bridge amount must be greater than zero.");
  if (input.maxFee < 0n || input.maxFee >= input.amount)
    throw new Error("The current CCTP fee is invalid for this amount.");
  return {
    source,
    destination,
    walletAddress,
    recipientAddress,
    amount: input.amount,
    maxFee: input.maxFee,
  };
}
export function buildExplorerTransactionUrl(
  code: BridgeTestnetCode,
  hash: Hex,
) {
  return `${getBridgeTestnet(code).explorerBaseUrl}/tx/${hash}`;
}

export function writeDirectBridgeRecovery(value: DirectBridgeRecovery) {
  window.localStorage.setItem(CCTP_V2_RECOVERY_KEY, JSON.stringify(value));
}
export function persistDestinationTransactionHash(
  recovery: DirectBridgeRecovery,
  destinationTransactionHash: Hex,
) {
  const value = { ...recovery, destinationTransactionHash };
  writeDirectBridgeRecovery(value);
  return value;
}
export function readDirectBridgeRecovery(): DirectBridgeRecovery | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(
      window.localStorage.getItem(CCTP_V2_RECOVERY_KEY) ?? "null",
    ) as DirectBridgeRecovery | null;
    if (
      !value ||
      value.cctpVersion !== 2 ||
      !isHex(value.sourceTransactionHash, { strict: true }) ||
      value.sourceTransactionHash.length !== 66 ||
      (value.destinationTransactionHash !== undefined &&
        (!isHex(value.destinationTransactionHash, { strict: true }) ||
          value.destinationTransactionHash.length !== 66)) ||
      !isAddress(value.walletAddress) ||
      (value.amountUnits !== undefined && !/^\d+$/.test(value.amountUnits))
    )
      return null;
    const source = BRIDGE_TESTNETS.find(
      (item) =>
        item.chainId === value.sourceChainId &&
        item.cctpDomain === value.sourceDomain,
    );
    const destination = BRIDGE_TESTNETS.find(
      (item) =>
        item.chainId === value.destinationChainId &&
        item.cctpDomain === value.destinationDomain,
    );
    if (!source || !destination) return null;
    assertBridgeRoute(source.code, destination.code);
    return { ...value, walletAddress: getAddress(value.walletAddress) };
  } catch {
    return null;
  }
}
export function clearDirectBridgeRecovery() {
  window.localStorage.removeItem(CCTP_V2_RECOVERY_KEY);
}

export async function fetchIrisMessages(
  sourceDomain: number,
  sourceTransactionHash: Hex,
  signal?: AbortSignal,
) {
  if (
    !Number.isSafeInteger(sourceDomain) ||
    sourceDomain < 0 ||
    !isHex(sourceTransactionHash, { strict: true }) ||
    sourceTransactionHash.length !== 66
  )
    throw new Error("Invalid CCTP source domain or transaction hash.");
  const url = `${CCTP_V2_TESTNET_IRIS_BASE_URL}/messages/${sourceDomain}?transactionHash=${sourceTransactionHash}`;
  const timeoutSignal = AbortSignal.timeout(10_000);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    signal: requestSignal,
  });
  if (response.status === 404)
    return { state: "pending" as const, messages: [] as IrisMessage[] };
  if (response.status === 429 || response.status >= 500)
    throw new Error(
      "Circle Iris is temporarily unavailable. The confirmed burn remains recoverable.",
    );
  if (!response.ok)
    throw new Error(
      `Circle Iris rejected the attestation request (${response.status}).`,
    );
  const text = await response.text();
  if (text.length > 1_000_000)
    throw new Error("Circle Iris response exceeded the safe size limit.");
  const parsed = JSON.parse(text) as { messages?: IrisMessage[] };
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (
    !messages.length ||
    messages.every((message) => message.status !== "complete")
  )
    return { state: "pending" as const, messages };
  return { state: "complete" as const, messages };
}

function decodeMatchingLog(
  logs: readonly Log[],
  abi:
    | typeof CCTP_TOKEN_MESSENGER_V2_ABI
    | typeof CCTP_MESSAGE_TRANSMITTER_V2_ABI,
  eventName: "DepositForBurn" | "MessageSent" | "MessageReceived",
  emitter: Address,
) {
  for (const log of logs) {
    if (!isAddressEqual(log.address, emitter)) continue;
    try {
      return decodeEventLog({
        abi,
        eventName,
        data: log.data,
        topics: log.topics,
      });
    } catch {}
  }
  throw new Error(
    `The confirmed receipt is missing ${eventName} from the official CCTP V2 contract.`,
  );
}
function sameStaticTransfer(a: DecodedCctpV2Message, b: DecodedCctpV2Message) {
  return (
    a.version === 1 &&
    b.version === 1 &&
    a.sourceDomain === b.sourceDomain &&
    a.destinationDomain === b.destinationDomain &&
    isAddressEqual(a.sender, b.sender) &&
    isAddressEqual(a.recipient, b.recipient) &&
    isAddressEqual(a.destinationCaller, b.destinationCaller) &&
    a.minFinalityThreshold === b.minFinalityThreshold &&
    a.burnVersion === b.burnVersion &&
    isAddressEqual(a.burnToken, b.burnToken) &&
    isAddressEqual(a.mintRecipient, b.mintRecipient) &&
    a.amount === b.amount &&
    isAddressEqual(a.messageSender, b.messageSender) &&
    a.maxFee === b.maxFee
  );
}
export function verifyIrisMessage(input: {
  messages: IrisMessage[];
  sourceMessage: Hex;
  source: BridgeTestnetDefinition;
  destination: BridgeTestnetDefinition;
  walletAddress: Address;
}) {
  const sourceDecoded = decodeCctpV2Message(input.sourceMessage);
  const candidate = input.messages.find((item) => {
    if (
      item.status !== "complete" ||
      item.cctpVersion !== 2 ||
      !item.message ||
      !item.attestation ||
      !isHex(item.message) ||
      !isHex(item.attestation)
    )
      return false;
    try {
      return sameStaticTransfer(
        sourceDecoded,
        decodeCctpV2Message(item.message),
      );
    } catch {
      return false;
    }
  });
  if (!candidate?.message || !candidate.attestation)
    throw new Error(
      "Circle Iris did not return a complete message matching the confirmed source burn.",
    );
  const decoded = decodeCctpV2Message(candidate.message);
  if (
    decoded.sourceDomain !== input.source.cctpDomain ||
    decoded.destinationDomain !== input.destination.cctpDomain ||
    !isAddressEqual(decoded.sender, input.source.tokenMessengerV2) ||
    !isAddressEqual(decoded.recipient, input.destination.tokenMessengerV2) ||
    !isAddressEqual(decoded.destinationCaller, input.walletAddress) ||
    !isAddressEqual(decoded.burnToken, input.source.usdcAddress) ||
    !isAddressEqual(decoded.mintRecipient, input.walletAddress) ||
    !isAddressEqual(decoded.messageSender, input.walletAddress) ||
    decoded.minFinalityThreshold !== input.source.finalityThreshold ||
    decoded.finalityThresholdExecuted !== input.source.finalityThreshold ||
    decoded.nonce === `0x${"00".repeat(32)}` ||
    decoded.feeExecuted > decoded.maxFee ||
    candidate.eventNonce?.toLowerCase() !== decoded.nonce.toLowerCase()
  )
    throw new Error(
      "The complete Circle message does not match the selected route, wallet, token, amount, fee, nonce, or finality policy.",
    );
  return {
    message: candidate.message,
    attestation: candidate.attestation,
    decoded,
  };
}

export async function verifySourceTransfer(input: {
  sourceClient: PublicClient;
  source: BridgeTestnetDefinition;
  sourceTransactionHash: Hex;
  irisMessages: IrisMessage[];
}): Promise<VerifiedSourceTransfer> {
  if ((await input.sourceClient.getChainId()) !== input.source.chainId)
    throw new Error("Source RPC chain does not match the recovery network.");
  const [transaction, receipt] = await Promise.all([
    input.sourceClient.getTransaction({ hash: input.sourceTransactionHash }),
    input.sourceClient.getTransactionReceipt({
      hash: input.sourceTransactionHash,
    }),
  ]);
  if (
    receipt.status !== "success" ||
    !transaction.to ||
    !isAddressEqual(transaction.to, input.source.tokenMessengerV2)
  )
    throw new Error(
      "The source transaction is not a successful call to the official TokenMessengerV2.",
    );
  const call = decodeFunctionData({
    abi: CCTP_TOKEN_MESSENGER_V2_ABI,
    data: transaction.input,
  });
  if (call.functionName !== "depositForBurn")
    throw new Error(
      "The source transaction did not call CCTP V2 depositForBurn.",
    );
  const [
    amount,
    destinationDomain,
    mintRecipient,
    burnToken,
    destinationCaller,
    maxFee,
    minFinalityThreshold,
  ] = call.args;
  const destination = BRIDGE_TESTNETS.find(
    (item) => item.cctpDomain === destinationDomain,
  );
  if (!destination)
    throw new Error(
      "The source burn targets an unsupported destination domain.",
    );
  assertBridgeRoute(input.source.code, destination.code);
  const walletAddress = getAddress(transaction.from);
  if (
    !isAddressEqual(burnToken, input.source.usdcAddress) ||
    mintRecipient.toLowerCase() !==
      addressToBytes32(walletAddress).toLowerCase() ||
    destinationCaller.toLowerCase() !==
      addressToBytes32(walletAddress).toLowerCase() ||
    minFinalityThreshold !== input.source.finalityThreshold ||
    amount <= 0n ||
    maxFee >= amount
  )
    throw new Error(
      "The source burn calldata does not match WizPay's direct CCTP V2 policy.",
    );
  const deposit = decodeMatchingLog(
    receipt.logs,
    CCTP_TOKEN_MESSENGER_V2_ABI,
    "DepositForBurn",
    input.source.tokenMessengerV2,
  );
  const depositArgs = deposit.args as Record<string, unknown>;
  if (
    depositArgs.amount !== amount ||
    depositArgs.destinationDomain !== destinationDomain ||
    depositArgs.maxFee !== maxFee ||
    depositArgs.minFinalityThreshold !== minFinalityThreshold ||
    !isAddressEqual(depositArgs.burnToken as Address, burnToken) ||
    !isAddressEqual(depositArgs.depositor as Address, walletAddress)
  )
    throw new Error(
      "The source DepositForBurn event does not match the transaction calldata.",
    );
  const sent = decodeMatchingLog(
    receipt.logs,
    CCTP_MESSAGE_TRANSMITTER_V2_ABI,
    "MessageSent",
    input.source.messageTransmitterV2,
  );
  const sourceMessage = (sent.args as { message: Hex }).message;
  const sourceDecoded = decodeCctpV2Message(sourceMessage);
  if (
    sourceDecoded.nonce !== `0x${"00".repeat(32)}` ||
    sourceDecoded.finalityThresholdExecuted !== 0 ||
    sourceDecoded.amount !== amount
  )
    throw new Error(
      "The source MessageSent event is not the canonical pre-attestation CCTP V2 message.",
    );
  const verified = verifyIrisMessage({
    messages: input.irisMessages,
    sourceMessage,
    source: input.source,
    destination,
    walletAddress,
  });
  return {
    recovery: {
      cctpVersion: 2,
      sourceChainId: input.source.chainId,
      sourceDomain: input.source.cctpDomain,
      destinationChainId: destination.chainId,
      destinationDomain: destination.cctpDomain,
      sourceTransactionHash: input.sourceTransactionHash,
      walletAddress,
      createdAt: new Date().toISOString(),
      amountUnits: amount.toString(),
    },
    source: input.source,
    destination,
    sourceMessage,
    ...verified,
  };
}

export async function readNonceState(
  client: PublicClient,
  destination: BridgeTestnetDefinition,
  nonce: Hex,
) {
  if ((await client.getChainId()) !== destination.chainId)
    throw new Error(
      "Destination RPC chain does not match the attested message.",
    );
  return client.readContract({
    address: destination.messageTransmitterV2,
    abi: CCTP_MESSAGE_TRANSMITTER_V2_ABI,
    functionName: "usedNonces",
    args: [nonce],
  });
}

async function validateDestinationClients(
  clients: readonly PublicClient[],
  destination: BridgeTestnetDefinition,
) {
  if (!clients.length) throw new Error("The destination RPC is unavailable.");
  const validClients: PublicClient[] = [];
  for (const client of clients) {
    try {
      if ((await client.getChainId()) === destination.chainId)
        validClients.push(client);
    } catch {}
  }
  if (!validClients.length)
    throw new Error(
      "Destination RPC chain does not match the attested message.",
    );
  return validClients;
}

export async function verifyKnownDestinationCompletion(
  clients: readonly PublicClient[],
  transfer: VerifiedSourceTransfer,
  destinationTransactionHash: Hex,
) {
  const validClients = await validateDestinationClients(
    clients,
    transfer.destination,
  );
  let lastError: unknown;
  for (const client of validClients) {
    try {
      const [receipt, transaction] = await Promise.all([
        client.getTransactionReceipt({ hash: destinationTransactionHash }),
        client.getTransaction({ hash: destinationTransactionHash }),
      ]);
      const evidence = verifyDestinationReceipt({
        receipt,
        transaction,
        transfer,
        walletAddress: transfer.recovery.walletAddress,
        destinationTransactionHash,
      });
      const used = await readNonceState(
        client,
        transfer.destination,
        transfer.decoded.nonce,
      );
      if (used === 0n)
        throw new Error(
          "The destination MessageTransmitterV2 did not mark the nonce used.",
        );
      return { destinationTransactionHash, nonceState: used, evidence };
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The exact destination transaction could not be verified.");
}

export async function discoverDestinationCompletion(
  clients: readonly PublicClient[],
  transfer: VerifiedSourceTransfer,
) {
  const validClients = await validateDestinationClients(
    clients,
    transfer.destination,
  );
  let latestBlock: bigint | undefined;
  for (const client of validClients) {
    try {
      latestBlock = await client.getBlockNumber();
      break;
    } catch {}
  }
  if (latestBlock === undefined)
    throw new Error("Destination RPCs could not return the latest block.");
  const firstBlock =
    latestBlock >= CCTP_DESTINATION_LOG_LOOKBACK
      ? latestBlock - CCTP_DESTINATION_LOG_LOOKBACK + 1n
      : 0n;
  let toBlock = latestBlock;
  while (toBlock >= firstBlock) {
    const fromBlock =
      toBlock - firstBlock + 1n > CCTP_DESTINATION_LOG_CHUNK_SIZE
        ? toBlock - CCTP_DESTINATION_LOG_CHUNK_SIZE + 1n
        : firstBlock;
    let logs: Awaited<ReturnType<PublicClient["getLogs"]>> | undefined;
    let chunkError: unknown;
    for (const client of validClients) {
      try {
        logs = await client.getLogs({
          address: transfer.destination.messageTransmitterV2,
          event: parseAbiItem(
            "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
          ),
          args: { nonce: transfer.decoded.nonce },
          fromBlock,
          toBlock,
        });
        break;
      } catch (cause) {
        chunkError = cause;
      }
    }
    if (!logs)
      throw chunkError instanceof Error
        ? chunkError
        : new Error("Destination RPCs rejected the bounded log query.");
    for (const log of logs) {
      if (!log.transactionHash) continue;
      try {
        return await verifyKnownDestinationCompletion(
          validClients,
          transfer,
          log.transactionHash,
        );
      } catch {}
    }
    if (fromBlock === 0n) break;
    toBlock = fromBlock - 1n;
  }
  throw new Error(
    "The nonce is used, but bounded nonce-indexed recovery did not establish an exact destination receipt. Another mint is blocked.",
  );
}

export async function submitAndVerifyDestinationMint(input: {
  client: PublicClient;
  transfer: VerifiedSourceTransfer;
  submit: () => Promise<Hex>;
  onPersisted?: (
    recovery: DirectBridgeRecovery,
    destinationTransactionHash: Hex,
  ) => void;
}) {
  const currentNonce = await readNonceState(
    input.client,
    input.transfer.destination,
    input.transfer.decoded.nonce,
  );
  if (currentNonce !== 0n)
    throw new Error(
      "This CCTP message was already received. Another mint transaction is blocked.",
    );
  const destinationTransactionHash = await input.submit();
  const recovery = persistDestinationTransactionHash(
    input.transfer.recovery,
    destinationTransactionHash,
  );
  input.onPersisted?.(recovery, destinationTransactionHash);
  const receipt = await input.client.waitForTransactionReceipt({
    hash: destinationTransactionHash,
  });
  const transaction = await input.client.getTransaction({
    hash: destinationTransactionHash,
  });
  const evidence = verifyDestinationReceipt({
    receipt,
    transaction,
    transfer: input.transfer,
    walletAddress: input.transfer.recovery.walletAddress,
    destinationTransactionHash,
  });
  const nonceState = await readNonceState(
    input.client,
    input.transfer.destination,
    input.transfer.decoded.nonce,
  );
  if (nonceState === 0n)
    throw new Error(
      "The destination MessageTransmitterV2 did not mark the nonce used.",
    );
  return { destinationTransactionHash, recovery, nonceState, evidence };
}

export function verifyDestinationReceipt(input: {
  receipt: TransactionReceipt;
  transaction: Transaction;
  transfer: VerifiedSourceTransfer;
  walletAddress: Address;
  destinationTransactionHash?: Hex;
}) {
  const {
    receipt,
    transaction,
    transfer,
    walletAddress,
    destinationTransactionHash,
  } = input;
  if (
    receipt.status !== "success" ||
    (destinationTransactionHash !== undefined &&
      (receipt.transactionHash.toLowerCase() !==
        destinationTransactionHash.toLowerCase() ||
        transaction.hash.toLowerCase() !==
          destinationTransactionHash.toLowerCase())) ||
    !transaction.to ||
    !isAddressEqual(
      transaction.to,
      transfer.destination.messageTransmitterV2,
    ) ||
    !isAddressEqual(transaction.from, walletAddress)
  )
    throw new Error(
      "The destination transaction is not a successful wallet-signed MessageTransmitterV2 call.",
    );
  const call = decodeFunctionData({
    abi: CCTP_MESSAGE_TRANSMITTER_V2_ABI,
    data: transaction.input,
  });
  if (
    call.functionName !== "receiveMessage" ||
    call.args[0].toLowerCase() !== transfer.message.toLowerCase() ||
    call.args[1].toLowerCase() !== transfer.attestation.toLowerCase()
  )
    throw new Error(
      "The destination calldata does not contain the exact Circle message and attestation.",
    );
  const received = decodeMatchingLog(
    receipt.logs,
    CCTP_MESSAGE_TRANSMITTER_V2_ABI,
    "MessageReceived",
    transfer.destination.messageTransmitterV2,
  );
  const args = received.args as Record<string, unknown>;
  if (
    !isAddressEqual(args.caller as Address, walletAddress) ||
    args.sourceDomain !== transfer.source.cctpDomain ||
    String(args.nonce).toLowerCase() !== transfer.decoded.nonce.toLowerCase() ||
    String(args.sender).toLowerCase() !==
      addressToBytes32(transfer.source.tokenMessengerV2).toLowerCase() ||
    args.finalityThresholdExecuted !==
      transfer.decoded.finalityThresholdExecuted ||
    String(args.messageBody).toLowerCase() !==
      transfer.decoded.messageBody.toLowerCase()
  )
    throw new Error(
      "The official MessageReceived event does not match the attested transfer.",
    );
  const expectedMint =
    (transfer.decoded.amount - transfer.decoded.feeExecuted) *
    10n **
      BigInt(
        transfer.destination.mintEvidenceDecimals -
          transfer.destination.usdcDecimals,
      );
  const mint = receipt.logs.some((log) => {
    if (!isAddressEqual(log.address, transfer.destination.mintEvidenceEmitter))
      return false;
    try {
      const event = decodeEventLog({
        abi: CCTP_ERC20_ABI,
        eventName: "Transfer",
        data: log.data,
        topics: log.topics,
      });
      return (
        isAddressEqual(
          event.args.from,
          "0x0000000000000000000000000000000000000000",
        ) &&
        isAddressEqual(event.args.to, transfer.decoded.mintRecipient) &&
        event.args.value === expectedMint
      );
    } catch {
      return false;
    }
  });
  if (!mint)
    throw new Error(
      "The destination receipt lacks matching USDC mint evidence.",
    );
  return {
    amount: expectedMint,
    recipient: transfer.decoded.mintRecipient,
    token: transfer.destination.usdcAddress,
  };
}

let bridgeSubmissionPending = false;
export async function withBridgeSubmissionLock<T>(operation: () => Promise<T>) {
  if (bridgeSubmissionPending)
    throw new Error("A bridge wallet action is already pending.");
  bridgeSubmissionPending = true;
  try {
    return await operation();
  } finally {
    bridgeSubmissionPending = false;
  }
}
