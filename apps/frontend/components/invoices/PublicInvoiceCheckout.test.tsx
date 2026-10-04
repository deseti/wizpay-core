import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicInvoiceCheckout } from "./PublicInvoiceCheckout";

vi.mock("@/components/providers/CapabilityProvider", () => ({
  useCapability: () => ({
    enabled: true,
    unavailableMessage: null,
    assertEnabled: vi.fn(),
  }),
}));
import { getPublicInvoice, type PublicInvoice } from "@/lib/invoice-api";
import QRCode from "qrcode";

let paymentState: Record<string, unknown>;
vi.mock("@/hooks/useInvoicePayment", () => ({
  useInvoicePayment: () => paymentState,
}));
vi.mock("@/lib/invoice-api", async (original) => ({
  ...(await original<typeof import("@/lib/invoice-api")>()),
  getPublicInvoice: vi.fn(),
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,qr") },
}));
vi.mock("@reown/appkit/react", () => ({
  useAppKit: () => ({ open: vi.fn() }),
}));

describe("PublicInvoiceCheckout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(QRCode.toDataURL).mockResolvedValue("data:image/png;base64,qr");
    paymentState = {
      stage: "ready",
      error: null,
      transactionHash: null,
      method: "external",
      appAuthenticated: false,
      appWalletAddress: null,
      isConnected: false,
      locked: false,
      checking: false,
      canContinueAppAuthorization: false,
      pay: vi.fn(),
      selectMethod: vi.fn(),
      authenticateAppWallet: vi.fn(),
      continueAppAuthorization: vi.fn(),
      checkStatus: vi.fn(),
    };
  });

  it("renders immutable checkout details, canonical token icon, responsive layout, and checkout URL QR", async () => {
    vi.mocked(getPublicInvoice).mockResolvedValue(invoice());
    const { container } = render(
      <PublicInvoiceCheckout publicId={invoice().publicId} />,
    );
    expect(await screen.findByText("Test invoice")).toBeInTheDocument();
    expect(screen.getByText("0.1")).toBeInTheDocument();
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    expect(screen.getByText(/Arc Mainnet · 5042/)).toBeInTheDocument();
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    expect(container.querySelector('[class*="lg:grid-cols"]')).toBeTruthy();
    await waitFor(() =>
      expect(QRCode.toDataURL).toHaveBeenCalledWith(
        "http://localhost:3000/pay/abcdefghijklmnopqrstuv",
        expect.any(Object),
      ),
    );
    expect(
      screen.getByText(/QR contains only the HTTPS WizPay checkout URL/),
    ).toBeInTheDocument();
  });

  it.each([
    ["EXPIRED", "Invoice expired"],
    ["CANCELLED", "Invoice cancelled"],
  ] as const)(
    "renders the %s terminal state and never enables payment",
    async (status, label) => {
      vi.mocked(getPublicInvoice).mockResolvedValue({ ...invoice(), status });
      paymentState = { ...paymentState, stage: status.toLowerCase() };
      render(<PublicInvoiceCheckout publicId={invoice().publicId} />);
      expect(await screen.findByText(label)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Pay 0.1 USDC/ }),
      ).not.toBeInTheDocument();
    },
  );

  it("uses the professional transaction success dialog only for backend-verified paid state", async () => {
    vi.mocked(getPublicInvoice).mockResolvedValue({
      ...invoice(),
      status: "PAID",
      paymentStatus: "VERIFIED",
      transactionHash: `0x${"a".repeat(64)}`,
      paidAt: new Date().toISOString(),
    });
    paymentState = {
      ...paymentState,
      stage: "paid",
      transactionHash: `0x${"a".repeat(64)}`,
      locked: true,
    };
    render(<PublicInvoiceCheckout publicId={invoice().publicId} />);
    expect(
      await screen.findByRole("heading", { name: "Invoice paid" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Pay 0.1 USDC/ }),
    ).not.toBeInTheDocument();
  });

  it("offers only the External Wallet method on Arc Mainnet", async () => {
    vi.mocked(getPublicInvoice).mockResolvedValue(invoice());
    render(<PublicInvoiceCheckout publicId={invoice().publicId} />);
    const external = await screen.findByRole("radio", {
      name: /External Wallet/,
    });
    expect(external).toHaveAttribute("aria-checked", "true");
    expect(
      screen.queryByRole("radio", { name: /App Wallet/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(external);
    expect(paymentState.selectMethod).toHaveBeenCalledWith("external");
  });

  it("prompts an unconnected payer to connect instead of executing", async () => {
    vi.mocked(getPublicInvoice).mockResolvedValue(invoice());
    render(<PublicInvoiceCheckout publicId={invoice().publicId} />);
    expect(
      await screen.findByRole("button", { name: "Connect External Wallet" }),
    ).toBeInTheDocument();
    expect(paymentState.pay).not.toHaveBeenCalled();
  });

  it("does not expose either payer executor for a paid invoice", async () => {
    vi.mocked(getPublicInvoice).mockResolvedValue({
      ...invoice(),
      status: "PAID",
      paymentStatus: "VERIFIED",
      transactionHash: `0x${"a".repeat(64)}`,
      paidAt: new Date().toISOString(),
    });
    paymentState = { ...paymentState, stage: "paid", locked: true };
    render(<PublicInvoiceCheckout publicId={invoice().publicId} />);
    expect(
      await screen.findByRole("heading", { name: "Invoice paid" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("radiogroup", { name: "Payment method" }),
    ).not.toBeInTheDocument();
    expect(paymentState.pay).not.toHaveBeenCalled();
  });

  it.each(["before", "after"] as const)(
    "ignores the StrictMode aborted request settling %s the replacement succeeds",
    async (order) => {
      const first = deferred<PublicInvoice>();
      const replacement = deferred<PublicInvoice>();
      vi.mocked(getPublicInvoice)
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => replacement.promise);
      render(
        <StrictMode>
          <PublicInvoiceCheckout publicId={invoice().publicId} />
        </StrictMode>,
      );
      expect(getPublicInvoice).toHaveBeenCalledTimes(2);
      expect(vi.mocked(getPublicInvoice).mock.calls[0][1]?.aborted).toBe(true);
      expect(vi.mocked(getPublicInvoice).mock.calls[1][1]?.aborted).toBe(false);

      const abortFirst = async () => {
        await act(async () => {
          first.reject(new DOMException("signal is aborted without reason", "AbortError"));
        });
        expect(screen.queryByText("Payment request unavailable")).not.toBeInTheDocument();
        expect(screen.queryByText("signal is aborted without reason")).not.toBeInTheDocument();
      };
      if (order === "before") await abortFirst();
      await act(async () => replacement.resolve(invoice()));
      expect(await screen.findByText("Test invoice")).toBeInTheDocument();
      if (order === "after") await abortFirst();
      expect(screen.getByText("Test invoice")).toBeInTheDocument();
    },
  );

  it("ignores a stale success while the current invoice is still loading", async () => {
    const first = deferred<PublicInvoice>();
    const replacement = deferred<PublicInvoice>();
    vi.mocked(getPublicInvoice)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => replacement.promise);
    const { rerender } = render(<PublicInvoiceCheckout publicId="first" />);
    rerender(<PublicInvoiceCheckout publicId="replacement" />);
    expect(vi.mocked(getPublicInvoice).mock.calls[0][1]?.aborted).toBe(true);
    await act(async () => first.resolve({ ...invoice(), title: "Stale invoice" }));
    expect(screen.queryByText("Stale invoice")).not.toBeInTheDocument();
    expect(screen.queryByText("Payment request unavailable")).not.toBeInTheDocument();
    await act(async () => replacement.resolve(invoice()));
    expect(await screen.findByText("Test invoice")).toBeInTheDocument();
  });

  it("clears a previous API error when a new load starts and succeeds", async () => {
    const replacement = deferred<PublicInvoice>();
    vi.mocked(getPublicInvoice)
      .mockRejectedValueOnce(new Error("Payment request not found."))
      .mockImplementationOnce(() => replacement.promise);
    const { rerender } = render(<PublicInvoiceCheckout publicId="first" />);
    expect(await screen.findByText("Payment request not found.")).toBeInTheDocument();
    rerender(<PublicInvoiceCheckout publicId="replacement" />);
    expect(screen.queryByText("Payment request unavailable")).not.toBeInTheDocument();
    await act(async () => replacement.resolve(invoice()));
    expect(await screen.findByText("Test invoice")).toBeInTheDocument();
    expect(screen.queryByText("Payment request not found.")).not.toBeInTheDocument();
  });

  it("preserves real API failures in the error state", async () => {
    vi.mocked(getPublicInvoice).mockRejectedValue(
      new Error("Payment request not found."),
    );
    render(<PublicInvoiceCheckout publicId={invoice().publicId} />);
    expect(
      await screen.findByText("Payment request unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("Payment request not found.")).toBeInTheDocument();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function invoice(): PublicInvoice {
  return {
    publicId: "abcdefghijklmnopqrstuv",
    merchantDisplayLabel: null,
    receivingAddress: "0x32F251fc36A1174901124589EAC2d4E391816F69",
    receivingAddressShort: "0x32F2...6F69",
    chain: { id: 5_042, name: "Arc Mainnet" },
    token: {
      symbol: "USDC",
      name: "USD Coin",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
    },
    amount: "0.1",
    amountUnits: "100000",
    title: "Test invoice",
    description: "For testing",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "OPEN",
    paymentStatus: null,
    verificationCode: null,
    transactionHash: null,
    paidAt: null,
  };
}
