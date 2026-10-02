import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SETTINGS = Object.freeze({
  audience: "wizpay-phase2-supabase",
  project: "tsvzblikmgocgksgxguc",
  host: "aws-0-ap-southeast-1.pooler.supabase.com",
  endpoint:
    "https://tsvzblikmgocgksgxguc.supabase.co/functions/v1/phase2-db-credential-broker",
  caUrl:
    "https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt",
  fingerprint:
    "807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA",
});

export function mask(value) {
  // This is a runner control command, never ordinary log output. Escape every
  // command metacharacter so returned data cannot inject workflow commands.
  process.stdout.write(
    `::add-mask::${String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`,
  );
}
export async function requestOidc(environment, fetcher = fetch, masker = mask) {
  assert(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  const url = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.equal(url.protocol, "https:");
  assert(url.hostname.endsWith(".actions.githubusercontent.com"));
  url.searchParams.set("audience", SETTINGS.audience);
  const response = await fetcher(url, {
    headers: {
      authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok);
  const body = await response.json();
  assert(typeof body.value === "string" && body.value.length <= 16_384);
  masker(body.value);
  return body.value;
}
export async function brokerRequest(
  action,
  environment,
  fetcher = fetch,
  masker = mask,
) {
  assert(["bootstrap", "cleanup"].includes(action));
  const jwt = await requestOidc(environment, fetcher, masker);
  const response = await fetcher(SETTINGS.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action }),
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  });
  assert(response.ok);
  const body = await response.json();
  if (action === "bootstrap") {
    // Mask both raw URLs before parsing or invoking any subsequent command.
    assert(
      typeof body.sessionUrl === "string" &&
        typeof body.transactionUrl === "string",
    );
    masker(body.sessionUrl);
    masker(body.transactionUrl);
    for (const value of [body.sessionUrl, body.transactionUrl]) {
      const url = new URL(value);
      masker(url.password);
      masker(decodeURIComponent(url.password));
    }
    assert(typeof body.role === "string");
    masker(body.role);
  }
  return body;
}
export function verifyCertificate(pem, now = Date.now()) {
  const certificate = new X509Certificate(pem);
  assert.equal(
    certificate.fingerprint256.replaceAll(":", "").toUpperCase(),
    SETTINGS.fingerprint.toUpperCase(),
  );
  assert(
    certificate.ca &&
      Date.parse(certificate.validFrom) <= now &&
      Date.parse(certificate.validTo) > now,
  );
  return pem;
}
export function validationEnvironment(
  body,
  environment,
  certificatePath,
  now = Date.now(),
) {
  assert(/^[1-9][0-9]{0,19}$/.test(environment.GITHUB_RUN_ID));
  assert(/^[1-9][0-9]{0,5}$/.test(environment.GITHUB_RUN_ATTEMPT));
  assert.equal(
    body.role,
    `wizpay_p2_${environment.GITHUB_RUN_ID}_${environment.GITHUB_RUN_ATTEMPT}`,
  );
  const expiry = Date.parse(body.expiresAt);
  assert(expiry > now && expiry <= now + 30 * 60 * 1000 + 30_000);
  const urls = [body.sessionUrl, body.transactionUrl].map((value, index) => {
    const url = new URL(value);
    assert.equal(url.protocol, "postgresql:");
    assert.equal(url.hostname, SETTINGS.host);
    assert.equal(url.port, index === 0 ? "5432" : "6543");
    assert.equal(url.pathname, "/postgres");
    assert.equal(
      decodeURIComponent(url.username),
      `${body.role}.${SETTINGS.project}`,
    );
    assert(url.password.length >= 48);
    assert.equal(url.searchParams.get("sslmode"), "verify-full");
    assert.deepEqual([...url.searchParams.keys()], ["sslmode"]);
    url.searchParams.set("sslrootcert", certificatePath);
    return url;
  });
  assert.equal(urls[0].password, urls[1].password);
  const child = { ...environment };
  for (const key of [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "DATABASE_URL",
    "DIRECT_URL",
    "ARC_MAINNET_DATABASE_URL",
    "ARC_MAINNET_MIGRATION_DATABASE_URL",
    "EXECUTION_INTENT_TEST_DATABASE_URL",
    "PHASE7_TEST_DATABASE_URL",
    "WIZPAY_EXTERNAL_TEST_CA_PEM",
  ])
    delete child[key];
  return {
    ...child,
    WIZPAY_DATABASE_PROFILE: "supavisor-transaction",
    WIZPAY_MIGRATION_DATABASE_MODE: "session",
    WIZPAY_ARC_NETWORK: "arc-mainnet",
    WIZPAY_MIGRATION_NETWORK: "arc-mainnet",
    WIZPAY_EXTERNAL_TEST_TARGET_HOST: SETTINGS.host,
    WIZPAY_EXTERNAL_TEST_RUNTIME_TARGET_HOST: SETTINGS.host,
    WIZPAY_EXTERNAL_TEST_TARGET_DATABASE: "postgres",
    WIZPAY_EXTERNAL_TEST_ACK: "ISOLATED_NONPRODUCTION_SCHEMA",
    WIZPAY_EXTERNAL_TEST_DATABASE_URL: urls[0].toString(),
    WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL: urls[1].toString(),
  };
}

export async function run(
  action,
  environment = process.env,
  fetcher = fetch,
  masker = mask,
  execute = spawnSync,
) {
  const body = await brokerRequest(action, environment, fetcher, masker);
  if (action === "cleanup") {
    assert.equal(body.cleaned, true);
    console.log("Phase 2 temporary role cleanup PASS.");
    return;
  }
  let directory;
  try {
    const response = await fetcher(SETTINGS.caUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    assert(response.ok);
    const ca = verifyCertificate(await response.text());
    directory = await mkdtemp(join(tmpdir(), "wizpay-p2-ci-ca-"));
    const path = join(directory, "root.crt");
    await writeFile(path, ca, { mode: 0o600 });
    const child = validationEnvironment(body, environment, path);
    const result = execute(
      "npm",
      [
        "exec",
        "-w",
        "backend",
        "--",
        "ts-node",
        "test/validate-live-supabase.ts",
      ],
      { env: child, stdio: "inherit", timeout: 20 * 60 * 1000 },
    );
    assert(!result.error && result.status === 0);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run(process.argv[2]).catch(() => {
    // Never stringify network errors: fetch errors can contain bearer request
    // URLs or broker response data. No raw response is persisted anywhere.
    console.error(
      "Phase 2 OIDC bootstrap/cleanup failed; no credential details logged.",
    );
    process.exitCode = 1;
  });
}
