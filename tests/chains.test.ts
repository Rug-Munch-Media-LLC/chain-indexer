/**
 * Tests for src/chains.ts — DEX configs and directory defaults.
 * (Chain config basics are covered in clickhouse.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { CHAINS, DEX_CONFIGS, ENABLED_CHAINS } from "../src/chains.js";

describe("DEX_CONFIGS", () => {
	it("contains configs for ethereum, bsc, polygon, arbitrum, base", () => {
		for (const chain of ["ethereum", "bsc", "polygon", "arbitrum", "base"]) {
			expect(DEX_CONFIGS[chain]).toBeDefined();
			expect(DEX_CONFIGS[chain].length).toBeGreaterThan(0);
		}
	});

	it("every DEX entry has a name and at least one address", () => {
		for (const [chain, dexes] of Object.entries(DEX_CONFIGS)) {
			for (const d of dexes) {
				expect(typeof d.name).toBe("string");
				expect(d.name.length).toBeGreaterThan(0);
				const hasAddr = Boolean(d.router || d.v2Factory || d.v3Factory);
				expect(hasAddr, `${chain}/${d.name} missing addresses`).toBe(true);
			}
		}
	});

	it("ethereum includes uniswap_v2 and uniswap_v3", () => {
		const names = DEX_CONFIGS.ethereum.map((d) => d.name);
		expect(names).toContain("uniswap_v2");
		expect(names).toContain("uniswap_v3");
	});

	it("bsc includes pancakeswap with the canonical router", () => {
		const pancake = DEX_CONFIGS.bsc.find((d) => d.name === "pancakeswap");
		expect(pancake).toBeDefined();
		expect(pancake!.router).toBe("0x10ED43C718714eb63d5aA57B78B54704E256024E");
	});

	it("addresses are valid hex (0x + 40 chars)", () => {
		for (const dexes of Object.values(DEX_CONFIGS)) {
			for (const d of dexes) {
				for (const addr of [d.router, d.v2Factory, d.v3Factory]) {
					if (addr) {
						expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
					}
				}
			}
		}
	});
});

describe("chain config consistency", () => {
	it("every enabled chain exists in CHAINS", () => {
		for (const id of ENABLED_CHAINS) {
			expect(
				CHAINS[id],
				`ENABLED_CHAINS references missing chain ${id}`,
			).toBeDefined();
		}
	});

	it("every chain has a positive blockTime and non-negative confirmations", () => {
		for (const chain of Object.values(CHAINS)) {
			expect(chain.blockTime).toBeGreaterThan(0);
			expect(chain.confirmations).toBeGreaterThanOrEqual(0);
		}
	});

	it("tron has no subsquid network (uses TronGrid instead)", () => {
		expect(CHAINS.tron.subsquidNetwork).toBeNull();
	});

	it("EVM chains have a subsquid network configured", () => {
		for (const id of ["ethereum", "bsc", "arbitrum", "base", "polygon"]) {
			expect(CHAINS[id].subsquidNetwork).not.toBeNull();
		}
	});

	it("rpcPool URLs are https", () => {
		for (const chain of Object.values(CHAINS)) {
			for (const url of chain.rpcPool) {
				expect(url.startsWith("https://")).toBe(true);
			}
		}
	});
});
