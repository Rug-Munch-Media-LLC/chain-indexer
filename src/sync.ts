/**
 * B2 sync via rclone.
 *
 * Pushes local NDJSON files to Backblaze B2.
 * A separate cron job converts NDJSON → Parquet using DuckDB.
 *
 * Requires: rclone installed, B2 remote configured via env vars.
 * Migrated from R2 to B2 2026-07-31
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import pino from "pino";
import { DATA_DIR } from "./chains.js";

const logger = pino({ name: "sync" });

const B2_BUCKET = process.env.B2_BUCKET || "rmi-data";
const B2_ACCOUNT_ID = process.env.B2_ACCOUNT_ID || "";
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY || "";

let rcloneConfigured = false;

function ensureRcloneConfig() {
	if (rcloneConfigured) return;
	if (!existsSync(DATA_DIR)) {
		logger.warn("Data directory does not exist yet");
		return;
	}

	// Configure rclone B2 remote if env vars are set
	if (B2_ACCOUNT_ID && B2_APPLICATION_KEY) {
		try {
			execSync(
				`rclone config create b2 b2 account="${B2_ACCOUNT_ID}" \
        key="${B2_APPLICATION_KEY}" --non-interactive 2>/dev/null || true`,
				{ stdio: "pipe" },
			);
			rcloneConfigured = true;
			logger.info("B2 rclone remote configured");
		} catch {
			logger.warn("rclone config may already exist — continuing");
			rcloneConfigured = true;
		}
	}
}

/**
 * Sync local JSONL data to B2.
 * Uses rclone sync — one-directional, never deletes from B2.
 */
export async function syncToB2(): Promise<void> {
	ensureRcloneConfig();

	if (!existsSync(DATA_DIR)) {
		logger.debug("Data directory empty, skipping sync");
		return;
	}

	try {
		const cmd = `rclone sync "${DATA_DIR}" "b2:${B2_BUCKET}/jsonl/" \
      --progress \
      --transfers 4 \
      --checkers 8 \
      --max-age 5m \
      --ignore-errors \
      --no-update-modtime`;

		const output = execSync(cmd, {
			timeout: 600_000, // 10 min
			encoding: "utf-8",
			stdio: "pipe",
		});

		logger.info({ output: output.trim() }, "B2 sync complete");
	} catch (err: any) {
		if (err.stderr?.includes("couldn't find")) {
			logger.warn(
				"B2 sync skipped — rclone remote not found. Set B2_* env vars.",
			);
			return;
		}
		throw err;
	}
}

/**
 * Convert JSONL files to Parquet using DuckDB.
 * Run this on Talos where DuckDB is available.
 *
 * duckdb -c "
 *   COPY (
 *     SELECT * FROM read_json_auto('srv/data/chain-indexer/jsonl/ethereum/2026-07-12/events.jsonl')
 *   ) TO 'output.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
 * "
 */
export function jsonlToParquetCommand(chain: string, date: string): string {
	const jsonlFile = `${DATA_DIR}/${chain}/${date}/events.jsonl`;
	const parquetFile = jsonlFile.replace(".jsonl", ".parquet");

	return `duckdb -c "
    COPY (
      SELECT * FROM read_json_auto('${jsonlFile}')
    ) TO '${parquetFile}' (FORMAT PARQUET, COMPRESSION ZSTD);
  "`;
}
