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
		id: "ethereum",
		name: "Ethereum",
		subsquidNetwork: "ethereum-mainnet",
		rpcPool: [
			"https://eth.llamarpc.com",
			"https://1rpc.io/eth",
			"https://ethereum-rpc.publicnode.com",
			"https://eth.drpc.org",
			"https://rpc.ankr.com/eth",
		],
		blockTime: 12,
		confirmations: 12,
	},

	bsc: {
		id: "bsc",
		name: "BNB Smart Chain",
		subsquidNetwork: "binance-mainnet",
		rpcPool: [
			"https://binance.llamarpc.com",
			"https://bsc-dataseed.binance.org",
			"https://bsc-dataseed1.defibit.io",
			"https://bsc-rpc.publicnode.com",
			"https://bsc.drpc.org",
		],
		blockTime: 3,
		confirmations: 20,
	},

	arbitrum: {
		id: "arbitrum",
		name: "Arbitrum One",
		subsquidNetwork: "arbitrum-one",
		rpcPool: [
			"https://arb1.arbitrum.io/rpc",
			"https://arbitrum.drpc.org",
			"https://arbitrum-one-rpc.publicnode.com",
		],
		blockTime: 0.25,
		confirmations: 12,
	},

	base: {
		id: "base",
		name: "Base",
		subsquidNetwork: "base-mainnet",
		rpcPool: [
			"https://mainnet.base.org",
			"https://base.llamarpc.com",
			"https://base.drpc.org",
			"https://base-mainnet.public.blastapi.io",
		],
		blockTime: 2,
		confirmations: 12,
	},

	polygon: {
		id: "polygon",
		name: "Polygon",
		subsquidNetwork: "polygon-mainnet",
		rpcPool: [
			"https://polygon.llamarpc.com",
			"https://polygon-rpc.com",
			"https://polygon.drpc.org",
			"https://polygon-mainnet.public.blastapi.io",
		],
		blockTime: 2,
		confirmations: 128,
	},

	tron: {
		id: "tron",
		name: "TRON",
		subsquidNetwork: null, // Tron not available on Subsquid — use TronGrid API
		rpcPool: ["https://api.trongrid.io", "https://api.trongrid.io"],
		blockTime: 3,
		confirmations: 19,
	},

	solana: {
		id: "solana",
		name: "Solana",
		subsquidNetwork: "solana-mainnet",
		rpcPool: [
			"https://api.mainnet-beta.solana.com",
			"https://solana.drpc.org",
			"https://solana-rpc.publicnode.com",
		],
		blockTime: 0.4,
		confirmations: 32,
	},

	// ── Added: major L2s + alt L1s ──
	// NOTE: optimism + avalanche removed from ENABLED_CHAINS 2026-07-22 (never catch up)

	// optimism: {
	//   id: 'optimism',
	//   name: 'Optimism',
	//   subsquidNetwork: 'optimism-mainnet',
	//   rpcPool: [
	//     'https://mainnet.optimism.io',
	//     'https://optimism.llamarpc.com',
	//     'https://optimism.drpc.org',
	//     'https://optimism-mainnet.public.blastapi.io',
	//   ],
	//   blockTime: 2,
	//   confirmations: 12,
	// },

	// avalanche: {
	//   id: 'avalanche',
	//   name: 'Avalanche C-Chain',
	//   subsquidNetwork: 'avalanche-mainnet',
	//   rpcPool: [
	//     'https://api.avax.network/ext/bc/C/rpc',
	//     'https://avalanche.drpc.org',
	//     'https://avax.meowrpc.com',
	//   ],
	//   blockTime: 2,
	//   confirmations: 12,
	// },

	gnosis: {
		id: "gnosis",
		name: "Gnosis Chain",
		subsquidNetwork: "gnosis-mainnet",
		rpcPool: [
			"https://rpc.gnosischain.com",
			"https://gnosis.drpc.org",
			"https://gnosis-rpc.publicnode.com",
		],
		blockTime: 5,
		confirmations: 12,
	},

	fantom: {
		id: "fantom",
		name: "Fantom Opera",
		subsquidNetwork: "fantom-mainnet",
		rpcPool: [
			"https://rpcapi.fantom.network",
			"https://rpc.ftm.tools",
			"https://fantom.drpc.org",
		],
		blockTime: 1,
		confirmations: 12,
	},

	linea: {
		id: "linea",
		name: "Linea",
		subsquidNetwork: "linea-mainnet",
		rpcPool: [
			"https://rpc.linea.build",
			"https://linea.drpc.org",
			"https://linea-rpc.publicnode.com",
		],
		blockTime: 2,
		confirmations: 12,
	},

	celo: {
		id: "celo",
		name: "Celo",
		subsquidNetwork: "celo-mainnet",
		rpcPool: ["https://forno.celo.org", "https://celo.drpc.org"],
		blockTime: 5,
		confirmations: 12,
	},
};

/** Chains to actually index (comment out to disable). */
export const ENABLED_CHAINS: string[] = [
	"ethereum",
	"bsc",
	"arbitrum",
	"base",
	"polygon",
	// 'optimism',   // DROPPED 2026-07-22: 119d ETA @ 10 blk/s (5.85% progress)
	// 'avalanche',  // DROPPED 2026-07-22: 92d ETA @ 13 blk/s (5.88% progress)
	// 'gnosis',     // DROPPED 2026-07-22: stalled, no Subsquid dataset
	// 'fantom',     // DROPPED 2026-07-22: stalled, no Subsquid dataset
	// 'linea',      // DROPPED 2026-07-22: stalled, no Subsquid dataset
	// 'celo',       // DROPPED 2026-07-22: stalled, no Subsquid dataset
	"tron",
	"solana",
];

// ---------------------------------------------------------------------------
// DEX contract addresses per chain
// ---------------------------------------------------------------------------

export interface DexContract {
	name: string;
	v2Factory?: string;
	v3Factory?: string;
	router?: string;
}

/**
 * Known DEX factory/router addresses per chain.
 * Used by dex.ts to tag swap/liquidity events with the correct DEX name.
 */
export const DEX_CONFIGS: Record<string, DexContract[]> = {
	ethereum: [
		{
			name: "uniswap_v2",
			v2Factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
			router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
		},
		{
			name: "uniswap_v3",
			v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
		},
		{
			name: "sushiswap",
			v2Factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
			router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
		},
	],

	bsc: [
		{
			name: "pancakeswap",
			v2Factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
			router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
		},
	],

	polygon: [
		{
			name: "quickswap",
			v2Factory: "0x5757371414417b8C6CAad45bAeF941aBC7d3Ab32",
			router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
		},
	],

	arbitrum: [
		{
			name: "uniswap_v3",
			v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
		},
	],

	base: [
		{
			name: "uniswap_v3",
			v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
		},
	],

	// optimism: [
	//   {
	//     name: 'uniswap_v3',
	//     v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
	//   },
	// ],

	// avalanche: [
	//   {
	//     name: 'traderjoe',
	//     v2Factory: '0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10',
	//     router: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
	//   },
	// ],
};

export const DATA_DIR = process.env.DATA_DIR || "/path/to/data/chain-indexer/jsonl";
export const STATE_DIR =
	process.env.STATE_DIR || "/path/to/data/chain-indexer/state";
