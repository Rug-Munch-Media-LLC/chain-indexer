/**
 * Subsquid-based Solana SPL token ingestion via Pipes SDK.
 * Streams token balance changes from the Token program → writes NDJSON batches to disk.
 *
 * Tracks the Solana Token program (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
 * by capturing pre/post token balance deltas per account per transaction.
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
import { DATA_DIR, STATE_DIR } from "./chains.js";
import { resolveToken } from "./metadata.js";

const logger = pino({ name: "solana" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SPLTransfer {
	type: "spl_transfer";
	chain: string;
	slot: number;
	blockTimestamp: string;
	txHash: string;
	tokenAccount: string;
	mint: string;
	preAmount: string;
	postAmount: string;
	delta: string;
	decimals: number;
	/** Resolved token metadata (added during batch write — null when unknown) */
	tokenSymbol: string | null;
	tokenName: string | null;
}

// ---------------------------------------------------------------------------
// State persistence (tracked by slot number)
// ---------------------------------------------------------------------------

interface SolanaState {
	lastSlot: number;
	lastTimestamp: string;
}

function loadState(): SolanaState {
	const path = join(STATE_DIR, "solana.json");
	try {
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf-8"));
		}
	} catch {}
	return { lastSlot: 0, lastTimestamp: "" };
}

function saveState(state: SolanaState) {
	mkdirSync(STATE_DIR, { recursive: true });
	const tmp = join(STATE_DIR, "solana.tmp");
	const dst = join(STATE_DIR, "solana.json");
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, dst);
}

// ---------------------------------------------------------------------------
// NDJSON writer (partitioned by date)
// ---------------------------------------------------------------------------

function writeBatch(events: SPLTransfer[]) {
	if (events.length === 0) return;

	// Enrich with token metadata before writing
	const enriched = events.map((e) => {
		const meta = resolveToken("solana", e.mint);
		return {
			...e,
			tokenSymbol: meta?.symbol ?? null,
			tokenName: meta?.name ?? null,
		};
	});

	const now = new Date();
	const yyyy = now.getUTCFullYear();
	const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(now.getUTCDate()).padStart(2, "0");
	const dir = join(DATA_DIR, "solana", `${yyyy}-${mm}-${dd}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "events.jsonl");

	const lines = enriched.map((e) => JSON.stringify(e)).join("\n") + "\n";
	appendFileSync(file, lines);
}

// ---------------------------------------------------------------------------
// Solana Token program ID
// ---------------------------------------------------------------------------

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// ---------------------------------------------------------------------------
// Solana ingestion via Pipes SDK (SPL Token balance changes)
// ---------------------------------------------------------------------------

export async function ingestSolana(): Promise<void> {
	const state = loadState();

	logger.info(
		{ fromSlot: state.lastSlot },
		"Starting Solana SPL token ingestion",
	);

	try {
		const { solanaPortalSource, SolanaQueryBuilder } = await import(
			"@subsquid/pipes/solana"
		);

		const startFrom = state.lastSlot > 0 ? state.lastSlot + 1 : 0;

		const query = new SolanaQueryBuilder()
			.addFields({
				block: { number: true, hash: true, timestamp: true } as const,
				transaction: { transactionIndex: true, signatures: true } as const,
				tokenBalance: {
					transactionIndex: true,
					account: true,
					preMint: true,
					preAmount: true,
					preDecimals: true,
					postMint: true,
					postAmount: true,
					postDecimals: true,
				} as const,
			})
			.addTokenBalance({
				range: { from: startFrom },
				request: { transaction: true },
			})
			.addInstruction({
				range: { from: startFrom },
				request: {
					programId: [TOKEN_PROGRAM_ID],
					transaction: true,
					transactionTokenBalances: true,
				},
			});

		const stream = solanaPortalSource({
			portal: "https://portal.sqd.dev/datasets/solana-mainnet",
			query,
		});

		const batch: SPLTransfer[] = [];
		const BATCH_SIZE = 10000;
		let lastLoggedSlot = state.lastSlot;

		for await (const chunk of stream) {
			const blocks = chunk.data?.blocks ?? [];

			for (const block of blocks) {
				const slot = block.header.number;
				const timestamp = new Date(
					Number(block.header.timestamp) * 1000,
				).toISOString();
				const tokenBalances = block.tokenBalances ?? [];

				for (const tb of tokenBalances) {
					// Parse amounts — pre/post may be undefined for new/closed accounts
					const preAmount =
						typeof tb.preAmount === "bigint" ? tb.preAmount : BigInt(0);
					const postAmount =
						typeof tb.postAmount === "bigint" ? tb.postAmount : BigInt(0);
					const delta = postAmount - preAmount;

					// Skip zero-delta (no actual balance change)
					if (delta === BigInt(0)) continue;

					// Get the mint from whichever side is available
					const mint = tb.preMint ?? tb.postMint ?? "";
					if (!mint) continue;

					const decimals = tb.preDecimals ?? tb.postDecimals ?? 0;

					// Resolve tx hash from the transaction
					const txIndex = tb.transactionIndex;
					const tx = block.transactions?.[txIndex];
					const txHash = tx?.signatures?.[0] ?? "";

					batch.push({
						type: "spl_transfer",
						chain: "solana",
						slot,
						blockTimestamp: timestamp,
						txHash,
						tokenAccount: tb.account,
						mint,
						preAmount: preAmount.toString(),
						postAmount: postAmount.toString(),
						delta: delta.toString(),
						decimals,
						tokenSymbol: null,
						tokenName: null,
					});
				}

				// Flush batch when full
				if (batch.length >= BATCH_SIZE) {
					writeBatch(batch.splice(0));
				}

				// State update & progress log every ~500 slots
				if (slot - lastLoggedSlot >= 500) {
					state.lastSlot = slot;
					state.lastTimestamp = timestamp;
					saveState(state);
					lastLoggedSlot = slot;
					logger.info({ slot, batch: batch.length }, "Solana progress");
				}
			}
		}

		// Final flush
		writeBatch(batch.splice(0));
		saveState(state);
		logger.info({ lastSlot: state.lastSlot }, "Solana stream complete");
	} catch (err: unknown) {
		logger.error({ err }, "Solana SPL token ingestion failed");
		throw err;
	}
}
