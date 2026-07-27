/**
 * Shared ClickHouse client + DDL helpers for chain-indexer.
 *
 * Every module that writes to ClickHouse uses this rather than
 * duplicating the client init code.  Tables are auto-created
 * with IF NOT EXISTS on first use (idempotent).
 */

import { createClient } from "@clickhouse/client";
import pino from "pino";

const logger = pino({ name: "clickhouse" });

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export const CLICKHOUSE_URL =
	process.env.CLICKHOUSE_URL || "http://localhost:8123";
export const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "rmi";
export const CLICKHOUSE_PASSWORD =
	process.env.CLICKHOUSE_PASSWORD || "rmi_password";
export const CLICKHOUSE_DB = process.env.CLICKHOUSE_DATABASE || "wallet_memory";

// ---------------------------------------------------------------------------
// Lazy client
// ---------------------------------------------------------------------------

let chClient: ReturnType<typeof createClient> | null = null;

export function getClickHouseClient() {
	if (!chClient) {
		chClient = createClient({
			host: CLICKHOUSE_URL,
			username: CLICKHOUSE_USER,
			password: CLICKHOUSE_PASSWORD,
			database: CLICKHOUSE_DB,
			clickhouse_settings: {
				async_insert: 1,
				wait_for_async_insert: 0,
			},
		});
		logger.info("ClickHouse client initialized");
	}
	return chClient;
}

// ---------------------------------------------------------------------------
// DDL — run once at startup (idempotent)
// ---------------------------------------------------------------------------

const DDL_STATEMENTS: string[] = [
	// EVM ERC-20 transfers (written by subsquid.ts)
	`CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_DB}.evm_transfers (
    chain          String,
    block_number   UInt64,
    tx_hash        String,
    from_address   String,
    to_address     String,
    token_address  String,
    value          String,
    block_timestamp DateTime,
    log_index      UInt32,
    token_symbol   Nullable(String),
    token_name     Nullable(String),
    ingested_at    DateTime
  ) ENGINE = MergeTree
  ORDER BY (chain, block_number, log_index)
  TTL ingested_at + INTERVAL 90 DAY`,

	// DEX swap / mint / burn events (written by dex.ts)
	`CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_DB}.dex_events (
    type             String,
    chain            String,
    block_number     UInt64,
    block_timestamp  DateTime,
    tx_hash          String,
    log_index        UInt32,
    contract_address String,
    dex              String,
    version          String,
    token0           String,
    token1           String,
    sender           String,
    recipient        String,
    amount0_in       Nullable(String),
    amount1_in       Nullable(String),
    amount0_out      Nullable(String),
    amount1_out      Nullable(String),
    amount0          Nullable(String),
    amount1          Nullable(String),
    whale            UInt8,
    ingested_at      DateTime
  ) ENGINE = MergeTree
  ORDER BY (chain, block_number, log_index)
  TTL ingested_at + INTERVAL 90 DAY`,

	// Deployer → token mappings (written by deployers.ts)
	`CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_DB}.deployer_events (
    deployer       String,
    token_address  String,
    chain          String,
    block_number   UInt64,
    block_timestamp DateTime,
    tx_hash        String,
    type           String,
    factory        Nullable(String),
    ingested_at    DateTime
  ) ENGINE = MergeTree
  ORDER BY (chain, block_number)
  TTL ingested_at + INTERVAL 90 DAY`,
];

let _tablesEnsured = false;

/**
 * Run all CREATE TABLE IF NOT EXISTS statements.
 * Idempotent — safe to call multiple times (only runs once per process).
 */
export async function ensureClickHouseTables(): Promise<void> {
	if (_tablesEnsured) return;
	const client = getClickHouseClient();
	for (const ddl of DDL_STATEMENTS) {
		try {
			await client.command({ query: ddl });
			logger.debug({ ddl: ddl.slice(0, 80) }, "ClickHouse DDL OK");
		} catch (err) {
			logger.error({ err, ddl: ddl.slice(0, 80) }, "ClickHouse DDL failed");
		}
	}
	_tablesEnsured = true;
	logger.info("ClickHouse tables ensured");
}

// ---------------------------------------------------------------------------
// Timestamp helper — convert Subsquid/Unix values to ISO strings
// ---------------------------------------------------------------------------

/**
 * Convert a Subsquid timestamp (Unix seconds, possibly as string | number | Date)
 * to an ISO-8601 string.  Returns empty string for falsy/NaN inputs.
 */
export function toIsoTs(ts: unknown): string {
	if (!ts) return "";
	const n = Number(ts);
	if (isNaN(n) || n <= 0) return String(ts);
	return new Date(n * 1000).toISOString();
}
