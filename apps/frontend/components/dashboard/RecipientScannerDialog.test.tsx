import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecipientScannerDialog } from "./RecipientScannerDialog";

const start = vi.fn();
const stop = vi.fn(async () => undefined);
const clear = vi.fn(async () => undefined);
let successCallback: ((value: string) => void) | null = null;

vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class {
    start = start.mockImplementation(async (_camera, _config, callback) => { successCallback = callback; });
    stop = stop;
    clear = clear;
    scanFile = vi.fn();
  },
}));

describe("RecipientScannerDialog", () => {
  beforeEach(() => { vi.clearAllMocks(); successCallback = null; });

  it("starts camera only after the explicit action and ignores repeated valid scans", async () => {
    const onDetected = vi.fn();
    const onOpenChange = vi.fn();
    render(<RecipientScannerDialog open onOpenChange={onOpenChange} onDetected={onDetected} />);
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    const address = "0x32F251fc36A1174901124589EAC2d4E391816F69";
    successCallback?.(address);
    successCallback?.(address);
    await waitFor(() => expect(onDetected).toHaveBeenCalledOnce());
    expect(onDetected).toHaveBeenCalledWith(expect.objectContaining({ recipient: address, scanned: true }));
    expect(stop).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("rejects arbitrary URLs without navigating", async () => {
    const onDetected = vi.fn();
    render(<RecipientScannerDialog open onOpenChange={vi.fn()} onDetected={onDetected} />);
    fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    successCallback?.("https://evil.example/0x32F251fc36A1174901124589EAC2d4E391816F69");
    expect(await screen.findByText(/Only an EVM address/)).toBeInTheDocument();
    expect(onDetected).not.toHaveBeenCalled();
  });
});
