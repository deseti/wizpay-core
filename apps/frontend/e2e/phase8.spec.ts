import { expect, test } from "@playwright/test";

// Actual production Next bundle; only remote dependencies are synthetic.
// No wallet is funded and no transaction can leave this browser.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const address = "0x1000000000000000000000000000000000000001";
    window.sessionStorage.setItem(
      `wizpay.wallet-auth.v1:${address}`,
      JSON.stringify({
        address,
        chainId: 5042,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        sessionToken: "synthetic-browser-session",
        userId: "synthetic-browser-owner",
      }),
    );
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const provider = {
      isMetaMask: true,
      request: async ({ method }: { method: string }) => {
        if (["eth_accounts", "eth_requestAccounts"].includes(method))
          return [address];
        if (method === "eth_chainId") return "0x13b2";
        if (method === "wallet_switchEthereumChain") return null;
        if (/send|sign|approve/i.test(method))
          throw Object.assign(new Error("User rejected request"), {
            code: 4001,
          });
        return "0x0";
      },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(listener);
      },
      removeListener: (
        event: string,
        listener: (...args: unknown[]) => void,
      ) => {
        listeners[event] = (listeners[event] ?? []).filter(
          (value) => value !== listener,
        );
      },
    };
    Object.defineProperty(window, "ethereum", { value: provider });
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: {
            info: {
              uuid: "7ca73f50-f64e-4e86-8350-d60dfc5d40d5",
              name: "Phase 8 Offline Wallet",
              icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
              rdns: "test.wizpay.offline",
            },
            provider,
          },
        }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" && url.port === "3108")
      return route.continue();
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "http://127.0.0.1:3108",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        },
      });
    }
    if (url.pathname === "/capabilities") {
      return route.fulfill({
        headers: { "access-control-allow-origin": "http://127.0.0.1:3108" },
        json: {
          data: {
            network: "arc-mainnet",
            capabilities: {
              send: true,
              sameTokenPayroll: true,
              invoice: true,
              paymentLink: true,
              bridge: true,
              swap: true,
              crossTokenPayroll: true,
              liquidity: false,
              crossTokenInvoice: false,
              nanoAgentApi: false,
            },
          },
        },
      });
    }
    if (url.pathname === "/public/invoices/AAAAAAAAAAAAAAAAAAAAAA") {
      return route.fulfill({
        headers: { "access-control-allow-origin": "http://127.0.0.1:3108" },
        json: {
          data: {
            publicId: "AAAAAAAAAAAAAAAAAAAAAA",
            settlementOperation: "PAYMENT_LINK_SETTLEMENT",
            receivingAddress: "0x1000000000000000000000000000000000000001",
            receivingAddressShort: "0x1000...0001",
            merchantDisplayLabel: null,
            chain: { id: 5042, name: "Arc Mainnet" },
            token: {
              symbol: "USDC",
              name: "USD Coin",
              address: "0x3600000000000000000000000000000000000000",
              decimals: 6,
            },
            amount: "0.01",
            amountUnits: "10000",
            title: "Synthetic checkout",
            status: "OPEN",
            paymentStatus: null,
            transactionHash: null,
            description: null,
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            verificationCode: null,
            paidAt: null,
          },
        },
      });
    }
    const localResponses: Record<string, unknown> = {
      "/invoices": { items: [], total: 0, limit: 20, offset: 0 },
      "/activities": { items: [], nextCursor: null },
      "/activities/sync": { status: "synced", recordsAccepted: 0 },
    };
    if (
      url.hostname === "127.0.0.1" &&
      url.port === "4000" &&
      url.pathname in localResponses
    ) {
      return route.fulfill({
        headers: { "access-control-allow-origin": "http://127.0.0.1:3108" },
        json: { data: localResponses[url.pathname] },
      });
    }
    if (url.hostname === "127.0.0.1" && url.port === "4000") {
      return route.fulfill({
        headers: { "access-control-allow-origin": "http://127.0.0.1:3108" },
        status: 401,
        json: { message: "Wallet authentication required" },
      });
    }
    // Wallet discovery/provider services are offline in this pass. No remote
    // request (in particular eth_sendTransaction) reaches a real provider.
    return route.fulfill({
      headers: { "access-control-allow-origin": "http://127.0.0.1:3108" },
      status: 200,
      json: {},
    });
  });
});

test("stable pages, wallet surface and public checkout remain usable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const path of [
    "/",
    "/send",
    "/payroll",
    "/invoices",
    "/invoices/new",
    "/swap",
    "/bridge",
    "/assets",
    "/profile",
  ]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("main").first()).toBeVisible();
    await expect(
      page
        .getByRole("button", { name: "Account and wallet menu" })
        .or(page.getByRole("link", { name: "Open account" })),
    ).toBeVisible();
    const headings: Record<string, RegExp> = {
      "/send": /^Send$/,
      "/payroll": /Payroll/,
      "/invoices": /^Invoices$/,
      "/invoices/new": /New invoice/,
      "/swap": /Swap & Bridge/,
      "/bridge": /Swap & Bridge/,
      "/assets": /Assets/,
    };
    if (headings[path])
      await expect(
        page.getByRole("heading", { name: headings[path] }).first(),
      ).toBeVisible();
    if (path === "/invoices/new") {
      await page.getByLabel("Fixed amount").fill("0.01");
      await page.getByLabel("Customer-facing title").fill("Synthetic request");
      await expect(page.getByLabel("Fixed amount")).toHaveValue("0.01");
      await page
        .getByLabel("Payment request type")
        .selectOption("PAYMENT_LINK");
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.goto("/pay/AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByText("Synthetic checkout")).toBeVisible();
  await expect(page.getByText("0.01", { exact: false }).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: /pay/i }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("PWA installation resources are available without changing network identity", async ({
  request,
}) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).name).toContain("WizPay");
  const worker = await request.get("/sw.js");
  expect(worker.status()).toBe(200);
  expect(await worker.text()).toContain("fetch");
});

test("navigation actions and swap/bridge tabs are reachable", async ({
  page,
}, info) => {
  await page.goto("/");
  await expect(
    page
      .getByRole("button", { name: "Account and wallet menu" })
      .or(page.getByRole("link", { name: "Open account" })),
  ).toBeVisible();
  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "Quick actions" }).click();
    await expect(page.getByText("Scan QR", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Send One recipient" }).click();
  } else {
    await page.getByRole("link", { name: "Send", exact: true }).first().click();
  }
  await expect(page).toHaveURL(/\/send$/);
  await page.goto("/swap");
  await page.getByRole("tab", { name: "Bridge", exact: true }).click();
  await expect(page).toHaveURL(/\/bridge$/);
  await page.getByRole("tab", { name: "Swap", exact: true }).click();
  await expect(page).toHaveURL(/\/swap$/);
});
