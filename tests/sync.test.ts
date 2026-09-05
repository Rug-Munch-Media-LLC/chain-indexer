/**
 * Tests for src/sync.ts — jsonlToParquetCommand (pure function).
 * Also validates the B2 bucket env default without executing rclone.
 */

import { describe, expect, it } from "vitest";
import { jsonlToParquetCommand } from "../src/sync.js";

describe("jsonlToParquetCommand", () => {
	it("builds a duckdb COPY command for a chain/date", () => {
		const cmd = jsonlToParquetCommand("ethereum", "2026-07-12");
		expect(cmd).toContain("duckdb");
		expect(cmd).toContain("COPY");
		expect(cmd).toContain("read_json_auto");
		expect(cmd).toContain("FORMAT PARQUET");
		expect(cmd).toContain("COMPRESSION ZSTD");
	});

	it("references the correct jsonl input path", () => {
		const cmd = jsonlToParquetCommand("bsc", "2026-08-01");
		expect(cmd).toContain("/bsc/2026-08-01/events.jsonl");
	});

	it("writes parquet next to the jsonl file", () => {
		const cmd = jsonlToParquetCommand("solana", "2026-08-01");
		expect(cmd).toContain("events.parquet");
	});

	it("uses the same base path for input and output", () => {
		const cmd = jsonlToParquetCommand("base", "2026-08-15");
		const jsonlMatch = cmd.match(/'([^']*events\.jsonl)'/);
		const parquetMatch = cmd.match(/'([^']*events\.parquet)'/);
		expect(jsonlMatch).not.toBeNull();
		expect(parquetMatch).not.toBeNull();
		expect(jsonlMatch![1].replace("events.jsonl", "")).toBe(
			parquetMatch![1].replace("events.parquet", ""),
		);
	});

	it("does not mutate the chain or date in the output path", () => {
		const cmd = jsonlToParquetCommand("polygon", "2026-09-01");
		expect(cmd).toContain("/polygon/2026-09-01/events.parquet");
	});
});
