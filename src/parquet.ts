/**
 * Parquet Auto-Conversion Module
 *
 * Converts NDJSON files to Parquet using DuckDB,
 * then syncs the Parquet files to Cloudflare R2.
 *
 * Runs every hour via startParquetScheduler() in index.ts.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { DATA_DIR } from "./chains.js";
import { jsonlToParquetCommand } from "./sync.js";

const logger = pino({ name: "parquet" });

const PARQUET_DIR =
	process.env.PARQUET_DIR || "/srv/data/chain-indexer/parquet";
const R2_BUCKET = process.env.R2_BUCKET || "rmi-data";

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function previousDate(): { yyyy: string; mm: string; dd: string } {
	const now = new Date();
	now.setUTCMinutes(0, 0, 0);
	now.setUTCHours(now.getUTCHours() - 1);
	return {
		yyyy: String(now.getUTCFullYear()),
		mm: String(now.getUTCMonth() + 1).padStart(2, "0"),
		dd: String(now.getUTCDate()).padStart(2, "0"),
	};
}

function dateStr({
	yyyy,
	mm,
	dd,
}: {
	yyyy: string;
	mm: string;
	dd: string;
}): string {
	return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Chain discovery
// ---------------------------------------------------------------------------

function discoverChains(): string[] {
	if (!existsSync(DATA_DIR)) return [];
	return readdirSync(DATA_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith("."))
		.map((d) => d.name);
}

// ---------------------------------------------------------------------------
// Parquet conversion for a single chain + date
// ---------------------------------------------------------------------------

/**
 * Convert a single chain's NDJSON to Parquet.
 * Uses jsonlToParquetCommand() from sync.ts, then moves the result
 * to the PARQUET_DIR.
 *
 * Returns true if conversion happened, false if no data / skipped.
 */
function convertChainDate(chain: string, date: string): boolean {
	const jsonlFile = join(DATA_DIR, chain, date, "events.jsonl");
	if (!existsSync(jsonlFile)) {
		logger.debug({ chain, date }, "No JSONL — skipping");
		return false;
	}

	const outDir = join(PARQUET_DIR, chain, date);
	mkdirSync(outDir, { recursive: true });
	const parquetFile = join(outDir, "events.parquet");

	// Skip if parquet already exists and is newer than jsonl
	if (existsSync(parquetFile)) {
		try {
			const jsonlMtime = Number(
				execSync(`stat -c%Y "${jsonlFile}"`, {
					encoding: "utf-8",
					stdio: "pipe",
				}).trim(),
			);
			const parquetMtime = Number(
				execSync(`stat -c%Y "${parquetFile}"`, {
					encoding: "utf-8",
					stdio: "pipe",
				}).trim(),
			);
			if (parquetMtime >= jsonlMtime) {
				logger.debug({ chain, date }, "Parquet is current — skipping");
				return false;
			}
		} catch {
			// stat unavailable (macOS etc), fall through to conversion
		}
	}

	try {
		// Use jsonlToParquetCommand from sync.ts to produce the DuckDB command.
		// It writes the .parquet file next to the .jsonl in DATA_DIR.
		const cmd = jsonlToParquetCommand(chain, date);
		execSync(cmd, {
			timeout: 300_000,
			encoding: "utf-8",
			stdio: "pipe",
			shell: true,
		} as any);

		// Move the result from DATA_DIR to PARQUET_DIR
		const srcParquet = jsonlFile.replace(".jsonl", ".parquet");
		if (existsSync(srcParquet)) {
			renameSync(srcParquet, parquetFile);
		} else {
			logger.warn(
				{ chain, date, src: srcParquet },
				"Parquet file not found after conversion",
			);
			return false;
		}

		logger.info(
			{ chain, date, output: parquetFile },
			"NDJSON → Parquet complete",
		);
		return true;
	} catch (err: any) {
		logger.error(
			{ chain, date, err: err.stderr || err.message },
			"Parquet conversion failed",
		);
		return false;
	}
}

// ---------------------------------------------------------------------------
// R2 sync (parquet)
// ---------------------------------------------------------------------------

function syncParquetToR2(): void {
	if (!existsSync(PARQUET_DIR)) return;

	try {
		const cmd = `rclone sync "${PARQUET_DIR}" "r2:${R2_BUCKET}/parquet/" \
      --transfers 4 \
      --checkers 8 \
      --max-age 5m \
      --ignore-errors \
      --no-update-modtime`;

		const output = execSync(cmd, {
			timeout: 300000,
			encoding: "utf-8",
			stdio: "pipe",
		} as any);

		logger.info({ output: output.trim() }, "Parquet R2 sync complete");
	} catch (err: any) {
		if (
			err.stderr?.includes("couldn't find") ||
			err.stderr?.includes("not found")
		) {
			logger.warn("Parquet R2 sync skipped — rclone remote not configured");
			return;
		}
		logger.error({ err: err.stderr || err.message }, "Parquet R2 sync failed");
	}
}

// ---------------------------------------------------------------------------
// Main conversion cycle
// ---------------------------------------------------------------------------

/**
 * Run one full conversion cycle:
 * 1. Convert the previous hour's NDJSON → Parquet for every chain
 * 2. Sync Parquet files to R2
 */
export async function runParquetConversion(): Promise<void> {
	const d = previousDate();
	const date = dateStr(d);

	const chains = discoverChains();
	if (chains.length === 0) {
		logger.debug("No chain data directories found");
		return;
	}

	logger.info({ chains, date }, "Parquet conversion cycle starting");
	let converted = 0;

	for (const chain of chains) {
		const ok = convertChainDate(chain, date);
		if (ok) converted++;
	}

	if (converted > 0) {
		syncParquetToR2();
	}

	logger.info(
		{ chains: chains.length, converted },
		"Parquet conversion cycle done",
	);
}

// ---------------------------------------------------------------------------
// Hourly scheduler
// ---------------------------------------------------------------------------

/**
 * Start the hourly parquet conversion loop.
 * Aligns to the top of the next hour, then runs every hour.
 */
export function startParquetScheduler(): ReturnType<typeof setInterval> {
	const now = new Date();
	const nextHour = new Date(now);
	nextHour.setUTCMinutes(0, 0, 0);
	nextHour.setUTCHours(nextHour.getUTCHours() + 1);
	const delay = nextHour.getTime() - now.getTime();

	logger.info({ delayMs: delay }, "Parquet scheduler first run at next hour");

	setTimeout(() => {
		runParquetConversion().catch((err: unknown) =>
			logger.error({ err }, "Parquet conversion (initial) failed"),
		);
	}, delay);

	return setInterval(() => {
		runParquetConversion().catch((err: unknown) =>
			logger.error({ err }, "Parquet conversion (interval) failed"),
		);
	}, 3600_000);
}
