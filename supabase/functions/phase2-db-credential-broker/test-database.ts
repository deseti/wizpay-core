import assert from "node:assert/strict";
import type { Database, Query, Row } from "./database.ts";
import { CI } from "./security.ts";

export const SECRET_ID = "12345678-1234-4234-8234-123456789abc";
export function managedRow(): Row {
  return {
    oid: 123,
    rolname: CI.role,
    marker: CI.marker,
    rolvaliduntil: null,
    rolcanlogin: true,
    rolinherit: false,
    rolconfig: null,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
  };
}
export class FakeDatabase implements Database {
  statements: string[] = [];
  parameters: (string | number)[][] = [];
  entries: Row[] = [];
  secrets: Row[] = [];
  memberships: Row[] = [];
  publicTypes: Row[] = [];
  relations: Row[] = [];
  functions: Row[] = [];
  owners: Row[] = [];
  schemas: Row[] = [];
  isolation: Row = {
    vault_blocked: true,
    provider_blocked: true,
    privileges_expected: true,
  };
  transactionCount = 0;
  transactionActive = false;
  closed = false;
  verified: { role: string; password: string } | undefined;
  verificationError: Error | undefined;
  async query(
    text: string,
    parameters: (string | number)[] = [],
  ): Promise<Row[]> {
    this.statements.push(text);
    this.parameters.push(parameters);
    if (text.includes("AS vault_blocked")) return [this.isolation];
    if (text.includes("FROM pg_auth_members")) return this.memberships;
    if (text.includes("FROM pg_roles WHERE rolname = $1")) {
      assert.deepEqual(parameters, [CI.role]);
      return this.entries;
    }
    if (text === "SELECT id FROM vault.secrets WHERE name = $1") {
      assert.deepEqual(parameters, [CI.secret]);
      return this.secrets.filter((row) => row.name === parameters[0]).map((
        { id },
      ) => ({ id }));
    }
    if (text.includes("SELECT decrypted_secret FROM vault.decrypted_secrets")) {
      assert.deepEqual(parameters, [SECRET_ID, CI.secret]);
      return this.secrets.filter((row) =>
        row.id === parameters[0] && row.name === parameters[1]
      )
        .map(({ decrypted_secret }) => ({ decrypted_secret }));
    }
    if (text.startsWith("CREATE ROLE")) this.entries = [managedRow()];
    if (text.startsWith("ALTER ROLE")) this.entries[0].rolcanlogin = false;
    if (text.startsWith("DROP ROLE")) this.entries = [];
    if (text.startsWith("SELECT vault.create_secret")) {
      this.secrets.push({
        id: SECRET_ID,
        name: parameters[1],
        decrypted_secret: parameters[0],
      });
      return [{ id: SECRET_ID }];
    }
    if (text.startsWith("DELETE FROM vault.secrets")) {
      assert.deepEqual(parameters, [SECRET_ID, CI.secret]);
      this.secrets = this.secrets.filter((row) => row.name !== CI.secret);
      return [{ id: SECRET_ID }];
    }
    if (text.includes("FROM pg_namespace WHERE nspowner")) return this.schemas;
    if (text.startsWith("DROP SCHEMA")) this.schemas = [];
    if (text.includes("WHERE c.relowner")) return this.relations;
    if (text.includes("WHERE t.typowner")) return this.publicTypes;
    if (text.includes("FROM pg_proc WHERE proowner")) return this.functions;
    if (text.includes("FROM pg_shdepend WHERE")) return this.owners;
    return await Promise.resolve([]);
  }
  async transaction<T>(work: (query: Query) => Promise<T>): Promise<T> {
    this.transactionCount++;
    const snapshot = structuredClone({
      entries: this.entries,
      secrets: this.secrets,
      schemas: this.schemas,
      memberships: this.memberships,
      publicTypes: this.publicTypes,
    });
    this.transactionActive = true;
    try {
      return await work(this);
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    } finally {
      this.transactionActive = false;
    }
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  verifyCredentials(role: string, password: string): Promise<void> {
    assert.equal(
      this.transactionActive,
      false,
      "New role must commit before direct login",
    );
    assert.equal(role, CI.role);
    assert.equal(this.entries[0].rolcanlogin, true);
    assert.equal(
      this.secrets.find((row) => row.name === CI.secret)?.decrypted_secret,
      password,
    );
    this.verified = { role, password };
    return this.verificationError
      ? Promise.reject(this.verificationError)
      : Promise.resolve();
  }
}
