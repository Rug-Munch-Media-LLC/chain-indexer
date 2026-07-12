/**
 * Subsquid-based EVM ingestion via Pipes SDK.
 * Streams decoded Transfer & Swap events → writes NDJSON batches to disk.
 *
 * Falls back to free RPC pool if Subsquid is unavailable.
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type { ChainConfig } from './chains.js';
import { DATA_DIR, STATE_DIR } from './chains.js';

const logger = pino({ name: 'subsquid' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ERC20Transfer {
  type: 'transfer';
  chain: string;
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  tokenAddress: string;
  value: string;
}

interface DexSwap {
  type: 'swap';
  chain: string;
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  contractAddress: string;
  sender: string;
  recipient: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  dexName: string;
}

type IngestedEvent = ERC20Transfer | DexSwap;

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

interface ChainState {
  lastBlock: number;
  lastTimestamp: number;
  source: 'subsquid' | 'rpc' | 'stopped';
}

function loadState(chainId: string): ChainState {
  const path = join(STATE_DIR, `${chainId}.json`);
  try {
    if (existsSync(path)) {
      return JSON.parse(require('node:fs').readFileSync(path, 'utf-8'));
    }
  } catch {}
  return { lastBlock: 0, lastTimestamp: 0, source: 'subsquid' };
}

function saveState(chainId: string, state: ChainState) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = join(STATE_DIR, `${chainId}.tmp`);
  const dst = join(STATE_DIR, `${chainId}.json`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  require('node:fs').renameSync(tmp, dst);
}

// ---------------------------------------------------------------------------
// NDJSON writer (partitioned by chain/date)
// ---------------------------------------------------------------------------

function writeBatch(chainId: string, events: IngestedEvent[]) {
  if (events.length === 0) return;

  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const dir = join(DATA_DIR, chainId, `${yyyy}-${mm}-${dd}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `events.jsonl`);

  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(file, lines);
}

// ---------------------------------------------------------------------------
// Subsquid ingestion via Pipes SDK
// ---------------------------------------------------------------------------

export async function ingestEvmChain(cfg: ChainConfig): Promise<void> {
  const state = loadState(cfg.id);

  if (!cfg.subsquidNetwork) {
    logger.warn({ chain: cfg.id }, 'No Subsquid network — skipping EVM ingestion');
    return;
  }

  logger.info({ chain: cfg.id, network: cfg.subsquidNetwork }, 'Starting Subsquid ingestion');

  // Use the Subsquid Pipes SDK for EVM data streaming
  // The Pipes SDK handles: batching, retries, rate limiting, ABI decoding
  try {
    const { evmPortalSource, evmDecoder, commonAbis } = await import('@subsquid/pipes/evm');

    const stream = evmPortalSource({
      portal: `https://portal.sqd.dev/datasets/${cfg.subsquidNetwork}`,
      fromBlock: state.lastBlock || undefined,
    }).pipe(
      evmDecoder({
        events: {
          transfers: commonAbis.erc20.events.Transfer,
          swaps: [commonAbis.uniswapV3.events.Swap],
        },
      }),
    );

    let batch: IngestedEvent[] = [];
    const BATCH_SIZE = 10000;

    for await (const chunk of stream) {
      const blockNum = chunk.header?.number;
      const blockTs = chunk.header?.timestamp;

      // Process transfers
      for (const tx of chunk.data.transfers ?? []) {
        batch.push({
          type: 'transfer',
          chain: cfg.id,
          blockNumber: blockNum ?? 0,
          blockTimestamp: blockTs ?? 0,
          txHash: tx.transaction.hash,
          logIndex: tx.logIndex ?? 0,
          from: tx.from,
          to: tx.to,
          tokenAddress: tx.address,
          value: tx.value.toString(),
        });
      }

      // Process swaps
      for (const tx of chunk.data.swaps ?? []) {
        batch.push({
          type: 'swap',
          chain: cfg.id,
          blockNumber: blockNum ?? 0,
          blockTimestamp: blockTs ?? 0,
          txHash: tx.transaction.hash,
          contractAddress: tx.address,
          sender: tx.sender,
          recipient: tx.recipient,
          tokenIn: tx.token0,
          tokenOut: tx.token1,
          amountIn: tx.amount0.toString(),
          amountOut: tx.amount1.toString(),
          dexName: 'UniswapV3',
        });
      }

      // Flush batch when full
      if (batch.length >= BATCH_SIZE) {
        writeBatch(cfg.id, batch.splice(0));
      }

      // Update state every 1000 blocks
      if (blockNum && blockNum % 1000 === 0) {
        state.lastBlock = blockNum;
        state.lastTimestamp = blockTs ?? state.lastTimestamp;
        state.source = 'subsquid';
        saveState(cfg.id, state);
        logger.info({ chain: cfg.id, block: blockNum, batch: batch.length }, 'Progress');
      }
    }

    // Final flush
    writeBatch(cfg.id, batch.splice(0));
    saveState(cfg.id, state);
    logger.info({ chain: cfg.id }, 'Subsquid stream ended — ingestion complete');
  } catch (err) {
    logger.error({ chain: cfg.id, err }, 'Subsquid ingestion failed');
    throw err;
  }
}
