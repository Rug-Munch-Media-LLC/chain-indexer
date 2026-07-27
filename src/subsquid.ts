/**
 * Subsquid-based EVM ingestion via Pipes SDK.
 * Streams decoded ERC-20 Transfer events → writes NDJSON batches to disk.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
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
import { resolveToken } from "./metadata.js";

const logger = pino({ name: "subsquid" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ERC20Transfer {
	type: "transfer";
	chain: string;
	blockNumber: number;
	blockTimestamp: string;
	txHash: string;
	logIndex: number;
	from: string;
	to: string;
	tokenAddress: string;
	value: string;
	/** Resolved token metadata (added during batch write — null when unknown) */
	tokenSymbol: string | null;
	tokenName: string | null;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

interface ChainState {
	lastBlock: number;
	lastTimestamp: string;
	source: "subsquid" | "rpc" | "stopped";
}

function loadState(chainId: string): ChainState {
	const path = join(STATE_DIR, `${chainId}.json`);
	try {
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf-8"));
		}
	} catch {}
	return { lastBlock: 0, lastTimestamp: "", source: "subsquid" };
}

function saveState(chainId: string, state: ChainState) {
	mkdirSync(STATE_DIR, { recursive: true });
	const tmp = join(STATE_DIR, `${chainId}.tmp`);
	const dst = join(STATE_DIR, `${chainId}.json`);
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, dst);
}

// ---------------------------------------------------------------------------
// NDJSON writer (partitioned by chain/date)
// ---------------------------------------------------------------------------

function writeBatch(chainId: string, events: ERC20Transfer[]) {
	if (events.length === 0) return;

	// Enrich with token metadata before writing
	const enriched = events.map((e) => {
		const meta = resolveToken(chainId, e.tokenAddress);
		return {
			...e,
			tokenSymbol: meta?.symbol ?? null,
			tokenName: meta?.name ?? null,
		};
	});

	// ── NDJSON output (existing) ──
	const now = new Date();
	const yyyy = now.getUTCFullYear();
	const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(now.getUTCDate()).padStart(2, "0");
	const dir = join(DATA_DIR, chainId, `${yyyy}-${mm}-${dd}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `events.jsonl`);

	const lines = enriched.map((e) => JSON.stringify(e)).join("\n") + "\n";
	appendFileSync(file, lines);

	// ── ClickHouse output (new) ──
	writeBatchClickHouse(chainId, enriched).catch((err) => {
		logger.error(
			{ chain: chainId, err },
			"ClickHouse evm_transfers batch write failed",
		);
	});
}

// ---------------------------------------------------------------------------
// ClickHouse writer — evm_transfers
// ---------------------------------------------------------------------------

async function writeBatchClickHouse(chainId: string, events: ERC20Transfer[]) {
	if (events.length === 0) return;
	const client = getClickHouseClient();

	const now = new Date();
	const values = events.map((e) => ({
		chain: chainId,
		block_number: e.blockNumber,
		tx_hash: e.txHash,
		from_address: e.from,
		to_address: e.to,
		token_address: e.tokenAddress,
		value: e.value,
		block_timestamp: toIsoTs(e.blockTimestamp),
		log_index: e.logIndex,
		token_symbol: e.tokenSymbol,
		token_name: e.tokenName,
		ingested_at: now.toISOString(),
	}));

	try {
		await client.insert({
			table: "evm_transfers",
			values,
			format: "JSONEachRow",
		});
		logger.debug(
			{ chain: chainId, count: values.length },
			"ClickHouse evm_transfers inserted",
		);
	} catch (err) {
		logger.error(
			{ err, chain: chainId, count: values.length },
			"ClickHouse evm_transfers insert failed",
		);
	}
}

// ---------------------------------------------------------------------------
// Subsquid ingestion via Pipes SDK (ERC-20 Transfers only)
// ---------------------------------------------------------------------------

export async function ingestEvmChain(cfg: ChainConfig): Promise<void> {
	const state = loadState(cfg.id);

	if (!cfg.subsquidNetwork) {
		logger.warn(
			{ chain: cfg.id },
			"No Subsquid network — skipping EVM ingestion",
		);
		return;
	}

	// Ensure ClickHouse tables exist (idempotent — runs once per process)
	await ensureClickHouseTables();

	logger.info(
		{ chain: cfg.id, network: cfg.subsquidNetwork, fromBlock: state.lastBlock },
		"Starting Subsquid ingestion",
	);

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

		const batch: ERC20Transfer[] = [];
		const BATCH_SIZE = 10000;
		let lastLoggedBlock = state.lastBlock;

		for await (const chunk of stream) {
			const transfers = chunk.data?.Transfer ?? [];

			for (const tx of transfers) {
				batch.push({
					type: "transfer",
					chain: cfg.id,
					blockNumber: tx.block?.number ?? 0,
					blockTimestamp: String(tx.timestamp ?? ""),
					txHash: tx.rawEvent?.transactionHash ?? "",
					logIndex: tx.rawEvent?.logIndex ?? 0,
					from: tx.event?.from ?? "0x",
					to: tx.event?.to ?? "0x",
					tokenAddress: tx.contract ?? "0x",
					value: String(tx.event?.value ?? "0"),
					tokenSymbol: null,
					tokenName: null,
				});
			}

			// Flush batch when full
			if (batch.length >= BATCH_SIZE) {
				writeBatch(cfg.id, batch.splice(0));
			}

			// State update & progress log every ~1000 blocks
			if (transfers.length > 0) {
				const latestBlock = transfers[transfers.length - 1].block?.number;
				if (latestBlock && latestBlock - lastLoggedBlock >= 1000) {
					state.lastBlock = latestBlock;
					state.lastTimestamp = String(
						transfers[transfers.length - 1].timestamp ?? state.lastTimestamp,
					);
					state.source = "subsquid";
					saveState(cfg.id, state);
					lastLoggedBlock = latestBlock;
					logger.info(
						{ chain: cfg.id, block: latestBlock, batch: batch.length },
						"Progress",
					);
				}
			}
		}

		// Final flush
		writeBatch(cfg.id, batch.splice(0));
		saveState(cfg.id, state);
		logger.info(
			{ chain: cfg.id, lastBlock: state.lastBlock },
			"Subsquid stream complete",
		);
	} catch (err: unknown) {
		logger.error({ chain: cfg.id, err }, "Subsquid ingestion failed");
		throw err as any;
	}
}
