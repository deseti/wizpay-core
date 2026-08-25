import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalBridgeProgress } from "./ExternalBridgeProgress";

const HASH = `0x${"ab".repeat(32)}`;

function renderProgress(
  stage: React.ComponentProps<typeof ExternalBridgeProgress>["stage"],
  overrides: Partial<React.ComponentProps<typeof ExternalBridgeProgress>> = {},
) {
  return render(
    <ExternalBridgeProgress
      stage={stage}
      sourceNetwork="Arc Testnet"
      destinationNetwork="Base Sepolia"
      amount="10"
      token="USDC"
      sourceTransactionHash={HASH}
      sourceTransactionUrl={`https://example.com/tx/${HASH}`}
      createdAt="2026-08-25T00:00:00.000Z"
      condition={null}
      canCheckStatus
      checkingStatus={false}
      manualCheckAvailableInSeconds={0}
      onCheckStatus={vi.fn()}
      {...overrides}
    />,
  );
}

describe("ExternalBridgeProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:02:05.000Z"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders confirmed burn plus pending Iris as normal active progress", () => {
    renderProgress("waiting_for_attestation");

    expect(
      screen.getByRole("region", { name: "Bridge in progress" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Waiting for Circle attestation")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("idle")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Elapsed processing time")).toHaveTextContent(
      "02:05 elapsed",
    );

    const steps = screen.getAllByRole("listitem");
    expect(steps[0]).toHaveAttribute("data-state", "completed");
    expect(steps[1]).toHaveAttribute("data-state", "active");
    expect(steps[2]).toHaveAttribute("data-state", "pending");
    expect(steps[3]).toHaveAttribute("data-state", "pending");
  });

  it.each([
    ["attestation_ready", 2],
    ["switching_destination_chain", 2],
    ["awaiting_mint_signature", 2],
    ["confirming_destination_mint", 3],
    ["verifying_completion", 3],
  ] as const)("maps %s to the correct active step", (stage, activeStep) => {
    renderProgress(stage);
    const steps = screen.getAllByRole("listitem");
    expect(steps[activeStep]).toHaveAttribute("data-state", "active");
    steps.slice(0, activeStep).forEach((step) =>
      expect(step).toHaveAttribute("data-state", "completed"),
    );
  });

  it("uses amber status semantics for retryable provider conditions", () => {
    renderProgress("waiting_for_attestation", {
      condition: {
        tone: "retryable",
        message: "Circle Iris timed out. The saved burn remains active.",
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent("timed out");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses red failed semantics only for a verified failure", () => {
    renderProgress("verifying_completion", {
      condition: {
        tone: "failed",
        message: "The decoded recipient does not match.",
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "decoded recipient does not match",
    );
    expect(screen.getAllByRole("listitem")[3]).toHaveAttribute(
      "data-state",
      "failed",
    );
  });

  it("throttles the manual action presentation and copies the full hash", async () => {
    const onCheckStatus = vi.fn();
    renderProgress("waiting_for_attestation", {
      canCheckStatus: false,
      manualCheckAvailableInSeconds: 12,
      onCheckStatus,
    });
    const check = screen.getByRole("button", { name: "Check again in 12s" });
    expect(check).toBeDisabled();
    fireEvent.click(check);
    expect(onCheckStatus).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Copy source burn transaction hash",
      }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(HASH);
  });

  it("keeps the stepper in a wrapping, mobile-safe grid", () => {
    renderProgress("waiting_for_attestation");
    const stepper = screen.getByRole("list", { name: "Bridge progress" });
    expect(stepper).toHaveClass("grid", "sm:grid-cols-4");
    expect(stepper).not.toHaveClass("overflow-x-auto");
  });
});
