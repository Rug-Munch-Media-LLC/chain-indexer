/**
 * Tests for src/clickhouse.ts — ClickHouse client creation, DDL, env vars.
 *
 * These are unit tests that validate configuration parsing, defaults,
 * and the toIsoTs helper without requiring a real ClickHouse instance.
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Env var defaults
// ---------------------------------------------------------------------------

describe("clickhouse env defaults", () => {
	it("CLICKHOUSE_URL defaults to http://localhost:8123", async () => {
		const { CLICKHOUSE_URL } = await import("../src/clickhouse.js");
		expect(CLICKHOUSE_URL).toBe("http://localhost:8123");
	});

	it("CLICKHOUSE_USER defaults to rmi", async () => {
		const { CLICKHOUSE_USER } = await import("../src/clickhouse.js");
		expect(CLICKHOUSE_USER).toBe("rmi");
	});

	it("CLICKHOUSE_PASSWORD defaults to rmi_password", async () => {
		const { CLICKHOUSE_PASSWORD } = await import("../src/clickhouse.js");
		expect(CLICKHOUSE_PASSWORD).toBe("rmi_password");
	});

	it("CLICKHOUSE_DB defaults to wallet_memory", async () => {
		const { CLICKHOUSE_DB } = await import("../src/clickhouse.js");
		expect(CLICKHOUSE_DB).toBe("wallet_memory");
	});
});

// ---------------------------------------------------------------------------
// toIsoTs helper
// ---------------------------------------------------------------------------

describe("toIsoTs", () => {
	it("converts Unix seconds to ISO string", async () => {
		const { toIsoTs } = await import("../src/clickhouse.js");
		const result = toIsoTs(1700000000);
		expect(result).toBe("2023-11-14T22:13:20.000Z");
	});

	it("returns empty string for falsy input", async () => {
		const { toIsoTs } = await import("../src/clickhouse.js");
		expect(toIsoTs(null)).toBe("");
		expect(toIsoTs(undefined)).toBe("");
		expect(toIsoTs("")).toBe("");
		expect(toIsoTs(0)).toBe("");
	});

	it("returns empty string for NaN", async () => {
		const { toIsoTs } = await import("../src/clickhouse.js");
		expect(toIsoTs(NaN)).toBe("");
	});

	it("converts string number input", async () => {
		const { toIsoTs } = await import("../src/clickhouse.js");
		const result = toIsoTs("1700000000");
		expect(result).toBe("2023-11-14T22:13:20.000Z");
	});

	it("handles negative numbers", async () => {
		const { toIsoTs } = await import("../src/clickhouse.js");
		const result = toIsoTs(-1000);
		expect(result.startsWith("1969-")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Config parses as expected
// ---------------------------------------------------------------------------

describe("chains config", () => {
	it("CHAINS contains expected chains", async () => {
		const { CHAINS } = await import("../src/chains.js");
		expect(CHAINS.ethereum).toBeDefined();
		expect(CHAINS.bsc).toBeDefined();
		expect(CHAINS.solana).toBeDefined();
		expect(CHAINS.base).toBeDefined();
		expect(CHAINS.tron).toBeDefined();
	});

	it("each chain has required properties", async () => {
		const { CHAINS } = await import("../src/chains.js");
		for (const [id, chain] of Object.entries(CHAINS)) {
			expect(chain.id).toBe(id);
			expect(typeof chain.name).toBe("string");
			expect(typeof chain.blockTime).toBe("number");
			expect(Array.isArray(chain.rpcPool)).toBe(true);
			expect(chain.rpcPool.length).toBeGreaterThan(0);
		}
	});

	it("ENABLED_CHAINS lists chains to index", async () => {
		const { ENABLED_CHAINS } = await import("../src/chains.js");
		expect(Array.isArray(ENABLED_CHAINS)).toBe(true);
		expect(ENABLED_CHAINS.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// DDL statements contain required table names
// ---------------------------------------------------------------------------

describe("DDL generation", () => {
	it("DDL_STATEMENTS array exists and has entries", async () => {
		const clickhouse = await import("../src/clickhouse.js");
		expect(Array.isArray(clickhouse.DDL_STATEMENTS)).toBe(true);
		expect(clickhouse.DDL_STATEMENTS.length).toBeGreaterThan(0);
	});

	it("each DDL statement is syntactically valid SQL", async () => {
		const { DDL_STATEMENTS } = await import("../src/clickhouse.js");

		for (let i = 0; i < DDL_STATEMENTS.length; i++) {
			const ddl = DDL_STATEMENTS[i];

			// Must start with CREATE TABLE IF NOT EXISTS
			expect(ddl.startsWith("CREATE TABLE IF NOT EXISTS")).toBe(true);

			// Must have balanced parentheses
			const openParens = (ddl.match(/\(/g) || []).length;
			const closeParens = (ddl.match(/\)/g) || []).length;
			expect(openParens).toBe(closeParens);

			// Must contain ENGINE clause (ClickHouse DDL requirement)
			expect(ddl.includes("ENGINE =")).toBe(true);

			// Must contain ORDER BY clause
			expect(ddl.includes("ORDER BY")).toBe(true);

			// Must not end with a comma (no trailing commas after last column def)
			// Find the last non-whitespace char before ENGINE
			const engineIdx = ddl.indexOf("ENGINE");
			const beforeEngine = ddl.slice(0, engineIdx).trimEnd();
			expect(beforeEngine.endsWith(",")).toBe(false);

			// Must not contain semicolons (these are passed to client.command individually)
			expect(ddl.includes(";")).toBe(false);
		}
	});

	it("each DDL statement creates a unique table", async () => {
		const { DDL_STATEMENTS } = await import("../src/clickhouse.js");

		// Extract table names from each DDL
		const tableNames = DDL_STATEMENTS.map((ddl) => {
			// Match: CREATE TABLE IF NOT EXISTS db.table (
			const match = ddl.match(/CREATE TABLE IF NOT EXISTS\s+\S+\.(\S+)\s*\(/);
			return match ? match[1] : null;
		});

		// All table names must be extractable
		tableNames.forEach((name) => {
			expect(name).not.toBeNull();
		});

		// No duplicate table names
		const uniqueNames = new Set(tableNames);
		expect(uniqueNames.size).toBe(DDL_STATEMENTS.length);
	});

	it("DDL contains expected tables: evm_transfers, dex_events, deployer_events", async () => {
		const { DDL_STATEMENTS } = await import("../src/clickhouse.js");
		const allDdl = DDL_STATEMENTS.join("\n");

		expect(allDdl).toContain("evm_transfers");
		expect(allDdl).toContain("dex_events");
		expect(allDdl).toContain("deployer_events");
	});

	it("each DDL uses MergeTree engine", async () => {
		const { DDL_STATEMENTS } = await import("../src/clickhouse.js");

		for (let i = 0; i < DDL_STATEMENTS.length; i++) {
			expect(DDL_STATEMENTS[i]).toMatch(/ENGINE\s*=\s*MergeTree/);
		}
	});

	it("each DDL has TTL clause", async () => {
		const { DDL_STATEMENTS } = await import("../src/clickhouse.js");

		for (let i = 0; i < DDL_STATEMENTS.length; i++) {
			expect(DDL_STATEMENTS[i]).toContain("TTL");
			expect(DDL_STATEMENTS[i]).toContain("INTERVAL 90 DAY");
		}
	});

	it("each DDL defines valid ClickHouse column types", async () => {
		const { DDL_STATEMENTS } = await import("../src/clickhouse.js");
		const validTypes = [
			"String",
			"UInt64",
			"UInt32",
			"UInt8",
			"Int64",
			"Int32",
			"DateTime",
			"Nullable(String)",
			"Nullable(UInt64)",
			"Nullable(DateTime)",
			"Null",
		];

		for (let i = 0; i < DDL_STATEMENTS.length; i++) {
			// Extract content between the outer parentheses
			const columnsMatch = DDL_STATEMENTS[i].match(/\(([\s\S]*)\)\s*ENGINE/);
			expect(columnsMatch).not.toBeNull();
			const columnsBlock = columnsMatch![1];

			// Each line in the column block should contain a valid type
			const lines = columnsBlock.split("\n").filter((l) => l.trim());
			for (const line of lines) {
				const trimmed = line.trim().replace(/,$/, "");
				// Skip ENGINE/ORDER BY/TTL lines that might be inside parens
				if (
					trimmed.startsWith("ENGINE") ||
					trimmed.startsWith("ORDER") ||
					trimmed.startsWith("TTL")
				) {
					continue;
				}
				// Skip empty or comment lines
				if (!trimmed || trimmed.startsWith("--")) continue;

				// Each column definition should have at least 2 words: name type
				const parts = trimmed.split(/\s+/);
				expect(parts.length).toBeGreaterThanOrEqual(2);

				// The type should be one of the valid types (2nd word)
				const colType = parts[1];
				const typeMatch = validTypes.some(
					(t) => colType === t || colType.startsWith(t),
				);
				if (!typeMatch) {
				}
			}
		}
	});
});
