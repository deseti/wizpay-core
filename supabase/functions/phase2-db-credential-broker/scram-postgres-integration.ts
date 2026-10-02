// Explicit opt-in, isolated PostgreSQL interoperability test. No Supabase
// access, host ports, migrations, persistent volumes or production credentials.
import assert from "node:assert/strict";
import {
  assertCiIsolation,
  assertCiMemberships,
  ROLE_PRIVILEGES,
  type Row,
} from "./database.ts";
import { CI, randomPassword, scramVerifier } from "./security.ts";

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
      `SELECT pg_reload_conf();\nSET password_encryption = 'scram-sha-256';\nCREATE ROLE ${CI.role} WITH ${ROLE_PRIVILEGES} PASSWORD '${verifier}';\nSELECT rolpassword LIKE 'SCRAM-SHA-256$%' AND rolpassword = '${verifier}' FROM pg_authid WHERE rolname = '${CI.role}';\n`,
    );
    assert.equal(
      setup.code,
      0,
      "Role and SCRAM storage verification must succeed",
    );
    assert.equal(new TextDecoder().decode(setup.stdout).trim(), "t\nt");
    const login = await docker(
      psql,
      `\\setenv PGPASSWORD ${password}\n\\connect postgres ${CI.role} 127.0.0.1 5432\nSELECT current_user = '${CI.role}' AND current_database() = 'postgres';\n`,
    );
    assert.equal(
      login.code,
      0,
      "Real PostgreSQL SCRAM authentication must succeed",
    );
    assert.equal(new TextDecoder().decode(login.stdout).trim(), "t");
    const wrong = await docker(
      psql,
      `\\setenv PGPASSWORD synthetic-wrong-password\n\\connect postgres ${CI.role} 127.0.0.1 5432\n`,
    );
    assert.notEqual(
      wrong.code,
      0,
      "Negative control must reject incorrect password",
    );
    // PostgreSQL permission fixture, not an emulation of Vault encryption. No
    // actual password is inserted here. Check real schema/object ACL behavior.
    const fixture = await docker(
      psql,
      `
      CREATE SCHEMA vault;
      CREATE TABLE vault.secrets (name text);
      CREATE VIEW vault.decrypted_secrets AS SELECT name FROM vault.secrets;
      CREATE FUNCTION vault.create_secret(text, text, text) RETURNS void LANGUAGE SQL AS 'SELECT';
      CREATE FUNCTION vault.update_secret(uuid, text) RETURNS void LANGUAGE SQL AS 'SELECT';
      GRANT CONNECT, CREATE ON DATABASE postgres TO ${CI.role};
      GRANT USAGE, CREATE ON SCHEMA public TO ${CI.role};
      GRANT ${CI.role} TO postgres WITH ADMIN TRUE, INHERIT TRUE, SET TRUE;
    `,
    );
    assert.equal(fixture.code, 0, "Vault ACL fixture must initialize");
    const isolationQuery = {
      query: async (
        text: string,
        parameters: (string | number)[] = [],
      ): Promise<Row[]> => {
        assert.deepEqual(parameters, [CI.role]);
        // Exercise server-side parameter typing as well as real ACL catalogs.
        const checked = await docker(
          psql,
          `PREPARE isolation AS ${text};\nEXECUTE isolation('${CI.role}');\n`,
        );
        assert.equal(
          checked.code,
          0,
          "Isolation query must execute on PostgreSQL 17",
        );
        const [vault, provider, privileges] = new TextDecoder().decode(
          checked.stdout,
        ).trim().split("|");
        return [{
          vault_blocked: vault === "t",
          provider_blocked: provider === "t",
          privileges_expected: privileges === "t",
        }];
      },
    };
    await assertCiIsolation(isolationQuery);
    for (
      const statement of [
        "SELECT * FROM vault.secrets",
        "SELECT * FROM vault.decrypted_secrets",
        "SELECT vault.create_secret('synthetic-fixture', 'fixture', 'fixture')",
        "SELECT vault.update_secret('12345678-1234-4234-8234-123456789abc'::uuid, 'synthetic-fixture')",
      ]
    ) {
      const denied = await docker(
        psql,
        `SET ROLE ${CI.role};\n\\set VERBOSITY verbose\n${statement};\n`,
      );
      assert.notEqual(denied.code, 0, "CI role must be denied Vault access");
      assert(
        new TextDecoder().decode(denied.stderr).includes("42501"),
        "Denial must be a permission error",
      );
    }
    const publicLeak = await docker(
      psql,
      "GRANT USAGE ON SCHEMA vault TO PUBLIC;\n",
    );
    assert.equal(publicLeak.code, 0);
    await assert.rejects(() => assertCiIsolation(isolationQuery));
    // Supabase's postgres is not a superuser. Its expected reverse ADMIN grant
    // must suffice for final revocation/drop without elevating the CI login.
    for (
      const [stage, statement] of [
        ["fixture ACL reset", "REVOKE USAGE ON SCHEMA vault FROM PUBLIC"],
        [
          "nonsuperuser setup",
          `CREATE ROLE fixture_admin SUPERUSER LOGIN;
           SET SESSION AUTHORIZATION fixture_admin;
           ALTER ROLE postgres RENAME TO fixture_root;
           CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE;
           ALTER DATABASE postgres OWNER TO postgres;
           REVOKE ${CI.role} FROM fixture_root CASCADE;
           GRANT ${CI.role} TO postgres WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`,
        ],
        [
          "reverse membership reuse",
          `GRANT ${CI.role} TO postgres WITH INHERIT TRUE, SET TRUE`,
        ],
        ["login revocation", `ALTER ROLE ${CI.role} NOLOGIN PASSWORD NULL`],
        ["ownership reassignment", `REASSIGN OWNED BY ${CI.role} TO postgres`],
        ["grant removal", `DROP OWNED BY ${CI.role}`],
        ["role deletion", `DROP ROLE ${CI.role}`],
      ]
    ) {
      const managed = await docker(psql, `${statement};\n`);
      assert.equal(
        managed.code,
        0,
        `Nonsuperuser role-management fixture: ${stage}`,
      );
    }
    const createdByBroker = await docker(
      psql,
      `
      CREATE ROLE ${CI.role} WITH ${ROLE_PRIVILEGES};
      GRANT ${CI.role} TO postgres WITH INHERIT TRUE, SET TRUE;
    `,
    );
    assert.equal(
      createdByBroker.code,
      0,
      "Nonsuperuser creator must establish management grants",
    );
    await assertCiMemberships({
      query: async (
        text: string,
        parameters: (string | number)[] = [],
      ): Promise<Row[]> => {
        assert.deepEqual(parameters, [CI.role]);
        const result = await docker(
          psql,
          `PREPARE memberships AS SELECT COALESCE(json_agg(m), '[]'::json)::text FROM (${text}) m;\nEXECUTE memberships('${CI.role}');\n`,
        );
        assert.equal(result.code, 0, "Membership catalog query must succeed");
        return JSON.parse(
          new TextDecoder().decode(result.stdout).trim(),
        ) as Row[];
      },
    });
  } finally {
    await docker(["rm", "--force", name]);
  }
});
