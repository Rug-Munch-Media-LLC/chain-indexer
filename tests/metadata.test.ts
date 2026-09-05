/**
 * Tests for src/metadata.ts — token registry resolution.
 */

import { describe, expect, it } from "vitest";
import { REGISTRY, resolveSymbol, resolveToken } from "../src/metadata.js";

describe("resolveToken", () => {
	it("resolves a known Ethereum token (USDT)", () => {
		const meta = resolveToken(
			"ethereum",
			"0xdac17f958d2ee523a2206206994597c13d831ec7",
		);
		expect(meta).not.toBeNull();
		expect(meta!.symbol).toBe("USDT");
		expect(meta!.decimals).toBe(6);
	});

	it("resolves WETH on ethereum", () => {
		const meta = resolveToken(
			"ethereum",
			"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
		);
		expect(meta!.symbol).toBe("WETH");
		expect(meta!.decimals).toBe(18);
	});

	it("resolves USDC on base", () => {
		const meta = resolveToken(
			"base",
			"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
		);
		expect(meta!.symbol).toBe("USDC");
	});

	it("resolves a Solana SPL mint (USDC)", () => {
		const meta = resolveToken(
			"solana",
			"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyBtNjx",
		);
		expect(meta!.symbol).toBe("USDC");
	});

	it("is case-insensitive on address", () => {
		const meta = resolveToken(
			"ethereum",
			"0xDAC17F958D2EE523A2206206994597C13D831EC7",
		);
		expect(meta!.symbol).toBe("USDT");
	});

	it("returns null for unknown token address", () => {
		expect(resolveToken("ethereum", "0xdeadbeef")).toBeNull();
	});

	it("returns null for unknown chain", () => {
		expect(
			resolveToken("moonriver", "0xdac17f958d2ee523a2206206994597c13d831ec7"),
		).toBeNull();
	});
});

describe("resolveSymbol", () => {
	it("returns the symbol for a known token", () => {
		expect(
			resolveSymbol("ethereum", "0xdac17f958d2ee523a2206206994597c13d831ec7"),
		).toBe("USDT");
	});

	it("returns truncated address for unknown token", () => {
		const out = resolveSymbol(
			"ethereum",
			"0x1234567890abcdef1234567890abcdef12345678",
		);
		expect(out).toBe("0x12345678...");
		expect(out.length).toBe(13);
	});
});

describe("REGISTRY", () => {
	it("contains entries for all major chains", () => {
		for (const chain of [
			"ethereum",
			"bsc",
			"arbitrum",
			"base",
			"polygon",
			"solana",
		]) {
			expect(REGISTRY[chain]).toBeDefined();
			expect(Object.keys(REGISTRY[chain]).length).toBeGreaterThan(0);
		}
	});

	it("every entry has symbol, name, and numeric decimals", () => {
		for (const [chain, tokens] of Object.entries(REGISTRY)) {
			for (const [addr, meta] of Object.entries(tokens)) {
				expect(typeof meta.symbol).toBe("string");
				expect(meta.symbol.length).toBeGreaterThan(0);
				expect(typeof meta.name).toBe("string");
				expect(typeof meta.decimals).toBe("number");
				expect(meta.decimals).toBeGreaterThanOrEqual(0);
				expect(meta.decimals).toBeLessThanOrEqual(18);
				// EVM keys must be lowercase addresses
				if (chain !== "solana") {
					expect(addr).toBe(addr.toLowerCase());
					expect(addr.startsWith("0x")).toBe(true);
				}
			}
		}
	});
});
