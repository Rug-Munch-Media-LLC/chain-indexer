/**
 * Tron ingestion via TronGrid API.
 * Subsquid doesn't support Tron, so we use TronGrid's event API directly.
 *
 * Polls TRC-20 Transfer events via /v1/contracts/{address}/events
 * Writes to the same NDJSON format as the Subsquid pipeline.
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

const logger = pino({ name: "tron" });

// ---------------------------------------------------------------------------
// Major TRC-20 tokens to track
// ---------------------------------------------------------------------------

const TRC20_TOKENS = [
	{ address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", name: "USDT" }, // USDT on Tron
	{ address: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8", name: "USDC" }, // USDC on Tron
	{ address: "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", name: "WTRX" }, // Wrapped TRX
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TronTransfer {
	type: "transfer";
	chain: string;
	blockNumber: number;
	blockTimestamp: number;
	txHash: string;
	from: string;
	to: string;
	tokenAddress: string;
	value: string;
	tokenName: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface TronState {
	lastBlock: number;
	lastTimestamp: number;
}

function loadState(): TronState {
	const path = join(STATE_DIR, "tron.json");
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8"));
	} catch {}
	return { lastBlock: 0, lastTimestamp: 0 };
}

function saveState(state: TronState) {
	mkdirSync(STATE_DIR, { recursive: true });
	const tmp = join(STATE_DIR, "tron.tmp");
	const dst = join(STATE_DIR, "tron.json");
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, dst);
}

// ---------------------------------------------------------------------------
// NDJSON writer
// ---------------------------------------------------------------------------

function writeTronBatch(events: TronTransfer[]) {
	if (events.length === 0) return;
	const now = new Date();
	const yyyy = now.getUTCFullYear();
	const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(now.getUTCDate()).padStart(2, "0");
	const dir = join(DATA_DIR, "tron", `${yyyy}-${mm}-${dd}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "events.jsonl");
	const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
	appendFileSync(file, lines);
}

// ---------------------------------------------------------------------------
// TronGrid API client
// ---------------------------------------------------------------------------

async function fetchFromTronGrid(
	path: string,
	params: Record<string, string> = {},
): Promise<any> {
	const url = new URL(path, "https://api.trongrid.io");
	for (const [k, v] of Object.entries(params)) {
		url.searchParams.set(k, v);
	}

	const resp = await fetch(url.toString(), {
		headers: { Accept: "application/json" },
	});

	if (!resp.ok) {
		if (resp.status === 429) {
			throw new Error(`TronGrid rate limited`);
		}
		throw new Error(`TronGrid HTTP ${resp.status}`);
	}

	return resp.json();
}

async function getLatestBlock(): Promise<number> {
	const wallet = await fetchFromTronGrid("/wallet/getnowblock");
	return wallet.block_header?.raw_data?.number ?? 0;
}

async function getBlockEvents(
	blockMin: number,
	blockMax: number,
	tokenAddress: string,
): Promise<TronTransfer[]> {
	const events: TronTransfer[] = [];
	const token = TRC20_TOKENS.find((t) => t.address === tokenAddress);

	// TronGrid event API: /v1/contracts/{address}/events?event_name=Transfer&min_block=...
	const result = await fetchFromTronGrid(
		`/v1/contracts/${tokenAddress}/events`,
		{
			event_name: "Transfer",
			min_block_timestamp: String(Math.floor(Date.now() / 1000) - 300),
			limit: "200",
			order_by: "block_timestamp,asc",
		},
	);

	for (const ev of result.data ?? []) {
		events.push({
			type: "transfer",
			chain: "tron",
			blockNumber: ev.block_number ?? 0,
			blockTimestamp: (ev.block_timestamp ?? 0) / 1000,
			txHash: ev.transaction_id ?? "",
			from: ev.result?.from ?? "",
			to: ev.result?.to ?? "",
			tokenAddress: tokenAddress,
			value: ev.result?.value ?? "0",
			tokenName: token?.name ?? "unknown",
		});
	}

	return events;
}

// ---------------------------------------------------------------------------
// Main ingestion loop
// ---------------------------------------------------------------------------

export async function ingestTron(cfg: ChainConfig): Promise<void> {
	const state = loadState();
	logger.info({ chain: "tron" }, "Starting TronGrid ingestion");

	try {
		// Poll each TRC-20 token
		const allEvents: TronTransfer[] = [];

		for (const token of TRC20_TOKENS) {
			logger.info({ token: token.name }, "Fetching Tron events");
			const events = await getBlockEvents(
				state.lastBlock,
				state.lastBlock + 1000,
				token.address,
			);
			allEvents.push(...events);
		}

		// Deduplicate by txHash+logIndex
		const seen = new Set<string>();
		const unique = allEvents.filter((e) => {
			const key = `${e.txHash}:${e.from}:${e.to}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

		writeTronBatch(unique);

		// Update state
		const head = await getLatestBlock();
		state.lastBlock = head;
		state.lastTimestamp = Math.floor(Date.now() / 1000);
		saveState(state);

		logger.info(
			{ chain: "tron", events: unique.length, head },
			"Tron batch complete",
		);
	} catch (err) {
		logger.error({ chain: "tron", err }, "TronGrid ingestion failed");
		throw err;
	}
}
