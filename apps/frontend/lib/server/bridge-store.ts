import "server-only";

import { Pool } from "pg";

import type { CircleBridgeTransferRecord } from "@/lib/server/circle-bridge";

const BRIDGE_TRANSACTIONS_TABLE = "bridge_transactions";

let bridgeStorePool: Pool | null = null;
let bridgeStoreSetupPromise: Promise<void> | null = null;

export function isBridgeDatabaseConfigured() {
  return Boolean(getBridgeDatabaseUrl());
}

export async function loadBridgeRecordFromDatabase(
  transferId: string
): Promise<CircleBridgeTransferRecord | null> {
  if (!isBridgeDatabaseConfigured()) {
    return null;
  }

  const pool = getBridgeStorePool();
  await ensureBridgeTransactionsTable();

  const result = await pool.query<{ payload: CircleBridgeTransferRecord | string }>(
    `
      SELECT payload
      FROM ${BRIDGE_TRANSACTIONS_TABLE}
      WHERE tx_id = $1
      LIMIT 1
    `,
    [transferId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const payload = result.rows[0]?.payload;

  if (!payload) {
    return null;
  }

  return typeof payload === "string"
    ? (JSON.parse(payload) as CircleBridgeTransferRecord)
    : payload;
}

export async function saveBridgeRecordToDatabase(
  record: CircleBridgeTransferRecord
): Promise<boolean> {
  if (!isBridgeDatabaseConfigured()) {
    return false;
  }

  const pool = getBridgeStorePool();
  await ensureBridgeTransactionsTable();

  await pool.query(
    `
      INSERT INTO ${BRIDGE_TRANSACTIONS_TABLE} (
        id,
        tx_id,
        status,
        created_at,
        updated_at,
        payload
      )
      VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)
      ON CONFLICT (tx_id) DO UPDATE
      SET
        id = EXCLUDED.id,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        payload = EXCLUDED.payload
    `,
    [
      record.id || record.transferId,
      record.transferId,
      record.status,
      record.createdAt,
      record.updatedAt,
      JSON.stringify(record),
    ]
  );

  return true;
}

function getBridgeStorePool() {
  if (bridgeStorePool) {
    return bridgeStorePool;
  }

  const databaseUrl = getBridgeDatabaseUrl();

  if (!databaseUrl) {
    throw new Error(
      "Bridge database storage is not configured. Set BRIDGE_DATABASE_URL or DATABASE_URL."
    );
  }

  bridgeStorePool = new Pool({
    connectionString: databaseUrl,
    max: 5,
  });

  return bridgeStorePool;
}

function getBridgeDatabaseUrl() {
  return (
    process.env.BRIDGE_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    ""
  );
}

async function ensureBridgeTransactionsTable() {
  if (bridgeStoreSetupPromise) {
    return bridgeStoreSetupPromise;
  }

  const pool = getBridgeStorePool();

  bridgeStoreSetupPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${BRIDGE_TRANSACTIONS_TABLE} (
        id TEXT PRIMARY KEY,
        tx_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS bridge_transactions_status_updated_idx
      ON ${BRIDGE_TRANSACTIONS_TABLE} (status, updated_at DESC)
    `);
  })().catch((error) => {
    bridgeStoreSetupPromise = null;
    throw error;
  });

  return bridgeStoreSetupPromise;
}