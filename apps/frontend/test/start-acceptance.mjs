// Run the real Next standalone build using only local acceptance configuration.
import { cpSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(root, ".next/standalone/apps/frontend");
cpSync(join(root, "public"), join(standalone, "public"), { recursive: true });
cpSync(join(root, ".next/static"), join(standalone, ".next/static"), {
  recursive: true,
});
const child = spawn(process.execPath, [join(standalone, "server.js")], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: "3108",
    HOSTNAME: "127.0.0.1",
  },
  stdio: "inherit",
});
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
