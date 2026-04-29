// Stub for viem/ox tempo virtualMasterPool — the real module uses a dynamic
// require() that webpack can't statically analyse, causing a TDZ circular
// dependency crash at runtime.  Nothing in WizPay uses the Tempo chain, so
// replacing it with an empty module is safe.
export async function resolve() {
  throw new Error("Tempo chain is not supported in this build.");
}

export async function resolveNode() {
  throw new Error("Tempo chain is not supported in this build.");
}

export async function resolveBrowser() {
  throw new Error("Tempo chain is not supported in this build.");
}
