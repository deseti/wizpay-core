import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SuccessModal } from "./SuccessModal";

describe("SuccessModal payroll run summary", () => {
  it("renders the complete mixed-token run with deduplicated execution hashes", () => {
    const sameTokenHash = `0x${"a".repeat(64)}`;
    const crossTokenHash = `0x${"b".repeat(64)}`;
    const approvalHash = `0x${"c".repeat(64)}`;

    render(
      <SuccessModal
        isOpen
        onClose={vi.fn()}
        txHash={crossTokenHash}
        approvalTxHash={approvalHash}
        txHashes={[sameTokenHash, crossTokenHash, sameTokenHash]}
        totalAmount={30_000n}
        tokenSymbol="USDC"
        decimals={6}
        recipientCount={3}
        isMultiBatch
        referenceId="PAY-MIXED"
        sessionTotalDistributed={{ USDC: 20_000n, EURC: 10_000n }}
      />,
    );

    const recipients = screen.getByText("Recipients").parentElement;
    expect(recipients).not.toBeNull();
    expect(within(recipients!).getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Assets Routed")).toBeInTheDocument();
    expect(screen.getByText("Mixed tokens")).toBeInTheDocument();
    expect(screen.queryByText("0.03")).not.toBeInTheDocument();
    expect(screen.getByText("0.02")).toBeInTheDocument();
    expect(screen.getByText("0.01")).toBeInTheDocument();
    expect(screen.getByText("Batch 1")).toBeInTheDocument();
    expect(screen.getByText("Batch 2")).toBeInTheDocument();
    expect(screen.queryByText("Batch 3")).not.toBeInTheDocument();
    expect(screen.getByText("Approval Tx")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Explorer/ })).toHaveLength(3);
    expect(screen.getByText("PAY-MIXED")).toBeInTheDocument();
  });

  it("keeps the single-token routed amount for a same-token run", () => {
    const txHash = `0x${"d".repeat(64)}`;

    render(
      <SuccessModal
        isOpen
        onClose={vi.fn()}
        txHash={txHash}
        txHashes={[txHash]}
        totalAmount={20_000n}
        tokenSymbol="USDC"
        decimals={6}
        recipientCount={2}
        isMultiBatch={false}
        referenceId="PAY-USDC"
        sessionTotalDistributed={{ USDC: 20_000n, EURC: 0n }}
      />,
    );

    const routed = screen.getByText("Amount Routed").parentElement;
    expect(routed).not.toBeNull();
    expect(within(routed!).getByText("0.02")).toBeInTheDocument();
    expect(within(routed!).getByText("USDC")).toBeInTheDocument();
    expect(screen.queryByText("Mixed tokens")).not.toBeInTheDocument();
  });
});
