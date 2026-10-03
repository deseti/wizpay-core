import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from 'pg';
import { migrationRoot } from './rehearsal-config';

export async function migrationContract() {
  const entries = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const migrations = await Promise.all(
    entries.map(async (entry) => {
      const sql = await readFile(
        join(migrationRoot, entry.name, 'migration.sql'),
        'utf8',
      );
      return {
        name: entry.name,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    }),
  );
  return {
    migrations,
    tables: migrations
      .flatMap((migration) =>
        [...migration.sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map(
          (match) => match[1],
        ),
      )
      .sort(),
  };
}

const queries = {
  columns: `SELECT c.relname AS table, a.attname AS column, a.attnum AS position,
    format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
    pg_get_expr(d.adbin,d.adrelid) AS default, a.attidentity::text AS identity,
    a.attgenerated::text AS generated, c.relrowsecurity AS rls
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname COLLATE "C",a.attnum`,
  constraints: `SELECT t.relname AS table, c.conname AS name, c.contype::text AS type,
    pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated,
    c.condeferrable AS deferrable, c.condeferred AS deferred
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=ANY($1) ORDER BY t.relname COLLATE "C",c.conname COLLATE "C"`,
  indexes: `SELECT t.relname AS table, i.relname AS name, pg_get_indexdef(i.oid) AS definition,
    x.indisunique AS unique, x.indisprimary AS primary, x.indisvalid AS valid, x.indisready AS ready
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=ANY($1) ORDER BY t.relname COLLATE "C",i.relname COLLATE "C"`,
  enums: `SELECT t.typname AS name, e.enumlabel AS label, e.enumsortorder AS position
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' ORDER BY t.typname COLLATE "C",e.enumsortorder`,
  triggers: `SELECT t.relname AS table, g.tgname AS name, pg_get_triggerdef(g.oid) AS definition
    FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=ANY($1) AND NOT g.tgisinternal ORDER BY t.relname COLLATE "C",g.tgname COLLATE "C"`,
} as const;

type CatalogRow = Record<string, string | number | boolean | null>;

export async function catalog(client: Client, tables: string[]) {
  const columns = (await client.query<CatalogRow>(queries.columns, [tables]))
    .rows;
  const constraints = (
    await client.query<CatalogRow>(queries.constraints, [tables])
  ).rows;
  const indexes = (await client.query<CatalogRow>(queries.indexes, [tables]))
    .rows;
  const enums = (await client.query<CatalogRow>(queries.enums)).rows;
  const triggers = (await client.query<CatalogRow>(queries.triggers, [tables]))
    .rows;
  return { columns, constraints, indexes, enums, triggers } as Record<
    keyof typeof queries,
    CatalogRow[]
  >;
}

export async function applicationTables(client: Client) {
  return (
    await client.query<{ name: string }>(`SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
    AND c.relname <> '_prisma_migrations' ORDER BY c.relname COLLATE "C"`)
  ).rows.map((row) => row.name);
}

export async function startSnapshot(client: Client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query('SET LOCAL extra_float_digits = 3');
}

/** Full row content stays in memory; reports expose only equality, never auth hashes. */
export async function dataSnapshot(client: Client, tables: string[]) {
  const result: Record<string, { count: string; digest: string }> = {};
  for (const table of tables) {
    if (!/^[a-zA-Z]+$/.test(table))
      throw new Error('Unexpected application table.');
    const count = (
      await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public."${table}"`,
      )
    ).rows[0].count;
    const hash = createHash('sha256');
    await client.query(
      `DECLARE rehearsal_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS value FROM public."${table}" t ORDER BY t.id::text COLLATE "C"`,
    );
    while (true) {
      const rows = (
        await client.query<{ value: string }>('FETCH 1000 FROM rehearsal_rows')
      ).rows;
      if (!rows.length) break;
      for (const row of rows) hash.update(row.value).update('\n');
    }
    await client.query('CLOSE rehearsal_rows');
    result[table] = { count, digest: hash.digest('hex') };
  }
  return result;
}

export function compareSnapshots(
  source: Awaited<ReturnType<typeof dataSnapshot>>,
  target: Awaited<ReturnType<typeof dataSnapshot>>,
) {
  return Object.keys(source)
    .sort()
    .map((table) => ({
      table,
      source_count: source[table].count,
      target_count: target[table]?.count ?? null,
      match: source[table].count === target[table]?.count,
      integrity_match: source[table].digest === target[table]?.digest,
    }));
}

export function catalogParity(
  source: Awaited<ReturnType<typeof catalog>>,
  target: Awaited<ReturnType<typeof catalog>>,
) {
  return Object.fromEntries(
    Object.keys(queries).map((key) => [
      key,
      JSON.stringify(source[key]) === JSON.stringify(target[key]),
    ]),
  ) as Record<keyof typeof queries, boolean>;
}
