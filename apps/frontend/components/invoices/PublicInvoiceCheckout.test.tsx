import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicInvoiceCheckout } from "./PublicInvoiceCheckout";
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
vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: {
    Custom: ({
      children,
    }: {
      children: (value: {
        mounted: boolean;
        openConnectModal: () => void;
      }) => React.ReactNode;
    }) => children({ mounted: true, openConnectModal: vi.fn() }),
  },
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
    expect(screen.getByText(/Arc Testnet · 5042002/)).toBeInTheDocument();
    expect(
      container
        .querySelector('[data-token-icon="USDC"] img')
        ?.getAttribute("src"),
    ).toMatch(/\/tokens\/usdc\.png$/);
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

  it("shows both payer choices and permits method switching before submission", async () => {
    vi.mocked(getPublicInvoice).mockResolvedValue(invoice());
    render(<PublicInvoiceCheckout publicId={invoice().publicId} />);
    const app = await screen.findByRole("radio", { name: /App Wallet/ });
    const external = screen.getByRole("radio", { name: /External Wallet/ });
    expect(app).toHaveAttribute("aria-checked", "false");
    expect(external).toHaveAttribute("aria-checked", "true");

    fireEvent.click(app);
    expect(paymentState.selectMethod).toHaveBeenCalledWith("app");
    fireEvent.click(external);
    expect(paymentState.selectMethod).toHaveBeenCalledWith("external");
  });

  it("uses the selected App Wallet action and locks both choices after submission", async () => {
    vi.mocked(getPublicInvoice).mockResolvedValue(invoice());
    paymentState = {
      ...paymentState,
      method: "app",
      appAuthenticated: true,
      locked: true,
      stage: "awaiting_signature",
      canContinueAppAuthorization: true,
    };
    render(<PublicInvoiceCheckout publicId={invoice().publicId} />);
    expect(await screen.findByRole("radio", { name: /App Wallet/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /External Wallet/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Authorize existing payment" }));
    expect(paymentState.continueAppAuthorization).toHaveBeenCalledTimes(1);
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
    expect(await screen.findByRole("heading", { name: "Invoice paid" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Payment method" })).not.toBeInTheDocument();
    expect(paymentState.pay).not.toHaveBeenCalled();
  });

  it("shows a safe not-found/error state", async () => {
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

function invoice(): PublicInvoice {
  return {
    publicId: "abcdefghijklmnopqrstuv",
    merchantDisplayLabel: null,
    receivingAddress: "0x32F251fc36A1174901124589EAC2d4E391816F69",
    receivingAddressShort: "0x32F2...6F69",
    chain: { id: 5_042_002, name: "Arc Testnet" },
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
