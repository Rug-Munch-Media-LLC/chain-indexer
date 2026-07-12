/**
 * Chain configurations — Subsquid portal URLs + free RPC fallback pools.
 * Add chains here to index them. Remove chains to stop indexing.
 */

export interface ChainConfig {
  id: string;
  name: string;
  /** Subsquid archive network name */
  subsquidNetwork: string | null;
  /** Free public RPC pool for fallback */
  rpcPool: string[];
  /** Block time in seconds */
  blockTime: number;
  /** Confirmations to wait before considering final */
  confirmations: number;
}

export const CHAINS: Record<string, ChainConfig> = {
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    subsquidNetwork: 'ethereum-mainnet',
    rpcPool: [
      'https://eth.llamarpc.com',
      'https://1rpc.io/eth',
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://rpc.ankr.com/eth',
    ],
    blockTime: 12,
    confirmations: 12,
  },

  bsc: {
    id: 'bsc',
    name: 'BNB Smart Chain',
    subsquidNetwork: 'binance-mainnet',
    rpcPool: [
      'https://binance.llamarpc.com',
      'https://bsc-dataseed.binance.org',
      'https://bsc-dataseed1.defibit.io',
      'https://bsc-rpc.publicnode.com',
      'https://bsc.drpc.org',
    ],
    blockTime: 3,
    confirmations: 20,
  },

  arbitrum: {
    id: 'arbitrum',
    name: 'Arbitrum One',
    subsquidNetwork: 'arbitrum-one',
    rpcPool: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum.drpc.org',
      'https://arbitrum-one-rpc.publicnode.com',
    ],
    blockTime: 0.25,
    confirmations: 12,
  },

  base: {
    id: 'base',
    name: 'Base',
    subsquidNetwork: 'base-mainnet',
    rpcPool: [
      'https://mainnet.base.org',
      'https://base.llamarpc.com',
      'https://base.drpc.org',
      'https://base-mainnet.public.blastapi.io',
    ],
    blockTime: 2,
    confirmations: 12,
  },

  polygon: {
    id: 'polygon',
    name: 'Polygon',
    subsquidNetwork: 'polygon-mainnet',
    rpcPool: [
      'https://polygon.llamarpc.com',
      'https://polygon-rpc.com',
      'https://polygon.drpc.org',
      'https://polygon-mainnet.public.blastapi.io',
    ],
    blockTime: 2,
    confirmations: 128,
  },

  tron: {
    id: 'tron',
    name: 'TRON',
    subsquidNetwork: null, // Tron not available on Subsquid — use TronGrid API
    rpcPool: ['https://api.trongrid.io', 'https://api.trongrid.io'],
    blockTime: 3,
    confirmations: 19,
  },
};

/** Chains to actually index (comment out to disable). */
export const ENABLED_CHAINS: string[] = ['ethereum', 'bsc', 'arbitrum', 'base', 'polygon', 'tron'];

export const DATA_DIR = process.env.DATA_DIR || '/srv/data/chain-indexer/jsonl';
export const STATE_DIR = process.env.STATE_DIR || '/srv/data/chain-indexer/state';
