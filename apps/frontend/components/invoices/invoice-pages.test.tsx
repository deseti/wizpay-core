import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InvoicesPage from "@/app/invoices/page";
import NewInvoicePage from "@/app/invoices/new/page";
import InvoiceDetailPage from "@/app/invoices/[id]/page";
import {
  cancelInvoice,
  createInvoice,
  getMerchantInvoice,
  listInvoices,
  type MerchantInvoice,
} from "@/lib/invoice-api";
import QRCode from "qrcode";

vi.mock("@/components/providers/CircleWalletProvider", () => ({
  useCircleWallet: () => ({
    authMethod: "email",
    userToken: "circle-user-token",
    ready: true,
  }),
}));
vi.mock("@/components/providers/HybridWalletProvider", () => ({
  useHybridWallet: () => ({
    walletMode: "circle",
    setWalletMode: vi.fn(),
    isActiveWalletConnected: true,
    isReady: true,
  }),
}));
vi.mock("@/components/dashboard/DashboardAppFrame", () => ({
  DashboardAppFrame: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "3fcbcc73-3471-4e64-8dda-63c12ebf6c3c" }),
  usePathname: () => "/invoices",
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,qr") },
}));
vi.mock("@/lib/invoice-api", async (original) => ({
  ...(await original<typeof import("@/lib/invoice-api")>()),
  listInvoices: vi.fn(),
  createInvoice: vi.fn(),
  getMerchantInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
}));

describe("merchant invoice pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(QRCode.toDataURL).mockResolvedValue("data:image/png;base64,qr");
    vi.mocked(listInvoices).mockResolvedValue({
      items: [merchantInvoice()],
      total: 1,
      limit: 10,
      offset: 0,
    });
    vi.mocked(createInvoice).mockResolvedValue(merchantInvoice());
    vi.mocked(getMerchantInvoice).mockResolvedValue(merchantInvoice());
    vi.mocked(cancelInvoice).mockResolvedValue({
      ...merchantInvoice(),
      status: "CANCELLED",
    });
  });

  it("lists only API-returned merchant invoices with status, amount, token icon, links, and pagination", async () => {
    const { container } = render(<InvoicesPage />);
    expect(await screen.findByText("Customer invoice")).toBeInTheDocument();
    expect(screen.getByText("OPEN")).toBeInTheDocument();
    expect(screen.getByText("0.1 USDC")).toBeInTheDocument();
    expect(container.querySelector('[data-token-icon="USDC"]')).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy link" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1-1 of 1")).toBeInTheDocument();
    expect(listInvoices).toHaveBeenCalledWith("circle-user-token", {
      status: undefined,
      limit: 10,
      offset: 0,
    });
  });

  it("creates an exact fixed invoice and shows local share/QR success actions", async () => {
    render(<NewInvoicePage />);
    fireEvent.change(screen.getByLabelText("Fixed amount"), {
      target: { value: "12.345678" },
    });
    fireEvent.change(screen.getByLabelText("Customer-facing title"), {
      target: { value: "Customer invoice" },
    });
    fireEvent.change(screen.getByLabelText("Description (optional)"), {
      target: { value: "Services rendered" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() =>
      expect(createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "USDC",
          amount: "12.345678",
          title: "Customer invoice",
          description: "Services rendered",
        }),
        "circle-user-token",
      ),
    );
    expect(
      await screen.findByText("Invoice ready to share"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open checkout" })).toHaveAttribute(
      "href",
      "/pay/abcdefghijklmnopqrstuv",
    );
  });

  it("starts with an empty amount and keeps the preview neutral until a valid amount is entered", () => {
    render(<NewInvoicePage />);
    expect(screen.getByLabelText("Fixed amount")).toHaveValue("");
    expect(screen.getByPlaceholderText("Enter amount")).toBeInTheDocument();
    expect(screen.getByText("Enter amount", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("0.1")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Fixed amount"), {
      target: { value: "1.2345678" },
    });
    expect(screen.getByText("Enter amount", { selector: "strong" })).toBeInTheDocument();
  });

  it("accepts an explicitly entered arbitrary EURC amount", async () => {
    render(<NewInvoicePage />);
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "EURC" } });
    fireEvent.change(screen.getByLabelText("Fixed amount"), { target: { value: "98.765432" } });
    fireEvent.change(screen.getByLabelText("Customer-facing title"), { target: { value: "EURC invoice" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));

    await waitFor(() => expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ token: "EURC", amount: "98.765432", title: "EURC invoice" }),
      "circle-user-token",
    ));
  });

  it("renders immutable detail and permits cancellation only while open", async () => {
    render(<InvoiceDetailPage />);
    expect(await screen.findByText("Customer invoice")).toBeInTheDocument();
    expect(screen.getByText("100000")).toBeInTheDocument();
    expect(
      screen.getByText("0x3600000000000000000000000000000000000000"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel invoice" }));
    await waitFor(() =>
      expect(cancelInvoice).toHaveBeenCalledWith(
        "3fcbcc73-3471-4e64-8dda-63c12ebf6c3c",
        "circle-user-token",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Cancel invoice" }),
      ).not.toBeInTheDocument(),
    );
  });
});

function merchantInvoice(): MerchantInvoice {
  return {
    id: "3fcbcc73-3471-4e64-8dda-63c12ebf6c3c",
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
    title: "Customer invoice",
    description: "Services rendered",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    status: "OPEN",
    paymentStatus: null,
    verificationCode: null,
    transactionHash: null,
    paidAt: null,
    invoiceNumber: "INV-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cancelledAt: null,
    payerAddress: null,
  };
}
