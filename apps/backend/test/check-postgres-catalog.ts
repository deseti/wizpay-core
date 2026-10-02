import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { externalTestConnection, migrationsRoot } from './postgres-harness';

/** Read-only catalog check against the canonical migration, not a copied schema. */
export async function checkPostgresCatalog(
  client: Client,
  schema: string,
  history = false,
) {
  const entries = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const migrations = await Promise.all(
    entries.map(async (entry) => ({
      name: entry.name,
      sql: await readFile(
        join(migrationsRoot, entry.name, 'migration.sql'),
        'utf8',
      ),
    })),
  );
  const sql = migrations.map((migration) => migration.sql).join('\n');
  const tables = [...sql.matchAll(/CREATE TABLE "([^"]+)" \(([\s\S]*?)\n\);/g)];
  const tableRows = (
    await client.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1',
      [schema],
    )
  ).rows.map((row) => row.tablename);
  for (const [, table, definition] of tables) {
    assert(tableRows.includes(table), `Missing application table: ${table}`);
    const columns = (
      await client.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
        udt_name: string;
        datetime_precision: number | null;
      }>(
        `SELECT column_name, is_nullable, column_default, udt_name, datetime_precision
      FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [schema, table],
      )
    ).rows;
    const expectedColumns = [
      ...definition.matchAll(/^ {4}"([^"]+)" ([^\n]+),?$/gm),
    ];
    assert.equal(
      columns.length,
      expectedColumns.length,
      `Column count: ${table}`,
    );
    for (const [, name, ddl] of expectedColumns) {
      const column = columns.find((row) => row.column_name === name);
      assert(column, `Missing column: ${table}.${name}`);
      const sqlType = ddl.split(/ NOT NULL| DEFAULT|,$/)[0].replaceAll('"', '');
      const expectedType =
        sqlType === 'INTEGER'
          ? 'int4'
          : sqlType === 'TIMESTAMP(3)'
            ? 'timestamp'
            : ['UUID', 'TEXT', 'JSONB'].includes(sqlType)
              ? sqlType.toLowerCase()
              : sqlType;
      assert.equal(column.udt_name, expectedType, `Type: ${table}.${name}`);
      if (sqlType === 'TIMESTAMP(3)')
        assert.equal(column.datetime_precision, 3);
      assert.equal(
        column.is_nullable,
        ddl.includes('NOT NULL') ? 'NO' : 'YES',
        `Nullability: ${table}.${name}`,
      );
      const expectedDefault = ddl.match(/DEFAULT (.*?)(?:,)?$/)?.[1] ?? null;
      const actualDefault = column.column_default?.split('::')[0] ?? null;
      assert.equal(actualDefault, expectedDefault, `Default: ${table}.${name}`);
    }
  }
  const indexes = (
    await client.query<{ name: string; unique: boolean; definition: string }>(
      `SELECT c.relname AS name, i.indisunique AS unique, pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`,
      [schema],
    )
  ).rows;
  const normalize = (text: string) =>
    text
      .replaceAll(`${schema}.`, '')
      .replaceAll(' USING btree', '')
      .replaceAll('"', '')
      .replace(/[\s;]/g, '')
      .toLowerCase();
  const expectedIndexes = [
    ...sql.matchAll(/CREATE (UNIQUE )?INDEX "([^"]+)"[^;]*;/g),
  ];
  for (const [ddl, unique, name] of expectedIndexes)
    assert(
      indexes.some(
        (row) =>
          row.name === name &&
          row.unique === Boolean(unique) &&
          normalize(row.definition) === normalize(ddl),
      ),
      `Index: ${name}`,
    );
  const constraints = (
    await client.query<{
      conname: string;
      contype: string;
      confdeltype: string;
      confupdtype: string;
      definition: string;
      tablename: string;
    }>(
      `SELECT c.conname, c.contype::text, c.confdeltype::text, c.confupdtype::text,
    pg_get_constraintdef(c.oid) AS definition, r.relname AS tablename
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    JOIN pg_class r ON r.oid = c.conrelid WHERE n.nspname = $1`,
      [schema],
    )
  ).rows;
  for (const [, name] of sql.matchAll(/CONSTRAINT "([^"]+)" PRIMARY KEY/g))
    assert(
      constraints.some((row) => row.conname === name && row.contype === 'p'),
      `Primary key: ${name}`,
    );
  for (const [, table, name, definition] of sql.matchAll(
    /ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" (FOREIGN KEY.*?) ON DELETE/g,
  ))
    assert(
      constraints.some(
        (row) =>
          row.conname === name &&
          row.contype === 'f' &&
          row.tablename === table &&
          normalize(row.definition.split(' ON ')[0]) ===
            normalize(definition) &&
          row.confdeltype === 'c' &&
          row.confupdtype === 'c',
      ),
      `Foreign key: ${name}`,
    );
  const enums = (
    await client.query<{ typname: string; enumlabel: string }>(
      `SELECT t.typname, e.enumlabel FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = $1 ORDER BY e.enumsortorder`,
      [schema],
    )
  ).rows;
  for (const [, name, labels] of sql.matchAll(
    /CREATE TYPE "([^"]+)" AS ENUM \(([^)]+)\)/g,
  ))
    assert.deepEqual(
      enums.filter((row) => row.typname === name).map((row) => row.enumlabel),
      [...labels.matchAll(/'([^']+)'/g)].map(([, label]) => label),
      `Enum: ${name}`,
    );
  if (history) {
    assert.equal(schema, 'public');
    const applied = (
      await client.query<{
        migration_name: string;
        checksum: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }>(
        'SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations',
      )
    ).rows;
    for (const migration of migrations)
      assert(
        applied.some(
          (row) =>
            row.migration_name === migration.name &&
            row.finished_at &&
            !row.rolled_back_at &&
            row.checksum ===
              createHash('sha256').update(migration.sql).digest('hex'),
        ),
        `Migration history: ${migration.name}`,
      );
    assert.equal(
      applied.filter((row) => row.finished_at && !row.rolled_back_at).length,
      migrations.length,
    );
  }
  return {
    tables: tables.length,
    indexes: expectedIndexes.length,
    foreignKeys: [...sql.matchAll(/ADD CONSTRAINT .* FOREIGN KEY/g)].length,
    enums: [...sql.matchAll(/CREATE TYPE .* AS ENUM/g)].length,
  };
}

if (require.main === module) {
  void (async () => {
    const client = new Client(externalTestConnection(process.env));
    try {
      await client.connect();
      const version = Number(
        (
          await client.query<{ server_version_num: string }>(
            'SHOW server_version_num',
          )
        ).rows[0].server_version_num,
      );
      assert(
        version >= 170000 && version < 180000,
        'Clean Supabase validation requires PostgreSQL 17.',
      );
      if (process.argv.includes('--preflight')) {
        const tables = (
          await client.query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
          )
        ).rows;
        assert.equal(
          tables.length,
          0,
          'Preflight requires a clean public schema; do not reset an existing database.',
        );
        console.log(
          'Clean PostgreSQL 17 target preflight passed. No writes performed.',
        );
        return;
      }
      const result = await checkPostgresCatalog(client, 'public', true);
      console.log('Clean migration catalog and history verified:', result);
    } finally {
      await client.end();
    }
  })().catch(() => {
    console.error(
      'Clean database validation failed; inspect access/TLS/catalog/history securely. No connection details printed.',
    );
    process.exitCode = 1;
  });
}
