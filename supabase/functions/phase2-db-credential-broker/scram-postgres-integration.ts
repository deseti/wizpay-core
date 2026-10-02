// Explicit opt-in, isolated PostgreSQL interoperability test. No Supabase
// access, host ports, migrations, persistent volumes or production credentials.
import assert from "node:assert/strict";
import { randomPassword, scramVerifier } from "./security.ts";

const encoder = new TextEncoder();
async function docker(args: string[], input?: string) {
  const child = new Deno.Command("env", {
    args: [
      "-u",
      "DOCKER_HOST",
      "-u",
      "DOCKER_CONTEXT",
      "-u",
      "DOCKER_TLS",
      "-u",
      "DOCKER_TLS_VERIFY",
      "-u",
      "DOCKER_CERT_PATH",
      "docker",
      "--host=unix:///var/run/docker.sock",
      ...args,
    ],
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(encoder.encode(input));
    await writer.close();
  }
  return await child.output(); // Never publish SQL/driver output on failure.
}

Deno.test("hand-built verifier authenticates against PostgreSQL 17 and stored credential is SCRAM", async () => {
  const name = `wizpay-p2-scram-${crypto.randomUUID()}`;
  const password = randomPassword();
  const verifier = await scramVerifier(password);
  try {
    const started = await docker([
      "run",
      "--pull=never",
      "--detach",
      "--rm",
      "--network=none",
      "--name",
      name,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "-e",
      "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
      "public.ecr.aws/docker/library/postgres:17",
      "-c",
      "log_statement=none",
      "-c",
      "log_min_error_statement=panic",
    ]);
    assert.equal(started.code, 0, "Isolated PostgreSQL must start");
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await docker([
        "exec",
        name,
        "pg_isready",
        "-U",
        "postgres",
      ]);
      if (result.code === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert(ready, "Isolated PostgreSQL must become ready");
    // Override the image's appended trust rule. Unix socket administration is
    // local only; TCP login must use SCRAM, verified by the negative control.
    const hba = await docker([
      "exec",
      "-i",
      name,
      "sh",
      "-c",
      "cat > /var/lib/postgresql/data/pg_hba.conf",
    ], "local all all trust\nhost all all 127.0.0.1/32 scram-sha-256\n");
    assert.equal(hba.code, 0);
    const psql = [
      "exec",
      "-i",
      name,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
    ];
    const setup = await docker(
      psql,
      `SELECT pg_reload_conf();\nSET password_encryption = 'scram-sha-256';\nCREATE ROLE wizpay_p2_12345_1 LOGIN PASSWORD '${verifier}';\nSELECT rolpassword LIKE 'SCRAM-SHA-256$%' AND rolpassword = '${verifier}' FROM pg_authid WHERE rolname = 'wizpay_p2_12345_1';\n`,
    );
    assert.equal(
      setup.code,
      0,
      "Role and SCRAM storage verification must succeed",
    );
    assert.equal(new TextDecoder().decode(setup.stdout).trim(), "t\nt");
    const login = await docker(
      psql,
      `\\setenv PGPASSWORD ${password}\n\\connect postgres wizpay_p2_12345_1 127.0.0.1 5432\nSELECT current_user = 'wizpay_p2_12345_1' AND current_database() = 'postgres';\n`,
    );
    assert.equal(
      login.code,
      0,
      "Real PostgreSQL SCRAM authentication must succeed",
    );
    assert.equal(new TextDecoder().decode(login.stdout).trim(), "t");
    const wrong = await docker(
      psql,
      "\\setenv PGPASSWORD synthetic-wrong-password\n\\connect postgres wizpay_p2_12345_1 127.0.0.1 5432\n",
    );
    assert.notEqual(
      wrong.code,
      0,
      "Negative control must reject incorrect password",
    );
  } finally {
    await docker(["rm", "--force", name]);
  }
});
