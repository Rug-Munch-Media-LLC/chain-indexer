/**
 * Deployer tracker — captures token deployments and links deployers to their tokens.
 * Tracks: ERC-20 token creation (mint from 0x0), DEX pool creation, factory events.
 * Output: deployer → token mappings for reputation scoring.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { ChainConfig } from "./chains.js";
import { DATA_DIR, STATE_DIR } from "./chains.js";
import {
	ensureClickHouseTables,
	getClickHouseClient,
	toIsoTs,
} from "./clickhouse.js";

const logger = pino({ name: "deployers" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Deployment {
	deployer: string;
	tokenAddress: string;
	chain: string;
	blockNumber: number;
	blockTimestamp: string;
	txHash: string;
	type: "token" | "pool" | "factory";
	factory?: string;
}

// ---------------------------------------------------------------------------
// Known factory addresses per chain
// ---------------------------------------------------------------------------

const FACTORIES: Record<string, string[]> = {
	ethereum: [
		"0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", // Uniswap V2
		"0x1F98431c8aD98523631AE4a59f267346ea31F984", // Uniswap V3
		"0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac", // SushiSwap V2
	],
	bsc: [
		"0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", // PancakeSwap V2
		"0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", // PancakeSwap V3
	],
	arbitrum: [
		"0x1F98431c8aD98523631AE4a59f267346ea31F984", // Uniswap V3
	],
	base: [
		"0x33128a8fC17869897dcE68Ed026d694621f6FDfD", // Uniswap V3
	],
	polygon: [
		"0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", // Quickswap V2
		"0x1F98431c8aD98523631AE4a59f267346ea31F984", // Uniswap V3
	],
	// optimism: [
	//   '0x1F98431c8aD98523631AE4a59f267346ea31F984', // Uniswap V3
	// ],
	// avalanche: [
	//   '0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10', // Trader Joe V2
	// ],
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface DeployerState {
	lastBlock: number;
	deployments: number;
	trackedTokens: string[];
}

function loadState(chainId: string): DeployerState {
	const path = join(STATE_DIR, `deployers_${chainId}.json`);
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8"));
	} catch {}
	return { lastBlock: 0, deployments: 0, trackedTokens: [] };
}

function saveState(chainId: string, state: DeployerState) {
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(
		join(STATE_DIR, `deployers_${chainId}.json`),
		JSON.stringify(state, null, 2),
	);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function writeDeployments(chainId: string, deployments: Deployment[]) {
	if (deployments.length === 0) return;

	// ── NDJSON output (existing) ──
	const now = new Date();
	const yyyy = now.getUTCFullYear();
	const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(now.getUTCDate()).padStart(2, "0");
	const dir = join(DATA_DIR, chainId, "deployers", `${yyyy}-${mm}-${dd}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "deployments.jsonl");

	const lines = deployments.map((e) => JSON.stringify(e)).join("\n") + "\n";
	appendFileSync(file, lines);

	// ── ClickHouse output (new) ──
	writeDeploymentsClickHouse(chainId, deployments).catch((err) => {
		const reason = err instanceof Error ? err.message : String(err);
		logger.error(
			{ chain: chainId, err },
			`ClickHouse deployer_events batch write failed: ${reason}`,
		);
	});
}

// ---------------------------------------------------------------------------
// ClickHouse writer — deployer_events
// ---------------------------------------------------------------------------

async function writeDeploymentsClickHouse(
	chainId: string,
	deployments: Deployment[],
) {
	if (deployments.length === 0) return;
	const client = getClickHouseClient();

	const now = new Date();
	const values = deployments.map((e) => ({
		deployer: e.deployer,
		token_address: e.tokenAddress,
		chain: chainId,
		block_number: e.blockNumber,
		block_timestamp: toIsoTs(e.blockTimestamp),
		tx_hash: e.txHash,
		type: e.type,
		factory: e.factory ?? null,
		ingested_at: now.toISOString(),
	}));

	try {
		await client.insert({
			table: "deployer_events",
			values,
			format: "JSONEachRow",
		});
		logger.debug(
			{ chain: chainId, count: values.length },
			"ClickHouse deployer_events inserted",
		);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.error(
			{ err, chain: chainId, count: values.length },
			`ClickHouse deployer_events insert failed: ${reason}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Zero address (mint detection)
// ---------------------------------------------------------------------------

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// Known factory event topic: PairCreated(address,address,address,uint256)
const TOPIC_PAIR_CREATED =
	"0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";

// ---------------------------------------------------------------------------
// Main ingestion
// ---------------------------------------------------------------------------

export async function ingestDeployers(cfg: ChainConfig): Promise<void> {
	const state = loadState(cfg.id);

	if (!cfg.subsquidNetwork) {
		logger.warn(
			{ chain: cfg.id },
			"No Subsquid network — skipping deployer tracking",
		);
		return;
	}

	// Ensure ClickHouse tables exist (idempotent — runs once per process)
	await ensureClickHouseTables();

	logger.info({ chain: cfg.id }, "Starting deployer tracking");

	try {
		const { evmPortalSource, evmDecoder, commonAbis } = await import(
			"@subsquid/pipes/evm"
		);

		const stream = evmPortalSource({
			portal: `https://portal.sqd.dev/datasets/${cfg.subsquidNetwork}`,
		}).pipe(
			evmDecoder({
				events: { Transfer: commonAbis.erc20.events.Transfer },
				range: { from: 0 },
			}),
		);

		const batch: Deployment[] = [];
		const BATCH_SIZE = 1000;
		const seenTokens = new Set(state.trackedTokens);
		const factories = new Set(
			(FACTORIES[cfg.id] ?? []).map((f) => f.toLowerCase()),
		);
		let lastLoggedBlock = state.lastBlock;
		const _pendingDeployer: {
			txHash: string;
			deployer: string;
			block: number;
			ts: string;
		} | null = null;

		for await (const chunk of stream) {
			const transfers = chunk.data?.Transfer ?? [];

			for (const tx of transfers) {
				const from = (tx.event?.from ?? "").toLowerCase();
				const to = (tx.event?.to ?? "").toLowerCase();
				const contract = (tx.contract ?? "").toLowerCase();
				const txHash = tx.rawEvent?.transactionHash ?? "";
				const blockNum = tx.block?.number ?? 0;
				const ts = String(tx.timestamp ?? "");

				// Track the transaction sender as potential deployer for this block
				// (the Subsquid event includes tx origin in rawEvent.transactionIndex but not the from address)
				// We infer deployer: the first non-zero transfer FROM address that's not the token contract

				// Detect mint (transfer from zero address = token creation)
				if (from === ZERO_ADDR && !seenTokens.has(contract)) {
					seenTokens.add(contract);
					state.trackedTokens.push(contract);

					// The deployer is the FIRST recipient of a mint, or the transaction originator
					// For now: use the 'to' address of this mint as the initial deployer
					// In practice: deployer is often the recipient of the first mint
					batch.push({
						deployer: to,
						tokenAddress: contract,
						chain: cfg.id,
						blockNumber: blockNum,
						blockTimestamp: ts,
						txHash,
						type: "token",
					});
				}

				// Detect pool creation via factory PairCreated events
				// The PairCreated event is emitted by factory contracts
				if (
					tx.rawEvent?.topics?.[0] === TOPIC_PAIR_CREATED &&
					factories.has(contract)
				) {
					const decoded = tx.rawEvent?.data ?? "0x";
					const pairAddress = "0x" + decoded.slice(2, 64).slice(24); // first param after stripping padding
					if (pairAddress && pairAddress !== "0x") {
						batch.push({
							deployer: contract, // factory = deployer
							tokenAddress: pairAddress,
							chain: cfg.id,
							blockNumber: blockNum,
							blockTimestamp: ts,
							txHash,
							type: "pool",
							factory: contract,
						});
					}
				}
			}

			// Flush
			if (batch.length >= BATCH_SIZE) {
				writeDeployments(cfg.id, batch.splice(0));
				state.deployments += BATCH_SIZE;
			}

			if (transfers.length > 0) {
				const latestBlock = transfers[transfers.length - 1].block?.number;
				if (latestBlock && latestBlock - lastLoggedBlock >= 5000) {
					state.lastBlock = latestBlock;
					saveState(cfg.id, state);
					lastLoggedBlock = latestBlock;
					logger.info(
						{
							chain: cfg.id,
							block: latestBlock,
							tokens: seenTokens.size,
							deployments: state.deployments,
						},
						"Deployer progress",
					);
				}
			}
		}

		writeDeployments(cfg.id, batch.splice(0));
		saveState(cfg.id, state);
		logger.info(
			{
				chain: cfg.id,
				tokens: seenTokens.size,
				deployments: state.deployments,
			},
			"Deployer tracking complete",
		);
	} catch (err) {
		logger.error({ chain: cfg.id, err }, "Deployer tracking failed");
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Deployer scoring (called separately, batch-oriented)
// ---------------------------------------------------------------------------

export interface DeployerScore {
	address: string;
	totalTokens: number;
	activeTokens: number;
	ruggedTokens: number;
	avgMaxFDV: number;
	score: number; // 0-100, 100 = clean
	tier: "clean" | "low_risk" | "suspicious" | "high_risk" | "serial_rugger";
}

/**
 * Score a deployer based on their history.
 * This is a stub — real implementation queries chain data for rug detection.
 */
export function scoreDeployer(
	address: string,
	stats: { total: number; rugged: number; maxFDVs: number[] },
): DeployerScore {
	const total = stats.total || 0;
	const rugged = stats.rugged || 0;
	const active = total - rugged;
	const avgMaxFDV =
		stats.maxFDVs.length > 0
			? stats.maxFDVs.reduce((a, b) => a + b, 0) / stats.maxFDVs.length
			: 0;

	let score = 100;
	if (rugged > 0) score -= (rugged / Math.max(total, 1)) * 100;
	if (total === 0) score = 50;

	let tier: DeployerScore["tier"] = "clean";
	if (score < 20) tier = "serial_rugger";
	else if (score < 50) tier = "high_risk";
	else if (score < 70 && total > 3) tier = "suspicious";
	else if (score < 85) tier = "low_risk";

	return {
		address,
		totalTokens: total,
		activeTokens: active,
		ruggedTokens: rugged,
		avgMaxFDV,
		score,
		tier,
	};
}
