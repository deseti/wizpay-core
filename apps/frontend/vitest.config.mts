import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      react: path.resolve(import.meta.dirname, "../../node_modules/react"),
      "react-dom": path.resolve(
        import.meta.dirname,
        "../../node_modules/react-dom",
      ),
    },
    dedupe: ["react", "react-dom"],
    tsconfigPaths: true,
  },
  test: {
    clearMocks: true,
    env: {
      NEXT_PUBLIC_WIZPAY_ARC_NETWORK:
        process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK ?? "arc-mainnet",
    },
    environment: "jsdom",
    globals: true,
    hookTimeout: 10_000,
    include: ["**/*.test.{ts,tsx}"],
    mockReset: true,
    restoreMocks: true,
    sequence: {
      concurrent: false,
    },
    setupFiles: ["./test/setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 15_000,
  },
});
