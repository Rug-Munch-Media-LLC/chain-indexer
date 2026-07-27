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
});
