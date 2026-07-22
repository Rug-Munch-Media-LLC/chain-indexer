#!/usr/bin/env tsx
/**
 * chain-indexer — Multi-chain blockchain data ingestion
 *
 * Sources: Subsquid (EVM) → TronGrid (Tron) → free RPC pool (fallback)
 * Output: NDJSON → Parquet → Cloudflare R2
 *
 * Usage:
 *   tsx src/index.ts                    # start all chains
 *   tsx src/index.ts --chain ethereum   # start one chain
 *   tsx src/index.ts --sync             # run R2 sync once and exit
 */

import { mkdirSync } from 'node:fs';
import pino from 'pino';
import { program } from 'commander';
import { CHAINS, ENABLED_CHAINS, DATA_DIR, STATE_DIR, type ChainConfig } from './chains.js';
import { ingestEvmChain } from './subsquid.js';
import { ingestDexChain } from './dex.js';
import { ingestDeployers } from './deployers.js';
import { ingestTron } from './tron.js';
import { ingestSolana } from './solana.js';
import { syncToR2 } from './sync.js';
import { startParquetScheduler } from './parquet.js';

const logger = pino({
  name: 'chain-indexer',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

program
  .name('chain-indexer')
  .description('Multi-chain blockchain data ingestion → Parquet → R2')
  .version('0.1.0')
  .option('-c, --chain <id>', 'Index a single chain (default: all enabled)')
  .option('--sync', 'Run R2 sync once and exit')
  .option('--data-dir <path>', 'Data directory', DATA_DIR)
  .option('--state-dir <path>', 'State directory', STATE_DIR)
  .parse();

const opts = program.opts();

// ---------------------------------------------------------------------------
// R2 sync mode
// ---------------------------------------------------------------------------

if (opts.sync) {
  logger.info('Running R2 sync');
  await syncToR2();
  logger.info('R2 sync complete');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

const chains: ChainConfig[] = opts.chain
  ? [CHAINS[opts.chain]].filter(Boolean)
  : ENABLED_CHAINS.map((id) => CHAINS[id]).filter(Boolean);

if (chains.length === 0) {
  logger.error('No chains configured');
  process.exit(1);
}

logger.info({ chains: chains.map((c) => c.id) }, 'Starting chain-indexer');

// ---------------------------------------------------------------------------
// Run per-chain ingestion (parallel, each in its own async loop)
// ---------------------------------------------------------------------------

const runners = chains.map(async (cfg) => {
  while (true) {
    try {
      if (cfg.id === 'tron') {
        // Tron: poll-based, runs a batch then sleeps
        await ingestTron(cfg);
        await new Promise((r) => setTimeout(r, cfg.blockTime * 1000 * 20)); // sleep ~1 min
      } else if (cfg.id === 'solana') {
        // Solana: Subsquid-based SPL token stream (long-running, auto-resumes)
        await ingestSolana();
      } else if (cfg.subsquidNetwork) {
        // EVM: Subsquid stream (long-running, auto-resumes on error)
        // Run ERC-20 + DEX + deployer tracking concurrently per chain
        await Promise.all([ingestEvmChain(cfg), ingestDexChain(cfg), ingestDeployers(cfg)]);
      } else {
        logger.warn({ chain: cfg.id }, 'No ingestion method configured');
      }
    } catch (err) {
      logger.error({ chain: cfg.id, err }, 'Ingestion error — retrying in 30s');
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
});

// ---------------------------------------------------------------------------
// Periodic R2 sync (every 15 minutes)
// DISABLED by default: raw NDJSON sync was an uncompressed double-bake with
// sync-deletes semantics (rclone sync deletes remote files not present
// locally — torched local = torched "archive"). The compressed, verified,
// immutable archive pipeline lives in scripts/chain-indexer-guard.sh
// (r2:backups/chain-indexer/). Set R2_RAW_SYNC=on to re-enable.
// ---------------------------------------------------------------------------

const rawSyncEnabled = process.env.R2_RAW_SYNC === 'on';

const syncInterval = rawSyncEnabled
  ? setInterval(
      async () => {
        try {
          await syncToR2();
        } catch (err) {
          logger.error({ err }, 'R2 sync failed');
        }
      },
      15 * 60 * 1000,
    )
  : null;

if (!rawSyncEnabled) {
  logger.info('Raw R2 sync disabled (guard.sh owns the archive pipeline)');
}

// ---------------------------------------------------------------------------
// Hourly NDJSON → Parquet conversion (auto-starts at next hour, then periodic)
// ---------------------------------------------------------------------------

const parquetInterval = startParquetScheduler();

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down');
  if (syncInterval) clearInterval(syncInterval);
  clearInterval(parquetInterval);

  if (!rawSyncEnabled) {
    process.exit(0);
  }

  // Final sync with 30s timeout (don't hang shutdown on large syncs)
  const timeout = setTimeout(() => {
    logger.warn('Final R2 sync timed out — exiting');
    process.exit(0);
  }, 30_000);

  syncToR2()
    .then(() => logger.info('Final R2 sync complete'))
    .catch((err) => logger.error({ err }, 'Final R2 sync failed'))
    .finally(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received');
  process.exit(0);
});

logger.info('chain-indexer running — press Ctrl+C to stop');
await Promise.all(runners);
