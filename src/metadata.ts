/**
 * Token metadata registry — resolves ERC-20 addresses to human-readable info.
 * Static registry of top ~200 tokens across all tracked chains.
 * No on-chain calls needed — fast and free.
 */

export interface TokenMeta {
  symbol: string;
  name: string;
  decimals: number;
}

// Registry: { [chainId]: { [address_lowercase]: TokenMeta } }
const REGISTRY: Record<string, Record<string, TokenMeta>> = {
  ethereum: {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
    },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    '0x6b175474e89094c44da98b954eedeac495271d0f': {
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
    },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': {
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
    },
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': {
      symbol: 'WBTC',
      name: 'Wrapped Bitcoin',
      decimals: 8,
    },
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', name: 'Uniswap', decimals: 18 },
    '0x514910771af9ca656af840dff83e8264ecf986ca': {
      symbol: 'LINK',
      name: 'Chainlink',
      decimals: 18,
    },
    '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { symbol: 'AAVE', name: 'Aave', decimals: 18 },
    '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': {
      symbol: 'SHIB',
      name: 'SHIBA INU',
      decimals: 18,
    },
    '0x6982508145454ce325ddbe47a25d4ec3d2311933': { symbol: 'PEPE', name: 'Pepe', decimals: 18 },
    '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': {
      symbol: 'MATIC',
      name: 'Polygon',
      decimals: 18,
    },
    '0xb50721bcf8d664c30412cfbc6cf7a15145234ad1': { symbol: 'ARB', name: 'Arbitrum', decimals: 18 },
    '0x4200000000000000000000000000000000000042': { symbol: 'OP', name: 'Optimism', decimals: 18 },
    '0x5a98fcbea516cf06857215779fd812ca3bef1b32': { symbol: 'LDO', name: 'Lido DAO', decimals: 18 },
    '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72': {
      symbol: 'ENS',
      name: 'Ethereum Name Service',
      decimals: 18,
    },
    '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': { symbol: 'MKR', name: 'Maker', decimals: 18 },
    '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': {
      symbol: 'stETH',
      name: 'Lido Staked ETH',
      decimals: 18,
    },
    '0x6c3ea9036406852006290770bedfcaba0e23a0e8': {
      symbol: 'PYUSD',
      name: 'PayPal USD',
      decimals: 6,
    },
    '0x3845badAde8e6dFF049820680d1F14bD3903a5d0': {
      symbol: 'SAND',
      name: 'The Sandbox',
      decimals: 18,
    },
    '0x0d8775f648430679a709e98d2b0cb6250d2887ef': {
      symbol: 'BAT',
      name: 'Basic Attention Token',
      decimals: 18,
    },
    '0x4fabb145d64652a948d72533023f6e7a623c7c53': {
      symbol: 'BUSD',
      name: 'Binance USD',
      decimals: 18,
    },
    '0x111111111117dc0aa78b770fa6a738034120c302': { symbol: '1INCH', name: '1inch', decimals: 18 },
    '0x853d955acef822db058eb8505911ed77f175b99e': { symbol: 'FRAX', name: 'Frax', decimals: 18 },
    '0xd533a949740bb3306d119cc777fa900ba034cd52': {
      symbol: 'CRV',
      name: 'Curve DAO Token',
      decimals: 18,
    },
    '0x6dea81c8171d0ba574754ef6f8b412f2ed88c54d': { symbol: 'LQTY', name: 'Liquity', decimals: 18 },
  },
  bsc: {
    '0x55d398326f99059ff775485246999027b3197955': {
      symbol: 'USDT',
      name: 'Tether USD (BSC)',
      decimals: 18,
    },
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': {
      symbol: 'USDC',
      name: 'USD Coin (BSC)',
      decimals: 18,
    },
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': {
      symbol: 'BUSD',
      name: 'Binance USD',
      decimals: 18,
    },
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': {
      symbol: 'WBNB',
      name: 'Wrapped BNB',
      decimals: 18,
    },
    '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': {
      symbol: 'CAKE',
      name: 'PancakeSwap',
      decimals: 18,
    },
    '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe': {
      symbol: 'XRP',
      name: 'XRP Token',
      decimals: 18,
    },
    '0xba2ae424d960c26247dd6c32edc70b295c744c43': { symbol: 'DOGE', name: 'Dogecoin', decimals: 8 },
    '0x3ee2200efb3400fabb9aacf31297cbdd1d435d47': {
      symbol: 'ADA',
      name: 'Cardano Token',
      decimals: 18,
    },
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8': {
      symbol: 'ETH',
      name: 'Ethereum Token',
      decimals: 18,
    },
    '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': {
      symbol: 'BTCB',
      name: 'Bitcoin BEP2',
      decimals: 18,
    },
  },
  arbitrum: {
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
    },
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': {
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
    },
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': {
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
    },
    '0x912ce59144191c1204e64559fe8253a0e49e6548': { symbol: 'ARB', name: 'Arbitrum', decimals: 18 },
    '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a': { symbol: 'GMX', name: 'GMX', decimals: 18 },
  },
  base: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    '0x4200000000000000000000000000000000000006': {
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
    },
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': {
      symbol: 'cbETH',
      name: 'Coinbase Wrapped Staked ETH',
      decimals: 18,
    },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': {
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
    },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': {
      symbol: 'USDbC',
      name: 'USD Base Coin',
      decimals: 6,
    },
  },
  polygon: {
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
    },
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': {
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
    },
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': {
      symbol: 'WMATIC',
      name: 'Wrapped Matic',
      decimals: 18,
    },
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': {
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
    },
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': {
      symbol: 'WBTC',
      name: 'Wrapped Bitcoin',
      decimals: 8,
    },
  },
  optimism: {
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
    },
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': {
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
    },
    '0x4200000000000000000000000000000000000006': {
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
    },
    '0x4200000000000000000000000000000000000042': { symbol: 'OP', name: 'Optimism', decimals: 18 },
  },
  avalanche: {
    '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
    },
    '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7': {
      symbol: 'WAVAX',
      name: 'Wrapped AVAX',
      decimals: 18,
    },
    '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd': {
      symbol: 'JOE',
      name: 'Trader Joe',
      decimals: 18,
    },
  },
  gnosis: {
    '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d': {
      symbol: 'WXDAI',
      name: 'Wrapped XDAI',
      decimals: 18,
    },
    '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    '0x9c58bacc331c9aa871afd802db6379a98e80cedb': {
      symbol: 'GNO',
      name: 'Gnosis Token',
      decimals: 18,
    },
  },
  fantom: {
    '0x04068da6c83afcfa0e13ba15a6696662335d5b75': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    '0x049d68029688eabf473097a2fc38ef61633a3c7a': {
      symbol: 'fUSDT',
      name: 'Frapped USDT',
      decimals: 6,
    },
    '0x8d11ec38a3eb5e956b052f67da8bdc9bef8abf3e': {
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
    },
    '0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83': {
      symbol: 'WFTM',
      name: 'Wrapped Fantom',
      decimals: 18,
    },
  },
  linea: {
    '0x176211869ca2b568f2a7d4ee941e073a821ee1ff': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    '0xa219439258ca9da29e9cc4ce5596924745e12b93': {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
    },
    '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f': {
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
    },
  },
  celo: {
    '0xceba9300f2b948710d2653dd7b07f33a8b32118c': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    '0x617f3112bf5397d0467d315cc709ef968d9ba546': {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
    },
    '0x471ece3750da237f93b8e339c536989b8978a438': { symbol: 'CELO', name: 'Celo', decimals: 18 },
  },
};

/**
 * Resolve a token address to metadata.
 * Returns null for unknown tokens.
 */
export function resolveToken(chainId: string, address: string): TokenMeta | null {
  const chainTokens = REGISTRY[chainId];
  if (!chainTokens) return null;
  return chainTokens[address.toLowerCase()] ?? null;
}

/**
 * Resolve and return symbol string, or truncated address if unknown.
 */
export function resolveSymbol(chainId: string, address: string): string {
  return resolveToken(chainId, address)?.symbol ?? address.slice(0, 10) + '...';
}

// Export for use by other modules
export { REGISTRY };
