/**
 * DEX event ingestion (swaps + liquidity events) via Subsquid Pipes SDK.
 *
 * Tracks Uniswap V2/V3 Swap, Mint, Burn events and applies whale flagging.
 * Writes NDJSON batches partitioned by chain/date, same pattern as subsquid.ts.
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type { ChainConfig } from './chains.js';
import { DATA_DIR, STATE_DIR, DEX_CONFIGS } from './chains.js';

const logger = pino({ name: 'dex' });

// ---------------------------------------------------------------------------
// Event ABI definitions (manual — no commonAbis.uniswap export exists)
// ---------------------------------------------------------------------------

// We import event() and indexed() from @subsquid/evm-abi, plus codecs from
// @subsquid/evm-codec.  These are already transitive deps of @subsquid/pipes.

type AbiEventModule = {
  event: (topic: string, signature: string, args: Record<string, any>) => any;
  indexed: (codec: any) => any;
};

type CodecModule = {
  address: any;
  uint256: any;
  int256: any;
  uint160: any;
  uint128: any;
  int24: any;
};

// Lazily loaded after SDK import
let _abi: AbiEventModule | null = null;
let _p: CodecModule | null = null;

async function ensureEvents(): Promise<{
  v2Swap: any;
  v3Swap: any;
  v2Mint: any;
  v2Burn: any;
  v3Mint: any;
  v3Burn: any;
}> {
  if (!_abi) {
    const [evmAbi, evmCodec] = await Promise.all([
      import('@subsquid/evm-abi') as Promise<AbiEventModule>,
      import('@subsquid/evm-codec') as Promise<CodecModule>,
    ]);
    _abi = evmAbi;
    _p = evmCodec;
  }
  const { event, indexed } = _abi;
  const p = _p!;

  return {
    v2Swap: event(
      '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
      'Swap(address,uint256,uint256,uint256,uint256,address)',
      {
        sender: indexed(p.address),
        amount0In: p.uint256,
        amount1In: p.uint256,
        amount0Out: p.uint256,
        amount1Out: p.uint256,
        to: indexed(p.address),
      },
    ),

    v3Swap: event(
      '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
      'Swap(address,address,int256,int256,uint160,uint128,int24)',
      {
        sender: indexed(p.address),
        recipient: indexed(p.address),
        amount0: p.int256,
        amount1: p.int256,
        sqrtPriceX96: p.uint160,
        liquidity: p.uint128,
        tick: p.int24,
      },
    ),

    v2Mint: event(
      '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
      'Mint(address,uint256,uint256)',
      {
        sender: indexed(p.address),
        amount0: p.uint256,
        amount1: p.uint256,
      },
    ),

    v2Burn: event(
      '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496',
      'Burn(address,uint256,uint256,address)',
      {
        sender: indexed(p.address),
        amount0: p.uint256,
        amount1: p.uint256,
        to: indexed(p.address),
      },
    ),

    v3Mint: event(
      '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
      'Mint(address,address,int24,int24,uint128,uint256,uint256)',
      {
        sender: indexed(p.address),
        owner: indexed(p.address),
        tickLower: p.int24,
        tickUpper: p.int24,
        amount: p.uint128,
        amount0: p.uint256,
        amount1: p.uint256,
      },
    ),

    v3Burn: event(
      '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
      'Burn(address,int24,int24,uint128,uint256,uint256)',
      {
        owner: indexed(p.address),
        tickLower: indexed(p.int24),
        tickUpper: indexed(p.int24),
        amount: p.uint128,
        amount0: p.uint256,
        amount1: p.uint256,
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DexEvent {
  type: 'swap' | 'mint' | 'burn';
  chain: string;
  blockNumber: number;
  blockTimestamp: string;
  txHash: string;
  logIndex: number;
  contractAddress: string;
  dex: string;
  /** V2 or V3 — set by the emitted event signature */
  version: 'v2' | 'v3';
  token0: string;
  token1: string;
  sender?: string;
  recipient?: string;
  /** Swap amounts (v2) */
  amount0In?: string;
  amount1In?: string;
  amount0Out?: string;
  amount1Out?: string;
  /** Swap amounts (v3) */
  amount0?: string;
  amount1?: string;
  /** Whale flag */
  whale: boolean;
}

