import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { BridgeScreen } from "./BridgeScreen";
import type { BridgeIntentView } from "@/lib/bridge-service";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  attestation: vi.fn(),
  authorize: vi.fn(),
  submit: vi.fn(),
  verify: vi.fn(),
  create: vi.fn(),
  approval: vi.fn(),
  burn: vi.fn(),
  write: vi.fn(),
  receipt: vi.fn(),
  switch: vi.fn(),
}));
const wallet = "0x1111111111111111111111111111111111111111";
const id = "0a7ec8dc-549e-401f-8018-70011276c160";
const recoveryKey = `wizpay.bridge-intent.v1.${wallet}`;
const claimKey = `wizpay.bridge-destination.v1.${id}`;
const hash = `0x${"ab".repeat(32)}` as const;
const message = "0x1234";
const messageHash = keccak256(message);
const intent: BridgeIntentView = {
  id,
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  status: "awaiting_destination_signature",
  payload: {
    walletAddress: wallet,
    sourceCode: "ARC-MAINNET",
    destinationCode: "ETH-MAINNET",
    destinationChainId: 1,
    destinationMessageTransmitterV2: wallet,
    idempotencyKey: id,
    sourceChainId: 5042,
    sourceDomain: 26,
    destinationDomain: 0,
    sourceUsdcAddress: wallet,
    destinationUsdcAddress: wallet,
    sourceTokenMessengerV2: wallet,
    destinationTokenMessengerV2: wallet,
    recipientAddress: wallet,
    destinationCaller: wallet,
    amount: "1000000",
    maxFee: "0",
    minFinalityThreshold: 2000,
    createdAt: "2026-10-04T00:00:00Z",
  },
  result: {
    sourceTransactionHash: hash,
    attestedMessage: message,
    attestation: "0x5678",
    messageHash,
  },
};

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: wallet, chainId: 5042, isConnected: true }),
  useSwitchChain: () => ({ switchChainAsync: mocks.switch }),
  useWriteContract: () => ({ writeContractAsync: mocks.write }),
  usePublicClient: ({ chainId }: { chainId: number }) => ({
    chain: { id: chainId },
    waitForTransactionReceipt: mocks.receipt,
  }),
}));
vi.mock("@/lib/wagmi", () => ({ activeArcChain: { id: 5042 } }));
vi.mock("@/components/providers/CapabilityProvider", () => ({
  useCapability: () => ({ enabled: true, assertEnabled: () => {} }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("@/lib/bridge-service", () => ({
  getBridgeIntent: mocks.get,
  getBridgeAttestation: mocks.attestation,
  authorizeBridgeDestination: mocks.authorize,
  submitBridgeDestination: mocks.submit,
  verifyBridgeDestination: mocks.verify,
  createBridgeIntent: mocks.create,
  reportBridgeApproval: mocks.approval,
  reportBridgeSource: mocks.burn,
  fetchBridgeQuote: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(recoveryKey, id);
  mocks.get.mockResolvedValue(intent);
  mocks.attestation.mockResolvedValue({
    ...intent,
    status: "attestation_ready",
  });
  mocks.authorize.mockResolvedValue({
    ...intent,
    destinationLeaseId: "renewed-lease",
  });
  mocks.write.mockResolvedValue(hash);
  mocks.receipt.mockResolvedValue({ status: "success" });
  mocks.submit.mockResolvedValue({
    ...intent,
    status: "verifying_destination",
    result: { ...intent.result, destinationTransactionHash: hash },
  });
  mocks.verify.mockResolvedValue({
    ...intent,
    status: "completed",
    result: { ...intent.result, destinationTransactionHash: hash },
  });
});

async function resume() {
  const button = await screen.findByRole("button", {
    name: "Resume destination claim",
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

function noSourceWork() {
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.approval).not.toHaveBeenCalled();
  expect(mocks.burn).not.toHaveBeenCalled();
  for (const [request] of mocks.write.mock.calls)
    expect(request.functionName).toBe("receiveMessage");
}

describe("existing destination claim recovery", () => {
  it("keeps a gas-failed claim recoverable, then resumes the same intent after funding", async () => {
    mocks.write.mockRejectedValueOnce(new Error("Insufficient ETH for gas"));
    render(<BridgeScreen />);
    await resume();
    await screen.findByText("Insufficient ETH for gas");
    expect(localStorage.getItem(recoveryKey)).toBe(id);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Start over" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await screen.findByText(
      /Attestation is ready. Resume the destination claim/,
    );
    await resume();
    await screen.findByText("Native USDC bridged with Circle CCTP.");
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.authorize).toHaveBeenNthCalledWith(2, id, wallet);
    expect(mocks.switch).toHaveBeenCalledWith({ chainId: 1 });
    expect(mocks.write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        functionName: "receiveMessage",
        chainId: 1,
        args: [message, "0x5678"],
      }),
    );
    expect(mocks.submit).toHaveBeenCalledWith(id, {
      walletAddress: wallet,
      transactionHash: hash,
      messageHash,
      leaseId: "renewed-lease",
    });
    expect(mocks.verify).toHaveBeenCalledWith(id, wallet);
    expect(localStorage.getItem(recoveryKey)).toBeNull();
    expect(localStorage.getItem(claimKey)).toBeNull();
    noSourceWork();
  });

  it("rejects invalid attestation before authorization or wallet submission", async () => {
    mocks.attestation.mockResolvedValue({
      ...intent,
      status: "attestation_ready",
      result: { ...intent.result, messageHash: hash },
    });
    render(<BridgeScreen />);
    await resume();
    await screen.findByText(
      /Circle attestation is not ready or its data is invalid/,
    );
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(localStorage.getItem(recoveryKey)).toBe(id);
    noSourceWork();
  });

  it("retries a broadcast transaction after submission failure without another mint", async () => {
    mocks.submit.mockRejectedValueOnce(
      new Error("The destination submission lease expired"),
    );
    render(<BridgeScreen />);
    await resume();
    await screen.findByText("The destination submission lease expired");
    expect(localStorage.getItem(claimKey)).toContain(hash);
    await resume();
    await screen.findByText("Native USDC bridged with Circle CCTP.");
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    noSourceWork();
  });

  it("retries backend verification of a submitted claim without minting again", async () => {
    mocks.get.mockResolvedValue({
      ...intent,
      status: "verifying_destination",
      result: { ...intent.result, destinationTransactionHash: hash },
    });
    mocks.verify.mockRejectedValueOnce(
      new Error("Receipt verification unavailable"),
    );
    render(<BridgeScreen />);
    await resume();
    await screen.findByText("Receipt verification unavailable");
    expect(localStorage.getItem(recoveryKey)).toBe(id);
    await resume();
    await screen.findByText("Native USDC bridged with Circle CCTP.");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.attestation).not.toHaveBeenCalled();
    expect(localStorage.getItem(recoveryKey)).toBeNull();
    noSourceWork();
  });
  it("restores a broadcast claim after reload and renews its lease without minting", async () => {
    localStorage.setItem(
      claimKey,
      JSON.stringify({
        transactionHash: hash,
        messageHash,
        leaseId: "expired-lease",
      }),
    );
    render(<BridgeScreen />);
    await resume();
    await screen.findByText("Native USDC bridged with Circle CCTP.");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.submit).toHaveBeenCalledWith(
      id,
      expect.objectContaining({
        transactionHash: hash,
        leaseId: "renewed-lease",
      }),
    );
    expect(localStorage.getItem(recoveryKey)).toBeNull();
    noSourceWork();
  });

  it("retains recovery storage until verification actually returns completed", async () => {
    mocks.verify.mockResolvedValue({
      ...intent,
      status: "verifying_destination",
    });
    render(<BridgeScreen />);
    await resume();
    await screen.findByText(
      "Destination verification is still pending. Resume this claim again.",
    );
    expect(localStorage.getItem(recoveryKey)).toBe(id);
    expect(localStorage.getItem(claimKey)).toContain(hash);
    expect(
      screen.queryByText("Native USDC bridged with Circle CCTP."),
    ).not.toBeInTheDocument();
    noSourceWork();
  });
});
