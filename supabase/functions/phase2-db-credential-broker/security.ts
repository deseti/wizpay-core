export const TARGET = Object.freeze({
  project: "tsvzblikmgocgksgxguc",
  pooler: "aws-0-ap-southeast-1.pooler.supabase.com",
  database: "postgres",
  issuer: "https://token.actions.githubusercontent.com",
  audience: "wizpay-phase2-supabase",
  repository: "deseti/wizpay-core",
  ref: "refs/heads/feat/serverless-free-stack",
  workflow:
    "deseti/wizpay-core/.github/workflows/phase2-supabase-validation.yml@refs/heads/feat/serverless-free-stack",
  jwks: "https://token.actions.githubusercontent.com/.well-known/jwks",
  caUrl:
    "https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt",
  caFingerprint:
    "807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA",
});
export const ROLE_TTL_SECONDS = 30 * 60;
export type RunIdentity = { runId: string; attempt: string };
export class Denied extends Error {
  constructor() {
    super("Request denied");
  }
}
export function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new Denied();
}
export function record(value: unknown): Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function bytes(encoded: string): Uint8Array<ArrayBuffer> {
  requireCondition(
    /^[A-Za-z0-9_-]+$/.test(encoded) && encoded.length % 4 !== 1,
  );
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (value) => value.charCodeAt(0));
}
function json(encoded: string) {
  return record(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes(encoded)),
    ),
  );
}
export function runIdentity(runId: unknown, attempt: unknown): RunIdentity {
  requireCondition(
    typeof runId === "string" && /^[1-9][0-9]{0,19}$/.test(runId),
  );
  requireCondition(
    typeof attempt === "string" && /^[1-9][0-9]{0,5}$/.test(attempt),
  );
  return { runId, attempt };
}
export function roleName(identity: RunIdentity): string {
  const run = runIdentity(identity.runId, identity.attempt);
  const role = `wizpay_p2_${run.runId}_${run.attempt}`;
  requireCondition(role.length <= 63);
  return role;
}
export function marker(identity: RunIdentity): string {
  return `wizpay-phase2-broker:v1:${roleName(identity)}`;
}
export function managedIdentity(name: string): RunIdentity {
  const match = /^wizpay_p2_([1-9][0-9]{0,19})_([1-9][0-9]{0,5})$/.exec(name);
  requireCondition(match);
  return runIdentity(match[1], match[2]);
}
export function expiresAt(now = Date.now()): Date {
  return new Date(now + ROLE_TTL_SECONDS * 1000);
}

// Only this fixed JWKS origin is trusted. Header jku/x5u never select keys.
export async function verifyOidc(
  token: string,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000),
): Promise<RunIdentity> {
  try {
    requireCondition(token.length <= 16_384);
    const parts = token.split(".");
    requireCondition(parts.length === 3);
    const header = json(parts[0]);
    requireCondition(header.alg === "RS256" && header.typ === "JWT");
    requireCondition(
      typeof header.kid === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(header.kid),
    );
    requireCondition(header.crit === undefined && header.b64 === undefined);
    const response = await fetcher(TARGET.jwks, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    requireCondition(response.ok);
    const document = record(await response.json());
    requireCondition(
      Array.isArray(document.keys) && document.keys.length <= 20,
    );
    const candidates = document.keys.map(record).filter((key) =>
      key.kid === header.kid
    );
    requireCondition(candidates.length === 1);
    const jwk = candidates[0];
    requireCondition(
      jwk.kty === "RSA" && (jwk.alg === undefined || jwk.alg === "RS256") &&
        jwk.use === "sig",
    );
    requireCondition(typeof jwk.n === "string" && typeof jwk.e === "string");
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    requireCondition(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        bytes(parts[2]),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ),
    );
    const claims = json(parts[1]);
    requireCondition(
      claims.iss === TARGET.issuer && claims.aud === TARGET.audience,
    );
    requireCondition(
      claims.repository === TARGET.repository && claims.ref === TARGET.ref,
    );
    requireCondition(
      claims.sub === `repo:${TARGET.repository}:ref:${TARGET.ref}`,
    );
    requireCondition(claims.workflow_ref === TARGET.workflow);
    requireCondition(
      claims.job_workflow_ref === undefined ||
        claims.job_workflow_ref === TARGET.workflow,
    );
    requireCondition(
      claims.event_name === "push" || claims.event_name === "workflow_dispatch",
    );
    for (const key of ["exp", "iat", "nbf"]) {
      requireCondition(
        typeof claims[key] === "number" && Number.isSafeInteger(claims[key]),
      );
    }
    const expiry = claims.exp as number,
      issued = claims.iat as number,
      notBefore = claims.nbf as number;
    requireCondition(expiry > now && issued <= now + 30 && issued >= now - 600);
    requireCondition(
      notBefore <= now + 30 && notBefore <= expiry && expiry > issued &&
        expiry - issued <= 600,
    );
    return runIdentity(claims.run_id, claims.run_attempt);
  } catch {
    throw new Denied();
  }
}

function base64(value: Uint8Array<ArrayBuffer>): string {
  return btoa(String.fromCharCode(...value));
}
export function randomPassword(): string {
  return base64(crypto.getRandomValues(new Uint8Array(48))).replaceAll("+", "-")
    .replaceAll("/", "_").replaceAll("=", "");
}
// Utility DDL cannot bind PASSWORD parameters. Send only a SCRAM verifier to
// PostgreSQL so statement/audit logs never receive the plaintext password.
export async function scramVerifier(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const salted = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 16_384, hash: "SHA-256" },
    key,
    256,
  );
  const hmac = await crypto.subtle.importKey(
    "raw",
    salted,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const clientKey = await crypto.subtle.sign(
    "HMAC",
    hmac,
    new TextEncoder().encode("Client Key"),
  );
  const stored = await crypto.subtle.digest("SHA-256", clientKey);
  const server = await crypto.subtle.sign(
    "HMAC",
    hmac,
    new TextEncoder().encode("Server Key"),
  );
  return `SCRAM-SHA-256$16384:${base64(salt)}$${
    base64(new Uint8Array(stored))
  }:${base64(new Uint8Array(server))}`;
}
export function connectionUrls(role: string, password: string) {
  managedIdentity(role);
  const make = (port: number) => {
    const url = new URL(
      `postgresql://${TARGET.pooler}:${port}/${TARGET.database}`,
    );
    url.username = `${role}.${TARGET.project}`;
    url.password = password;
    url.searchParams.set("sslmode", "verify-full");
    return url.toString();
  };
  return { sessionUrl: make(5432), transactionUrl: make(6543) };
}
