/**
 * Tests for src/deployers.ts — scoreDeployer scoring logic.
 *
 * scoreDeployer is a pure function; no ClickHouse or network needed.
 */

import { describe, expect, it } from "vitest";
import { scoreDeployer } from "../src/deployers.js";

describe("scoreDeployer", () => {
	it("returns clean tier for a deployer with no rugs", () => {
		const s = scoreDeployer("0xabc", { total: 5, rugged: 0, maxFDVs: [] });
		expect(s.tier).toBe("clean");
		expect(s.score).toBe(100);
		expect(s.address).toBe("0xabc");
		expect(s.totalTokens).toBe(5);
		expect(s.activeTokens).toBe(5);
		expect(s.ruggedTokens).toBe(0);
	});

	it("returns score 50 for a deployer with no tokens", () => {
		const s = scoreDeployer("0xnew", { total: 0, rugged: 0, maxFDVs: [] });
		expect(s.score).toBe(50);
		expect(s.totalTokens).toBe(0);
		expect(s.activeTokens).toBe(0);
	});

	it("penalizes rugged tokens proportionally", () => {
		const s = scoreDeployer("0xrug", { total: 10, rugged: 5, maxFDVs: [] });
		// 100 - (5/10)*100 = 50
		expect(s.score).toBe(50);
		expect(s.ruggedTokens).toBe(5);
		expect(s.activeTokens).toBe(5);
	});

	it("classifies serial rugger when score < 20", () => {
		const s = scoreDeployer("0xserial", { total: 10, rugged: 9, maxFDVs: [] });
		// 100 - 90 = 10
		expect(s.score).toBe(10);
		expect(s.tier).toBe("serial_rugger");
	});

	it("classifies high_risk when score < 50", () => {
		const s = scoreDeployer("0xhigh", { total: 10, rugged: 7, maxFDVs: [] });
		// 100 - 70 = 30
		expect(s.score).toBe(30);
		expect(s.tier).toBe("high_risk");
	});

	it("classifies suspicious when score < 70 and total > 3", () => {
		const s = scoreDeployer("0xsusp", { total: 10, rugged: 4, maxFDVs: [] });
		// 100 - 40 = 60, total 10 > 3
		expect(s.score).toBe(60);
		expect(s.tier).toBe("suspicious");
	});

	it("does not classify suspicious when total <= 3", () => {
		const s = scoreDeployer("0xfew", { total: 3, rugged: 1, maxFDVs: [] });
		// 100 - (1/3)*100 ≈ 66.7 → low_risk branch (score < 85)
		expect(s.tier).toBe("low_risk");
	});

	it("computes avgMaxFDV as mean of provided values", () => {
		const s = scoreDeployer("0xfdv", {
			total: 2,
			rugged: 0,
			maxFDVs: [1000, 3000],
		});
		expect(s.avgMaxFDV).toBe(2000);
	});

	it("returns avgMaxFDV 0 when no FDVs provided", () => {
		const s = scoreDeployer("0xnone", { total: 1, rugged: 0, maxFDVs: [] });
		expect(s.avgMaxFDV).toBe(0);
	});

	it("handles negative/zero stats gracefully", () => {
		const s = scoreDeployer("0xzero", { total: 0, rugged: 0, maxFDVs: [] });
		expect(s.score).toBeGreaterThanOrEqual(0);
		expect(s.score).toBeLessThanOrEqual(100);
	});
});