// ---------------------------------------------------------------------------
// Whale thresholds by chain (in wei, approximate)
// ---------------------------------------------------------------------------

const WHALE_THRESHOLDS: Record<string, bigint> = {
  ethereum: BigInt('10000000000000000000'), // 10 ETH
  bsc: BigInt('50000000000000000000'), // 50 BNB
  polygon: BigInt('50000000000000000000000'), // 50K MATIC
  arbitrum: BigInt('10000000000000000000'), // 10 ETH
  base: BigInt('10000000000000000000'), // 10 ETH
  optimism: BigInt('10000000000000000000'), // 10 ETH
  avalanche: BigInt('500000000000000000000'), // 500 AVAX
  gnosis: BigInt('50000000000000000000'), // 50 xDAI
  fantom: BigInt('500000000000000000000'), // 500 FTM
  linea: BigInt('10000000000000000000'), // 10 ETH
  celo: BigInt('50000000000000000000'), // 50 CELO
};

function isWhale(value: bigint, chain: string): boolean {
  const threshold = WHALE_THRESHOLDS[chain];
  if (!threshold) return false;
  // For negative amounts (V3 outflows) check absolute value
  const abs = value < 0n ? -value : value;
  return abs >= threshold;
}

// ---------------------------------------------------------------------------
// DEX name resolution from contract address
// ---------------------------------------------------------------------------

/** Build a reverse map: contractAddress -> dexName for known DEX routers/factories */
function buildContractToDexMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [chain, dexes] of Object.entries(DEX_CONFIGS)) {
    for (const d of dexes) {
      if (d.router) map.set(d.router.toLowerCase(), d.name);
      if (d.v2Factory) map.set(d.v2Factory.toLowerCase(), d.name);
      if (d.v3Factory) map.set(d.v3Factory.toLowerCase(), d.name);
    }
  }
  return map;
}

let _contractToDex: Map<string, string> | null = null;
function resolveDex(contractAddress: string, version: 'v2' | 'v3', chain: string): string {
  if (!_contractToDex) _contractToDex = buildContractToDexMap();

  const addr = contractAddress.toLowerCase();
  const known = _contractToDex.get(addr);
  if (known) return known;

  // If the contract's factory is known (subset of DEX pairs) — we can't
  // resolve pair→factory without an external DB.  Use version as fallback.
  return version === 'v2' ? 'v2' : 'v3';
}

// ---------------------------------------------------------------------------
// NDJSON writer (subdirectory: dex/)
// ---------------------------------------------------------------------------

function writeDexBatch(chainId: string, events: DexEvent[]) {
  if (events.length === 0) return;

  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const dir = join(DATA_DIR, chainId, 'dex', `${yyyy}-${mm}-${dd}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `events.jsonl`);

  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(file, lines);
}

// ---------------------------------------------------------------------------
// Chain state
// ---------------------------------------------------------------------------

interface DexState {
  lastBlock: number;
  lastTimestamp: string;
}

function loadDexState(chainId: string): DexState {
  const path = join(STATE_DIR, `${chainId}-dex.json`);
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  return { lastBlock: 0, lastTimestamp: '' };
}

function saveDexState(chainId: string, state: DexState) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = join(STATE_DIR, `${chainId}-dex.tmp`);
  const dst = join(STATE_DIR, `${chainId}-dex.json`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, dst);
}

// ---------------------------------------------------------------------------
// Main ingestion
// ---------------------------------------------------------------------------

export async function ingestDexChain(cfg: ChainConfig): Promise<void> {
  if (!cfg.subsquidNetwork) {
    logger.warn({ chain: cfg.id }, 'No Subsquid network — skipping DEX ingestion');
    return;
  }

  const state = loadDexState(cfg.id);
  const { evmPortalSource, evmDecoder } = await import('@subsquid/pipes/evm');

  logger.info(
    { chain: cfg.id, network: cfg.subsquidNetwork, fromBlock: state.lastBlock },
    'Starting DEX ingestion',
  );

  try {
    const events = await ensureEvents();

    const stream = evmPortalSource({
      portal: `https://portal.sqd.dev/datasets/${cfg.subsquidNetwork}`,
    }).pipe(
      evmDecoder({
        events: {
          SwapV2: events.v2Swap,
          SwapV3: events.v3Swap,
          MintV2: events.v2Mint,
          BurnV2: events.v2Burn,
          MintV3: events.v3Mint,
          BurnV3: events.v3Burn,
        },
        range: { from: 0 },
      }),
    );

    let batch: DexEvent[] = [];
    const BATCH_SIZE = 10_000;
    let lastLoggedBlock = state.lastBlock;

    for await (const chunk of stream) {
      // --- V2 Swaps ---
      for (const tx of chunk.data?.SwapV2 ?? []) {
        const amt0In: bigint = tx.event?.amount0In ?? 0n;
        const amt1In: bigint = tx.event?.amount1In ?? 0n;
        const amt0Out: bigint = tx.event?.amount0Out ?? 0n;
        const amt1Out: bigint = tx.event?.amount1Out ?? 0n;

        batch.push({
          type: 'swap',
          chain: cfg.id,
          blockNumber: tx.block?.number ?? 0,
          blockTimestamp: String(tx.timestamp ?? ''),
          txHash: tx.rawEvent?.transactionHash ?? '',
          logIndex: tx.rawEvent?.logIndex ?? 0,
          contractAddress: tx.contract ?? '0x',
          dex: resolveDex(tx.contract ?? '', 'v2', cfg.id),
          version: 'v2',
          token0: '',
          token1: '',
          sender: tx.event?.sender ?? '',
          recipient: tx.event?.to ?? '',
          amount0In: String(amt0In),
          amount1In: String(amt1In),
          amount0Out: String(amt0Out),
          amount1Out: String(amt1Out),
          whale:
            isWhale(amt0In, cfg.id) ||
            isWhale(amt1In, cfg.id) ||
            isWhale(amt0Out, cfg.id) ||
            isWhale(amt1Out, cfg.id),
        });
      }

      // --- V3 Swaps ---
      for (const tx of chunk.data?.SwapV3 ?? []) {
        const amt0: bigint = tx.event?.amount0 ?? 0n;
        const amt1: bigint = tx.event?.amount1 ?? 0n;

        batch.push({
          type: 'swap',
          chain: cfg.id,
          blockNumber: tx.block?.number ?? 0,
          blockTimestamp: String(tx.timestamp ?? ''),
          txHash: tx.rawEvent?.transactionHash ?? '',
          logIndex: tx.rawEvent?.logIndex ?? 0,
          contractAddress: tx.contract ?? '0x',
          dex: resolveDex(tx.contract ?? '', 'v3', cfg.id),
          version: 'v3',
          token0: '',
          token1: '',
          sender: tx.event?.sender ?? '',
          recipient: tx.event?.recipient ?? '',
          amount0: String(amt0),
          amount1: String(amt1),
          whale: isWhale(amt0, cfg.id) || isWhale(amt1, cfg.id),
        });
      }

      // --- V2 Mints ---
      for (const tx of chunk.data?.MintV2 ?? []) {
        const amt0: bigint = tx.event?.amount0 ?? 0n;
        const amt1: bigint = tx.event?.amount1 ?? 0n;

        batch.push({
          type: 'mint',
          chain: cfg.id,
          blockNumber: tx.block?.number ?? 0,
          blockTimestamp: String(tx.timestamp ?? ''),
          txHash: tx.rawEvent?.transactionHash ?? '',
          logIndex: tx.rawEvent?.logIndex ?? 0,
          contractAddress: tx.contract ?? '0x',
          dex: resolveDex(tx.contract ?? '', 'v2', cfg.id),
          version: 'v2',
          token0: '',
          token1: '',
          sender: tx.event?.sender ?? '',
          amount0: String(amt0),
          amount1: String(amt1),
          whale: isWhale(amt0, cfg.id) || isWhale(amt1, cfg.id),
        });
      }

      // --- V2 Burns ---
      for (const tx of chunk.data?.BurnV2 ?? []) {
        const amt0: bigint = tx.event?.amount0 ?? 0n;
        const amt1: bigint = tx.event?.amount1 ?? 0n;

        batch.push({
          type: 'burn',
          chain: cfg.id,
          blockNumber: tx.block?.number ?? 0,
          blockTimestamp: String(tx.timestamp ?? ''),
          txHash: tx.rawEvent?.transactionHash ?? '',
          logIndex: tx.rawEvent?.logIndex ?? 0,
          contractAddress: tx.contract ?? '0x',
          dex: resolveDex(tx.contract ?? '', 'v2', cfg.id),
          version: 'v2',
          token0: '',
          token1: '',
          sender: tx.event?.sender ?? '',
          recipient: tx.event?.to ?? '',
          amount0: String(amt0),
          amount1: String(amt1),
          whale: isWhale(amt0, cfg.id) || isWhale(amt1, cfg.id),
        });
      }

      // --- V3 Mints ---
      for (const tx of chunk.data?.MintV3 ?? []) {
        const amt0: bigint = tx.event?.amount0 ?? 0n;
        const amt1: bigint = tx.event?.amount1 ?? 0n;

        batch.push({
          type: 'mint',
          chain: cfg.id,
          blockNumber: tx.block?.number ?? 0,
          blockTimestamp: String(tx.timestamp ?? ''),
          txHash: tx.rawEvent?.transactionHash ?? '',
          logIndex: tx.rawEvent?.logIndex ?? 0,
          contractAddress: tx.contract ?? '0x',
          dex: resolveDex(tx.contract ?? '', 'v3', cfg.id),
          version: 'v3',
          token0: '',
          token1: '',
          sender: tx.event?.sender ?? '',
          recipient: tx.event?.owner ?? '',
          amount0: String(amt0),
          amount1: String(amt1),
          whale: isWhale(amt0, cfg.id) || isWhale(amt1, cfg.id),
        });
      }

      // --- V3 Burns ---
      for (const tx of chunk.data?.BurnV3 ?? []) {
        const amt0: bigint = tx.event?.amount0 ?? 0n;
        const amt1: bigint = tx.event?.amount1 ?? 0n;

        batch.push({
          type: 'burn',
          chain: cfg.id,
          blockNumber: tx.block?.number ?? 0,
          blockTimestamp: String(tx.timestamp ?? ''),
          txHash: tx.rawEvent?.transactionHash ?? '',
          logIndex: tx.rawEvent?.logIndex ?? 0,
          contractAddress: tx.contract ?? '0x',
          dex: resolveDex(tx.contract ?? '', 'v3', cfg.id),
          version: 'v3',
          token0: '',
          token1: '',
          sender: tx.event?.owner ?? '',
          amount0: String(amt0),
          amount1: String(amt1),
          whale: isWhale(amt0, cfg.id) || isWhale(amt1, cfg.id),
        });
      }

      // Flush batch
      if (batch.length >= BATCH_SIZE) {
        writeDexBatch(cfg.id, batch.splice(0));
      }

      // State update — use whichever event array has data
      const allData = [
        ...(chunk.data?.SwapV2 ?? []),
        ...(chunk.data?.SwapV3 ?? []),
        ...(chunk.data?.MintV2 ?? []),
        ...(chunk.data?.BurnV2 ?? []),
        ...(chunk.data?.MintV3 ?? []),
        ...(chunk.data?.BurnV3 ?? []),
      ];

      if (allData.length > 0) {
        const latestBlock = allData[allData.length - 1].block?.number;
        if (latestBlock && latestBlock - lastLoggedBlock >= 1000) {
          state.lastBlock = latestBlock;
          state.lastTimestamp = String(
            allData[allData.length - 1].timestamp ?? state.lastTimestamp,
          );
          saveDexState(cfg.id, state);
          lastLoggedBlock = latestBlock;
          logger.info(
            { chain: cfg.id, block: latestBlock, dexBatch: batch.length },
            'DEX progress',
          );
        }
      }
    }

    // Final flush
    writeDexBatch(cfg.id, batch.splice(0));
    saveDexState(cfg.id, state);
    logger.info({ chain: cfg.id, lastBlock: state.lastBlock }, 'DEX stream complete');
  } catch (err) {
    logger.error({ chain: cfg.id, err }, 'DEX ingestion failed');
    throw err;
  }
}
